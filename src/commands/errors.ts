import { Command } from 'commander';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, red, table, teal, timeAgo, yellow } from '../lib/output.js';

interface ErrorRow {
  endpoint?: string | null;
  method?: string | null;
  status_code?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at: string;
}

export function registerErrors(program: Command) {
  program
    .command('errors [project]')
    .description(
      'Show the most recent exceptions for a project — the curated 24h error ' +
        'view (endpoint, status, error, time). The fastest way to see what is ' +
        'breaking in production without digging through raw logs.',
    )
    .option('--limit <n>', 'Max rows to show (default 20, max 100)', '20')
    .option('--json', 'Print the raw rows as JSON')
    .action(async (projectArg: string | undefined, opts) => {
      const client = new ApiClient(getToken());

      let projectId = projectArg;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project. Pass a project ID or run from a linked directory.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      const limit = Math.min(parseInt(String(opts.limit), 10) || 20, 100);

      let rows: ErrorRow[];
      try {
        const result = await client.call<{ errors: ErrorRow[] }>(
          'GET',
          '/errors/recent',
          undefined,
          { project_id: projectId, limit },
        );
        rows = result.errors ?? [];
      } catch (err) {
        if (err instanceof CliApiError) {
          error(`${err.message} ${dim(`[${err.code}${err.statusCode ? `, HTTP ${err.statusCode}` : ''}]`)}`);
        } else {
          error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (!rows.length) {
        console.log(dim('  No errors in the recent window. 🎉'));
        return;
      }

      const tableRows = rows.map((r) => {
        const status = r.status_code ?? 0;
        const statusStr = status >= 500 ? red(String(status)) : status >= 400 ? yellow(String(status)) : String(status || '—');
        const where = `${r.method ? `${r.method} ` : ''}${r.endpoint ?? '—'}`;
        const what = r.error_code && r.error_code !== 'FUNCTION_ERROR'
          ? `${r.error_code}: ${truncate(r.error_message)}`
          : truncate(r.error_message);
        return [statusStr, where, what, timeAgo(r.created_at)];
      });

      table(['Status', 'Endpoint', 'Error', 'When'], tableRows);
      console.log(dim(`\n  ${rows.length} error${rows.length === 1 ? '' : 's'} — ${teal('somewhere logs --level error')} for full detail.`));
    });
}

function truncate(s: string | null | undefined, max = 80): string {
  if (!s) return '—';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
