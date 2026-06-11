import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { bold, dim, error, green, red, yellow } from '../lib/output.js';
import { assertNodeSupport, installLoader } from '../local/loader.js';
import { compileRoutePattern, isRoutable } from '../local/router.js';
import {
  dispatchRequest,
  loadVendoredRuntime,
  prepareLocalProject,
} from '../local/runtime.js';

interface ExecOptions {
  project?: string;
  method: string;
  body?: string;
  header: string[];
  path?: string;
  query?: string;
}

export function registerExec(program: Command) {
  program
    .command('exec <file>')
    .description(
      'Run one function locally against your real project (sw.db/sw.fs/sw.ai hit the live platform) and print the response. ' +
        "Example: somewhere exec api/foo.ts --method POST --body '{\"id\":1}'",
    )
    .option('--project <id>', 'Override project ID')
    .option('-X, --method <method>', 'HTTP method', 'GET')
    .option('-d, --body <json>', 'Request body')
    .option('-H, --header <header...>', 'Request header ("Name: value"), repeatable', [])
    .option(
      '--path <urlPath>',
      'URL path for the synthetic request — required for parametric routes like api/sites/[id].ts',
    )
    .option('-q, --query <querystring>', 'Query string to append (a=1&b=2)')
    .action(async (file: string, opts: ExecOptions) => {
      try {
        assertNodeSupport();
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const cwd = process.cwd();
      let projectId = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project linked. Run `somewhere init` or pass --project <id>.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      // Accept api/foo.ts, functions/api/foo.ts, ./api/foo.ts, or an absolute path.
      const absPath = isAbsolute(file) ? file : resolve(cwd, file);
      if (!existsSync(absPath)) {
        error(`File not found: ${file}`);
        process.exit(1);
      }
      let routeKey = relative(cwd, absPath).split('\\').join('/');
      if (routeKey.startsWith('functions/')) routeKey = routeKey.slice('functions/'.length);
      if (!isRoutable(routeKey)) {
        error(
          `${routeKey} is not a routable function (must live under api/ or be a root [param] file). ` +
            '_lib/ files are import-only helpers.',
        );
        process.exit(1);
      }

      const { displayPath, pattern } = compileRoutePattern(routeKey);
      const isParametric = pattern.some((s) => s.type !== 'static');
      if (isParametric && !opts.path) {
        error(
          `${routeKey} has URL parameters (${displayPath}). Pass --path with a concrete URL, e.g. --path ${displayPath.replace(/:(\w+)/g, '123').replace(/\*(\w+)/g, 'a/b')}`,
        );
        process.exit(1);
      }
      const urlPath = opts.path ?? displayPath;
      const qs = opts.query ? (opts.query.startsWith('?') ? opts.query : `?${opts.query}`) : '';

      const token = getToken();
      const client = new ApiClient(token);

      try {
        installLoader(cwd);
        await loadVendoredRuntime();
        const state = await prepareLocalProject(client, token, projectId, cwd);

        const headers = new Headers();
        for (const h of opts.header) {
          const idx = h.indexOf(':');
          if (idx === -1) {
            error(`Malformed header (expected "Name: value"): ${h}`);
            process.exit(1);
          }
          headers.set(h.slice(0, idx).trim(), h.slice(idx + 1).trim());
        }
        const method = opts.method.toUpperCase();
        if (opts.body && !headers.has('content-type')) {
          headers.set('Content-Type', 'application/json');
        }

        const request = new Request(`http://localhost${urlPath}${qs}`, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : opts.body,
        });

        const t0 = Date.now();
        const result = await dispatchRequest(request, state);
        const ms = Date.now() - t0;

        const status = result.response.status;
        const color = status >= 500 ? red : status >= 400 ? yellow : green;
        console.log(`${bold(method)} ${urlPath}${qs} ${color(String(status))} ${dim(`${ms}ms`)}`);

        const text = await result.response.text();
        try {
          console.log(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          console.log(text);
        }
        if (result.error) {
          const err = result.error;
          console.error(red(err instanceof Error ? err.stack ?? err.message : String(err)));
        }
        process.exit(status >= 500 ? 1 : 0);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
