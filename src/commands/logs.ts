import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, printJsonLine, red, teal, yellow } from '../lib/output.js';

interface LogRow {
  id?: string;
  level: string;
  message: string;
  created_at: string;
  source?: string | null;
  data?: unknown;
}

export function registerLogs(program: Command) {
  program
    .command('logs [project]')
    .description('Show recent logs')
    .option('--level <level>', 'Filter by level (debug, info, warn, error)')
    .option('--source <source>', 'Filter by source (server, client, job, cron, queue, function, …)')
    .option('--function <route>', 'Filter to one function route path (e.g. /api/checkout)')
    .option('--endpoint <path>', 'Filter to one endpoint path (e.g. /api/checkout)')
    .option('--since <duration>', 'Only show logs since a duration or timestamp (e.g. 15m, 1h, 24h)')
    .option('--tail <n>', 'Number of lines', '20')
    .option('--follow', 'Keep polling for new logs')
    .option('--json', 'Print logs as newline-delimited JSON objects')
    .action(async (project: string | undefined, opts) => {
      const token = getToken();
      const client = new ApiClient(token);

      let projectId = project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project. Pass a project ID or run from a linked directory.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      if (opts.function && opts.endpoint && opts.function !== opts.endpoint) {
        error('--function and --endpoint cannot specify different paths.');
        process.exit(1);
      }

      const after = parseSinceOption(opts.since);
      const functionRoute = opts.function ?? opts.endpoint;
      const query: Record<string, string | number | undefined> = {
        project_id: projectId,
        limit: parseInt(String(opts.tail), 10) || 20,
        level: opts.level,
        source: opts.source,
        function: functionRoute,
        after,
      };

      try {
        const result = await client.call<{
          logs: LogRow[];
        }>('GET', '/logs', undefined, query);

        if (!result.logs?.length) {
          if (opts.json) return;
          console.log(dim('  No logs yet.'));
          return;
        }

        if (opts.json) {
          for (const log of result.logs) printJsonLine(log);
        } else {
          for (const log of result.logs.reverse()) {
            const time = new Date(log.created_at).toLocaleTimeString();
            const levelStr = formatLevel(log.level);
            console.log(`  ${dim(`[${levelStr}]`)}  ${dim(time)}  ${log.message}`);
          }
        }

        if (opts.follow) {
          if (!opts.json) console.log(dim('\n  Polling for new logs... (Ctrl+C to stop)\n'));
          let lastSeen = opts.json
            ? result.logs[0]?.created_at
            : result.logs[result.logs.length - 1]?.created_at;

          const poll = async () => {
            try {
              const fresh = await client.call<{
                logs: LogRow[];
              }>('GET', '/logs', undefined, {
                project_id: projectId,
                limit: 50,
                level: opts.level,
                source: opts.source,
                function: functionRoute,
                after: lastSeen,
              });
              const freshLogs = fresh.logs ?? [];
              if (opts.json) {
                for (const log of freshLogs) printJsonLine(log);
                if (freshLogs.length) lastSeen = freshLogs[0]?.created_at ?? lastSeen;
                return;
              }
              for (const log of freshLogs.reverse()) {
                const time = new Date(log.created_at).toLocaleTimeString();
                const levelStr = formatLevel(log.level);
                console.log(
                  `  ${dim(`[${levelStr}]`)}  ${dim(time)}  ${log.message}`,
                );
                lastSeen = log.created_at;
              }
            } catch {}
          };

          setInterval(poll, 3000);
          await new Promise(() => {}); // hang forever
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function parseSinceOption(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const duration = /^(\d+)(m|h|d)$/.exec(trimmed);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2];
    const unitMs =
      unit === 'm' ? 60_000 :
        unit === 'h' ? 3_600_000 :
          86_400_000;
    return new Date(Date.now() - amount * unitMs).toISOString();
  }

  const parsed = new Date(trimmed).getTime();
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();

  error('--since must be a duration like 15m, 1h, or 24h, or an ISO timestamp.');
  process.exit(1);
}

function formatLevel(level: string): string {
  switch (level) {
    case 'error':
      return red(level);
    case 'warn':
      return yellow(level);
    case 'info':
      return teal(level);
    default:
      return dim(level);
  }
}
