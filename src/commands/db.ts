import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import ora from '../lib/spinner.js';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, printJson, success, table, teal, yellow } from '../lib/output.js';

// Fields consumed by the human-readable adapter. --json preserves the complete
// canonical response, including count/last_row_id and transport metadata.
interface QueryResult {
  data: Array<Record<string, unknown>>;
  changes: number;
  duration_ms?: number;
}

interface ApplySchemaResult {
  applied?: boolean;
  no_op?: boolean;
  report_lines?: unknown;
  reportLines?: unknown;
}

function schemaReportLines(result: ApplySchemaResult): string[] {
  const candidate = Array.isArray(result.report_lines)
    ? result.report_lines
    : Array.isArray(result.reportLines)
      ? result.reportLines
      : [];
  return candidate.filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
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

        if (!r || !Array.isArray(r.data) || typeof r.changes !== 'number') {
          throw new Error('Invalid database query response: expected canonical data and changes.');
        }
        if (r.data.length === 0) {
          const affected = r.changes;
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

        const headers = Object.keys(r.data[0]);
        const stringify = (v: unknown): string => {
          if (v === null || v === undefined) return dim('null');
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        };
        const tableRows = r.data.map((row) => headers.map((h) => stringify(row[h])));
        table(headers, tableRows);
        console.log('');
        info(dim(`${r.data.length} row${r.data.length === 1 ? '' : 's'}${r.duration_ms != null ? ` · ${r.duration_ms}ms` : ''}`));
      } catch (err) {
        spinner?.fail('Query failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  db
    .command('apply-schema [path]')
    .description('Apply db/schema.ts to the project database without publishing the app')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('--json', 'Print the raw apply result')
    .action(async (
      schemaPath: string | undefined,
      opts: { project?: string; json?: boolean },
    ) => {
      let projectId: string | undefined = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass --project <id>.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      const requestedPath = schemaPath ?? 'db/schema.ts';
      const absolutePath = resolve(process.cwd(), requestedPath);
      let schemaModule: string;
      try {
        schemaModule = readFileSync(absolutePath, 'utf8');
      } catch {
        error(`Could not read ${requestedPath}. Pass the path to your managed schema file.`);
        process.exit(1);
      }

      const client = new ApiClient(getToken());
      const spinner = opts.json ? null : ora('Applying database schema…').start();
      try {
        const result = await client.call<ApplySchemaResult>('POST', '/db/schema/apply', {
          project_id: projectId,
          schema_source: schemaModule,
          target: 'production',
        });
        spinner?.stop();
        if (opts.json) {
          printJson(result);
          return;
        }

        if (result.applied === false || result.no_op === true) {
          success('Database schema already matches — nothing changed.');
        } else {
          success('Database schema applied.');
        }
        for (const line of schemaReportLines(result)) info(dim(line));
      } catch (err) {
        spinner?.fail('Database schema was not applied');
        if (err instanceof Error) {
          error(err.message);
        } else {
          error(String(err));
        }
        process.exit(1);
      }
    });

  db
    .command('dump')
    .description('Export the full database as SQL (schema + every row). Pipe to a file: somewhere db dump > backup.sql')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('-o, --output <file>', 'Write to file instead of stdout')
    .option('--json', 'Print the dump response as JSON')
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

      const client = new ApiClient(getToken());
      const spinner = opts.json ? null : ora('Dumping database…').start();
      try {
        const res = await client.callRaw('POST', '/db/dump', { project_id: projectId });

        if (!res.ok) {
          spinner?.fail('Dump failed');
          try {
            const json = JSON.parse(res.body) as { error?: string; message?: string };
            error(`${json.error ?? 'ERROR'}: ${json.message ?? res.body.slice(0, 200)}`);
          } catch {
            error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
          }
          process.exit(1);
        }

        const sql = res.body;
        const tables = res.headers['x-tables'] ?? '?';
        const rows = res.headers['x-rows'] ?? '?';
        const truncated = res.headers['x-truncated-tables'];
        const dumpResult = {
          sql,
          tables,
          rows,
          truncated_tables: truncated ?? null,
        };

        if (opts.output) {
          writeFileSync(opts.output, sql);
          if (opts.json) {
            printJson(dumpResult);
          } else {
            spinner?.succeed(`Wrote ${opts.output} (${tables} tables, ${rows} rows)`);
          }
        } else {
          spinner?.stop();
          if (opts.json) {
            printJson(dumpResult);
          } else {
            process.stdout.write(sql);
            // Summary to STDERR — stdout must stay pure SQL for `db dump > backup.sql`.
            process.stderr.write(dim(`${tables} tables, ${rows} rows`) + '\n');
          }
        }
        if (truncated && !opts.json) {
          // stderr for the same reason (applies to the piped-dump path).
          process.stderr.write(
            yellow(`⚠ Per-table row cap hit on: ${truncated} — contact support for a streaming dump if needed.`) + '\n',
          );
        }
      } catch (err) {
        spinner?.fail('Dump failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  db
    .command('tables')
    .description('List tables in the project database')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('--json', 'Print the raw tables response as JSON')
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
        if (opts.json) {
          printJson(r);
          return;
        }
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
