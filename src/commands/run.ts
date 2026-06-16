import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Command } from 'commander';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { bold, dim, error, red, teal } from '../lib/output.js';

interface RunResult {
  result: unknown;
  logs?: Array<{ level?: string; message?: string } | string>;
  duration_ms?: number;
  error?: { name?: string; message?: string; stack?: string } | string;
  truncated?: boolean;
  notice?: string;
  logs_truncated?: boolean;
}

/** The runner clamps to [1, 30000]; default 10000 (mirrors run_code). */
const MAX_TIMEOUT_MS = 30_000;

export function registerRun(program: Command) {
  program
    .command('run <script>')
    .description(
      "Run a one-off script once against your project's live dev bindings " +
        '(sw.db / sw.fs / sw.ai / sw.search …) without deploying, and print its ' +
        'return value + console logs. The script is an ES module: ' +
        'export default async function (sw) { ...; return value }. ' +
        "Example: somewhere run seed.js",
    )
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .option('--timeout <ms>', 'Abort the script after N ms (default 10000, max 30000)')
    .option('--include-env', 'Expose the project env vars as sw.env (off by default)')
    .option('--json', 'Print the raw { result, logs, duration_ms } envelope as JSON')
    .action(async (script: string, opts) => {
      const client = new ApiClient(getToken());

      let projectId = opts.project as string | undefined;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project. Pass --project <id> or run from a linked directory.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      const absPath = isAbsolute(script) ? script : resolve(process.cwd(), script);
      if (!existsSync(absPath)) {
        error(`File not found: ${script}`);
        process.exit(1);
      }
      const code = readFileSync(absPath, 'utf-8');
      if (!code.trim()) {
        error(`${script} is empty — nothing to run.`);
        process.exit(1);
      }

      let timeoutMs: number | undefined;
      if (opts.timeout !== undefined) {
        timeoutMs = parseInt(String(opts.timeout), 10);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          error('--timeout must be a positive number of milliseconds.');
          process.exit(1);
        }
        if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;
      }

      let r: RunResult;
      try {
        r = await client.callRunner<RunResult>(
          {
            project_id: projectId,
            code,
            timeout_ms: timeoutMs,
            include_env: opts.includeEnv === true,
          },
          // Give the network budget a little headroom over the runner's own
          // 30s script cap so a slow run reports its real error, not a timeout.
          { timeoutMs: MAX_TIMEOUT_MS + 30_000 },
        );
      } catch (err) {
        if (err instanceof CliApiError) {
          error(`${err.message} ${dim(`[${err.code}${err.statusCode ? `, HTTP ${err.statusCode}` : ''}]`)}`);
        } else {
          error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        process.exit(r.error ? 1 : 0);
      }

      // Logs first (chronological context for the result), then the result.
      const logs = r.logs ?? [];
      if (logs.length) {
        console.log(bold('Logs'));
        for (const entry of logs) {
          if (typeof entry === 'string') {
            console.log(`  ${dim(entry)}`);
          } else {
            const level = entry.level ? dim(`[${entry.level}] `) : '';
            console.log(`  ${level}${entry.message ?? ''}`);
          }
        }
        if (r.logs_truncated) console.log(`  ${dim('… logs truncated')}`);
        console.log('');
      }

      if (r.error) {
        const e = r.error;
        const msg = typeof e === 'string' ? e : `${e.name ? `${e.name}: ` : ''}${e.message ?? ''}`;
        error(red(`Script threw: ${msg}`));
        if (typeof e !== 'string' && e.stack) console.error(dim(e.stack));
        process.exit(1);
      }

      console.log(bold('Result'));
      try {
        console.log(JSON.stringify(r.result, null, 2));
      } catch {
        console.log(String(r.result));
      }
      if (r.truncated) console.log(dim(r.notice ?? 'Result truncated.'));
      if (r.duration_ms !== undefined) console.log(dim(`\n${teal('✓')} ran in ${r.duration_ms}ms`));
    });
}
