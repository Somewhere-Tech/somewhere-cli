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
  /** Did the code CHOOSE this outcome? A handler that answers 401 to a
   *  signed-out request is working; an uncaught throw is not. Older platform
   *  versions do not send this — an absent value is treated as an exception,
   *  which is what the view assumed about everything before. */
  kind?: 'exception' | 'refusal' | null;
  created_at: string;
}

/** A refusal the app chose, as opposed to something that broke. */
const isRefusal = (r: ErrorRow): boolean => r.kind === 'refusal';

export function registerErrors(program: Command) {
  program
    .command('errors [project]')
    .description(
      'Show what recently went wrong in a project — the curated 24h view ' +
        '(endpoint, status, error, time). The fastest way to see what is ' +
        'breaking in production without digging through raw logs. Rows are ' +
        'split into EXCEPTIONS (nobody chose it — an uncaught throw or a 5xx) ' +
        'and REFUSALS (your handler answered 4xx on purpose, e.g. a 401 from ' +
        'your own auth gate). Use --exceptions to see only what broke.',
    )
    .option('--limit <n>', 'Max rows to show (default 20, max 100)', '20')
    .option('--exceptions', 'Show only exceptions — hide the 4xx your own handlers returned on purpose.')
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

      const refusals = rows.filter(isRefusal).length;
      if (opts.exceptions) rows = rows.filter((r) => !isRefusal(r));

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (!rows.length) {
        // A window with nothing but refusals is a healthy window — say what is
        // actually there rather than reporting a bare zero.
        if (refusals && opts.exceptions) {
          console.log(dim(`  Nothing broke in the recent window. 🎉 (${refusals} request${refusals === 1 ? '' : 's'} your app refused on purpose — drop --exceptions to see them.)`));
          return;
        }
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
        // A 401 your own handler returned is your auth gate working. Calling it
        // an exception is what made this view fill with normal traffic on any
        // app with a login.
        const kind = isRefusal(r) ? dim('refused') : 'exception';
        return [kind, statusStr, where, what, timeAgo(r.created_at)];
      });

      table(['Kind', 'Status', 'Endpoint', 'Error', 'When'], tableRows);
      const exceptions = rows.length - rows.filter(isRefusal).length;
      const counts = opts.exceptions
        ? `${rows.length} exception${rows.length === 1 ? '' : 's'}`
        : `${exceptions} exception${exceptions === 1 ? '' : 's'}, ${refusals} refused on purpose`;
      console.log(dim(`\n  ${counts} — ${teal('somewhere logs --level error')} for full detail.`));
    });
}

function truncate(s: string | null | undefined, max = 80): string {
  if (!s) return '—';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
