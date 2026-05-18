import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import ora from 'ora';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, success, table, teal, warn } from '../lib/output.js';

const API_BASE = 'https://api.somewhere.tech/v1';

interface QueryResult {
  rows: Array<Record<string, unknown>>;
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

      const spinner = ora('Running query...').start();
      try {
        const r = await client.call<QueryResult>('POST', '/db/query', {
          project_id: projectId,
          sql,
        });
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }

        if (!r.rows || r.rows.length === 0) {
          if (typeof r.rows_affected === 'number') {
            success(`${r.rows_affected} row${r.rows_affected === 1 ? '' : 's'} affected${r.duration_ms != null ? dim(` (${r.duration_ms}ms)`) : ''}`);
          } else {
            warn('No rows returned.');
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
        spinner.fail('Query failed');
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
          info(dim(`${tables} tables, ${rows} rows`));
        }
        if (truncated) {
          warn(`Per-table row cap hit on: ${truncated} — contact support for a streaming dump if needed.`);
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
        const r = await client.call<{ tables: Array<{ name: string; row_count?: number }> }>(
          'GET',
          '/db/tables',
          undefined,
          { project_id: projectId },
        );
        if (!r.tables.length) {
          info(dim('No tables yet. Create one with `somewhere db query "CREATE TABLE …"`.'));
          return;
        }
        table(
          ['Table', 'Rows'],
          r.tables.map((t) => [teal(t.name), t.row_count != null ? String(t.row_count) : dim('?')]),
        );
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
