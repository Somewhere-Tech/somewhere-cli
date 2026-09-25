import { Command } from 'commander';
import { resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { isBuildError, renderBuildError, type BuildErrorDetail } from '../lib/build-errors.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { collectFiles, formatBytes, type CollectedFiles } from '../lib/files.js';
import { shellQuote } from '../lib/next-actions.js';
import { printExcludedFiles } from './deploy.js';
import { bold, dim, error, green, info, red, success, warn, yellow } from '../lib/output.js';

/** A single diagnostic from the server-side dry compile. Same file:line shape
 *  the /deploy BUILD_ERROR payload uses (so it renders through the same code
 *  frame), plus an optional `code` (e.g. TS2304 / esbuild). */
export type CheckErrorDetail = BuildErrorDetail & { code?: string; stack?: string | null };

/** POST /v1/deploy/check — the dry-compile verdict. A checker reports problems
 *  as DATA (ok:false + errors), so finding errors is a successful call, not an
 *  HTTP error. We also tolerate the server answering with a thrown BUILD_ERROR
 *  (same as /deploy) — see the action's catch. */
export interface CheckResult {
  ok?: boolean;
  errors?: CheckErrorDetail[];
  warnings?: string[];
  build_log?: string[];
}

/** POST /v1/deploy/check/run — compile-then-invoke. Carries `errors` when the
 *  compile failed before the handler could run; otherwise the handler's
 *  response and logs. */
export interface CheckRunResult extends CheckResult {
  response?: {
    status: number;
    headers: Record<string, string>;
    body: string;
    body_truncated?: boolean;
  } | null;
  logs?: Array<{ level?: string; message?: string } | string>;
  served?: 'function' | 'static';
  isolated_db?: boolean;
  duration_ms?: number;
  logs_truncated?: boolean;
}

interface CheckOptions {
  project?: string;
  run?: string;
  method?: string;
  body?: string;
  query?: string;
  json?: boolean;
}

export interface CheckRunRequest {
  path: string;
  method: string;
  body?: string;
}

/** The dry-compile body: the same collected source tree `somewhere deploy`
 *  uploads, so the server compiles exactly what would deploy. */
export function buildCheckBody(
  collected: CollectedFiles,
  projectId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { project_id: projectId, files: collected.files };
  if (Object.keys(collected.functions).length > 0) body.functions = collected.functions;
  if (Object.keys(collected.binaryFiles).length > 0) body.binary_files = collected.binaryFiles;
  return body;
}

/** The handler-check body accepted by POST /deploy/check/run. That worker
 * endpoint accepts inline function source and a top-level request spec; static
 * client files are outside this mode's contract. */
export function buildCheckRunBody(
  collected: CollectedFiles,
  projectId: string,
  request: CheckRunRequest,
): Record<string, unknown> {
  return { project_id: projectId, functions: collected.functions, ...request };
}

/** validateInvokeInput treats `path` as the complete URL path. Preserve the
 * caller's query string byte-for-byte by appending it there, rather than
 * sending an unsupported sibling `query` property. */
export function checkRunPath(path: string, query?: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (query === undefined || query === '') return normalizedPath;
  const normalizedQuery = query.startsWith('?') ? query.slice(1) : query;
  if (normalizedQuery === '') return normalizedPath;
  return `${normalizedPath}${normalizedPath.includes('?') ? '&' : '?'}${normalizedQuery}`;
}

/**
 * Map an errors-as-data check response to a synthetic BUILD_ERROR so it renders
 * through the exact same code-frame path as a /deploy failure (we have the
 * local source on disk → real frames). Returns null when the response is clean.
 */
export function checkErrorsToCliError(r: CheckResult | undefined): CliApiError | null {
  if (!r || r.ok !== false || !Array.isArray(r.errors) || r.errors.length === 0) return null;
  return new CliApiError(
    'BUILD_ERROR',
    `${r.errors.length} build error${r.errors.length === 1 ? '' : 's'} from the server-side compile`,
    422,
    { errors: r.errors, build_log: r.build_log },
  );
}

/** Format the --run handler response as lines (mirrors `somewhere run`). */
export function formatCheckRunResult(r: CheckRunResult): string[] {
  const lines: string[] = [];
  const logs = r.logs ?? [];
  if (logs.length) {
    lines.push(bold('Logs'));
    for (const entry of logs) {
      if (typeof entry === 'string') {
        lines.push(`  ${dim(entry)}`);
      } else {
        const level = entry.level ? dim(`[${entry.level}] `) : '';
        lines.push(`  ${level}${entry.message ?? ''}`);
      }
    }
    lines.push('');
  }

  for (const handlerError of r.errors ?? []) {
    const code = handlerError.code ? `${handlerError.code}: ` : '';
    lines.push(red(`Handler error: ${code}${handlerError.message ?? 'Unknown error'}`));
    if (handlerError.stack) lines.push(dim(handlerError.stack));
  }

  const response = r.response;
  if (!response) {
    if (r.duration_ms !== undefined) lines.push(dim(`${r.duration_ms}ms`));
    return lines;
  }

  const status = response.status;
  const color = status >= 500 ? red : status >= 400 ? yellow : green;
  lines.push(`${color(String(status || '—'))} ${dim(r.duration_ms !== undefined ? `${r.duration_ms}ms` : '')}`.trimEnd());
  lines.push(response.body);
  if (response.body_truncated) lines.push(dim('Response body truncated.'));
  return lines;
}

/** One verdict for both terminal and --json modes. An explicit handler check
 * passes only when handler preparation and invocation completed with an HTTP response
 * below 400 and no captured handler error. */
export function checkRunExitCode(r: CheckRunResult): number {
  if (r.ok === false) return 1;
  if ((r.errors?.length ?? 0) > 0) return 1;
  if (!r.response) return 1;
  return r.response.status >= 400 ? 1 : 0;
}

/** Human success copy for the compile-only path. Keep the scope explicit: a
 * clean compile says nothing about requests or user journeys. */
export function formatCompileOnlySuccess(totalFiles: number, totalBytes: number, projectId: string): string[] {
  return [
    `Platform compile passed. ${dim(`(${totalFiles} files, ${formatBytes(totalBytes)})`)}`,
    dim('Runtime behavior, auth, data access, and user flows were not exercised.'),
    `Next: deploy, then verify the real flow with \`somewhere verify --project ${shellQuote(projectId)} --flow flow.json\`.`,
    dim('Unsure about a platform contract? Run `somewhere advisor "<question>"`.'),
  ];
}

export function registerCheck(program: Command) {
  program
    .command('deploy-check [dir]')
    .description(
      'Upload the current source and dry-compile it with the platform compiler ' +
        '(no deploy, promote, or runtime request). Prints structured file:line errors. ' +
        'This checks platform compilation and source intake; it does not exercise functions, ' +
        'auth, data access, or browser flows. With --run <path>, it instead invokes one ' +
        'handler from the collected function source; static/client files are not checked in that mode. ' +
        'Distinct from the local `somewhere typecheck`: ' +
        '`deploy-check` catches platform-only compile issues such as cross-import resolution, ' +
        'bundling, and bundled-deploy rejects.',
    )
    .option('--project <ref>', 'Project to check against (defaults to the linked project).')
    .option(
      '--run <path>',
      'Check one handler from collected function source (default GET). Handler code runs against isolated dev bindings and can write data or call services. Static/client files are not checked. Exits nonzero for handler preparation errors, handler errors, and HTTP 4xx/5xx.',
    )
    .option('-X, --method <method>', 'HTTP method for --run (default GET).')
    .option('-d, --body <json>', 'Request body for --run.')
    .option('-q, --query <querystring>', 'Query string for --run (a=1&b=2).')
    .option('--json', 'Print the raw check response envelope as JSON.')
    .action(async (dirArg: string | undefined, opts: CheckOptions) => {
      const targetDir = resolve(process.cwd(), dirArg ?? '.');

      let projectId = opts.project;
      if (!projectId) {
        const config = loadProjectConfig(targetDir) ?? loadProjectConfig();
        if (!config) {
          error('No project linked. Run `somewhere init` or pass --project <ref>.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      const client = new ApiClient(getToken());
      const collected = collectFiles(targetDir);
      // Same publish surface the deploy uses — `deploy-check` saying "0 errors"
      // while a private note was about to ship is what made this a real
      // incident, so the check names the held-back files too (tsk_c166924f).
      if (collected.excluded.length && !opts.json) {
        printExcludedFiles(collected.excluded, targetDir);
      }
      const totalFiles =
        Object.keys(collected.files).length +
        Object.keys(collected.functions).length +
        Object.keys(collected.binaryFiles).length;

      const isRun = opts.run !== undefined;
      const spinner = opts.json
        ? null
        : ora(
          isRun
            ? `Checking handler ${opts.run} (server-side)...`
            : `Dry-compiling ${totalFiles} files on the platform...`,
        ).start();

      try {
        if (isRun) {
          const request: CheckRunRequest = {
            path: checkRunPath(opts.run!, opts.query),
            method: (opts.method ?? 'GET').toUpperCase(),
          };
          if (opts.body !== undefined) request.body = opts.body;

          const r = await client.call<CheckRunResult>(
            'POST',
            '/deploy/check/run',
            buildCheckRunBody(collected, projectId, request),
            undefined,
            { timeoutMs: LONG_CALL_TIMEOUT_MS },
          );
          spinner?.stop();
          const exitCode = checkRunExitCode(r);

          if (opts.json) {
            console.log(JSON.stringify(r, null, 2));
            process.exit(exitCode);
          }

          // Compile failed before the handler ran — render the build errors.
          const compileErr = checkErrorsToCliError(r);
          if (compileErr) {
            renderBuildError(compileErr, targetDir);
            process.exit(1);
          }

          console.log(`${bold(request.method)} ${request.path}`);
          for (const line of formatCheckRunResult(r)) console.log(line);
          process.exit(exitCode);
        }

        const r = await client.call<CheckResult>(
          'POST',
          '/deploy/check',
          buildCheckBody(collected, projectId),
          undefined,
          { timeoutMs: LONG_CALL_TIMEOUT_MS },
        );
        spinner?.stop();

        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          process.exit(r.ok === false ? 1 : 0);
        }

        const compileErr = checkErrorsToCliError(r);
        if (compileErr) {
          renderBuildError(compileErr, targetDir);
          process.exit(1);
        }

        // Clean. Pass through any advisory warnings + the build log.
        if (r.warnings && r.warnings.length > 0) {
          for (const w of r.warnings) warn(w);
        }
        if (Array.isArray(r.build_log) && r.build_log.length > 0) {
          console.log(`\n${dim('Build')}`);
          for (const line of r.build_log) info(dim(line));
          console.log('');
        }
        const [summary, ...nextSteps] = formatCompileOnlySuccess(totalFiles, sourceBytes(collected), projectId);
        success(summary);
        for (const line of nextSteps) info(line);
      } catch (err) {
        spinner?.fail(isRun ? 'Check run failed' : 'Check failed');
        // The server may answer a compile failure with a thrown BUILD_ERROR
        // (same payload as /deploy) instead of errors-as-data — render it the
        // same way, with a local code frame.
        if (!opts.json && isBuildError(err) && renderBuildError(err, targetDir)) {
          process.exit(1);
        }
        if (err instanceof CliApiError) {
          error(
            `${err.message} ${dim(err.statusCode ? `[${err.code}, HTTP ${err.statusCode}]` : `[${err.code}]`)}`,
          );
        } else {
          error(err instanceof Error ? err.message : String(err), err);
        }
        process.exit(1);
      }
    });
}

function sourceBytes(c: CollectedFiles): number {
  const text = Object.values(c.files)
    .concat(Object.values(c.functions))
    .reduce((sum, s) => sum + s.length, 0);
  const binary = Object.values(c.binaryFiles).reduce(
    (sum, b64) => sum + Math.floor((b64.length * 3) / 4),
    0,
  );
  return text + binary;
}
