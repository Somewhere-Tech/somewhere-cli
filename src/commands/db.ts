import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import ora from '../lib/spinner.js';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, success, table, teal, warn, yellow } from '../lib/output.js';

const API_BASE = 'https://api.somewhere.tech/v1';

interface QueryResult {
  rows: Array<Record<string, unknown>>;
  // Rows affected by a write — the API sends `changes` (canonicalQueryShape);
  // `rows_affected` never existed on the wire and is kept only as a legacy
  // fallback (tsk_abea03ab: the dead-field check made every write/DDL print
  // an ambiguous "No rows returned.").
  changes?: number;
  rows_affected?: number;
  duration_ms?: number;
}

export function registerDb(program: Command) {
  const db = program.command('db').description('Run SQL against your project\'s database');

  db
    .command('query <sql>')
    .description('Run a SQL query against the project database')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('--json', 'Print raw JSON instead of a table')
    .action(async (sql: string, opts) => {
      const client = new ApiClient(getToken());

      let projectId: string | undefined = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass --project <id>.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      // --json must emit ONLY the JSON envelope on stdout — no spinner noise
      // (the "Running query..." line broke scripting; audit #6). Skip the
      // spinner entirely in --json mode rather than relying on the stream.
      const spinner = opts.json ? null : ora('Running query...').start();
      try {
        const r = await client.call<QueryResult>('POST', '/db/query', {
          project_id: projectId,
          sql,
        });
        spinner?.stop();

        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }

        if (!r.rows || r.rows.length === 0) {
          const affected = typeof r.changes === 'number' ? r.changes : r.rows_affected;
          if (typeof affected === 'number' && affected > 0) {
            success(`${affected} row${affected === 1 ? '' : 's'} affected${r.duration_ms != null ? dim(` (${r.duration_ms}ms)`) : ''}`);
          } else {
            // Explicit SUCCESS, not a warning — an agent seeing "No rows
            // returned." after CREATE/INSERT couldn't tell success from a
            // silent failure (tsk_abea03ab). Failures error loudly above.
            success('OK — no rows returned (normal for DDL and zero-row writes; failures error loudly).');
          }
          return;
        }

        const headers = Object.keys(r.rows[0]);
        const stringify = (v: unknown): string => {
          if (v === null || v === undefined) return dim('null');
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        };
        const tableRows = r.rows.map((row) => headers.map((h) => stringify(row[h])));
        table(headers, tableRows);
        console.log('');
        info(dim(`${r.rows.length} row${r.rows.length === 1 ? '' : 's'}${r.duration_ms != null ? ` · ${r.duration_ms}ms` : ''}`));
      } catch (err) {
        spinner?.fail('Query failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  db
    .command('dump')
    .description('Export the full database as SQL (schema + every row). Pipe to a file: somewhere db dump > backup.sql')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('-o, --output <file>', 'Write to file instead of stdout')
    .action(async (opts) => {
      let projectId: string | undefined = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass --project <id>.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      // Bypass ApiClient — the response is application/sql, not JSON.
      const spinner = ora('Dumping database…').start();
      try {
        const res = await fetch(`${API_BASE}/db/dump`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${getToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ project_id: projectId }),
        });

        if (!res.ok) {
          spinner.fail('Dump failed');
          const body = await res.text();
          try {
            const json = JSON.parse(body) as { error?: string; message?: string };
            error(`${json.error ?? 'ERROR'}: ${json.message ?? body.slice(0, 200)}`);
          } catch {
            error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
          }
          process.exit(1);
        }

        const sql = await res.text();
        const tables = res.headers.get('X-Tables') ?? '?';
        const rows = res.headers.get('X-Rows') ?? '?';
        const truncated = res.headers.get('X-Truncated-Tables');

        if (opts.output) {
          writeFileSync(opts.output, sql);
          spinner.succeed(`Wrote ${opts.output} (${tables} tables, ${rows} rows)`);
        } else {
          spinner.stop();
          process.stdout.write(sql);
          // Summary to STDERR — stdout must stay pure SQL for `db dump > backup.sql`.
          process.stderr.write(dim(`${tables} tables, ${rows} rows`) + '\n');
        }
        if (truncated) {
          // stderr for the same reason (applies to the piped-dump path).
          process.stderr.write(
            yellow(`⚠ Per-table row cap hit on: ${truncated} — contact support for a streaming dump if needed.`) + '\n',
          );
        }
      } catch (err) {
        spinner.fail('Dump failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  db
    .command('tables')
    .description('List tables in the project database')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .action(async (opts) => {
      const client = new ApiClient(getToken());

      let projectId: string | undefined = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass --project <id>.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      try {
        const r = await client.call<{ tables: Array<string | { name: string; row_count?: number }> }>(
          'GET',
          '/db/tables',
          undefined,
          { project_id: projectId },
        );
        // The API returns tables as an array of NAME STRINGS. (The old CLI read
        // them as { name, row_count } objects, so every name came back empty and
        // every row count printed "?" — audit #5.) Normalize defensively so a
        // future object shape still works.
        const rows = (r.tables ?? []).map((t) => (typeof t === 'string' ? { name: t } : t));
        if (!rows.length) {
          info(dim('No tables yet. Create one with `somewhere db query "CREATE TABLE …"`.'));
          return;
        }
        table(
          ['Table', 'Rows'],
          rows.map((t) => [teal(t.name), t.row_count != null ? String(t.row_count) : dim('—')]),
        );
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
