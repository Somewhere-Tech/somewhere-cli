import { Command } from 'commander';
import { resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { isBuildError, renderBuildError, type BuildErrorDetail } from '../lib/build-errors.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { collectFiles, formatBytes, type CollectedFiles } from '../lib/files.js';
import { printExcludedFiles } from './deploy.js';
import { bold, dim, error, green, info, red, success, warn, yellow } from '../lib/output.js';

/** A single diagnostic from the server-side dry compile. Same file:line shape
 *  the /deploy BUILD_ERROR payload uses (so it renders through the same code
 *  frame), plus an optional `code` (e.g. TS2304 / esbuild). */
export type CheckErrorDetail = BuildErrorDetail & { code?: string };

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
 *  response (mirrors `somewhere run` / `exec`). */
export interface CheckRunResult extends CheckResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  logs?: Array<{ level?: string; message?: string } | string>;
  error?: { name?: string; message?: string; stack?: string } | string;
  duration_ms?: number;
}

interface CheckOptions {
  project?: string;
  run?: string;
  method?: string;
  body?: string;
  query?: string;
  json?: boolean;
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

/** The compile-then-run body: the dry-compile tree plus the synthetic request
 *  to drive one handler against. */
export function buildCheckRunBody(
  collected: CollectedFiles,
  projectId: string,
  target: Record<string, unknown>,
): Record<string, unknown> {
  return { ...buildCheckBody(collected, projectId), target };
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

  if (r.error) {
    const e = r.error;
    const msg = typeof e === 'string' ? e : `${e.name ? `${e.name}: ` : ''}${e.message ?? ''}`;
    lines.push(red(`Handler threw: ${msg}`));
    if (typeof e !== 'string' && e.stack) lines.push(dim(e.stack));
    return lines;
  }

  const status = r.status ?? 0;
  const color = status >= 500 ? red : status >= 400 ? yellow : green;
  lines.push(`${color(String(status || '—'))} ${dim(r.duration_ms !== undefined ? `${r.duration_ms}ms` : '')}`.trimEnd());
  try {
    lines.push(JSON.stringify(r.body, null, 2));
  } catch {
    lines.push(String(r.body));
  }
  return lines;
}

export function registerCheck(program: Command) {
  program
    .command('deploy-check [dir]')
    .description(
      'SERVER-SIDE pre-deploy oracle: upload the current source and have the REAL platform ' +
        'compiler dry-compile it (no deploy, no promote, nothing goes live) — the truest ' +
        '"will this deploy succeed?" gate. Prints structured file:line errors. ' +
        'With --run <path> it compiles AND invokes one handler against inputs. ' +
        'Distinct from the LOCAL checks: `somewhere typecheck` runs `tsc --noEmit` on a pulled ' +
        'tree on your machine. `deploy-check` runs the actual server-side compiler that `deploy` uses, so it ' +
        'catches what only the platform catches (cross-import resolution, bundling, bundled-deploy ' +
        'rejects). (Unrelated to `somewhere check`, which is the swpx npm-package verdict.)',
    )
    .option('--project <ref>', 'Project to check against (defaults to the linked project).')
    .option(
      '--run <path>',
      'Compile, then invoke the handler at this URL path against inputs (e.g. --run /api/hello).',
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
            ? `Compiling ${totalFiles} files + running ${opts.run} (server-side)...`
            : `Dry-compiling ${totalFiles} files on the platform...`,
        ).start();

      try {
        if (isRun) {
          const target: Record<string, unknown> = {
            path: opts.run!.startsWith('/') ? opts.run : `/${opts.run}`,
            method: (opts.method ?? 'GET').toUpperCase(),
          };
          if (opts.body !== undefined) target.body = opts.body;
          if (opts.query !== undefined) target.query = opts.query;

          const r = await client.call<CheckRunResult>(
            'POST',
            '/deploy/check/run',
            buildCheckRunBody(collected, projectId, target),
            undefined,
            { timeoutMs: LONG_CALL_TIMEOUT_MS },
          );
          spinner?.stop();

          if (opts.json) {
            console.log(JSON.stringify(r, null, 2));
            process.exit(r.ok === false || r.error ? 1 : 0);
          }

          // Compile failed before the handler ran — render the build errors.
          const compileErr = checkErrorsToCliError(r);
          if (compileErr) {
            renderBuildError(compileErr, targetDir);
            process.exit(1);
          }

          console.log(`${bold(opts.method?.toUpperCase() ?? 'GET')} ${target.path}`);
          for (const line of formatCheckRunResult(r)) console.log(line);
          process.exit(r.error || (r.status ?? 0) >= 500 ? 1 : 0);
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
        success(
          `Server-side check clean (real platform compiler) — safe to deploy. ${dim(`(${totalFiles} files, ${formatBytes(sourceBytes(collected))})`)}`,
        );
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
          error(err instanceof Error ? err.message : String(err));
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
