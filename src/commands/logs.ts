import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, red, teal, yellow } from '../lib/output.js';

export function registerLogs(program: Command) {
  program
    .command('logs [project]')
    .description('Show recent logs')
    .option('--level <level>', 'Filter by level (debug, info, warn, error)')
    .option('--source <source>', 'Filter by source (server, client, job, cron, queue, function, …)')
    .option('--function <route>', 'Filter to one function route (e.g. /api/checkout)')
    .option('--tail <n>', 'Number of lines', '20')
    .option('--follow', 'Keep polling for new logs')
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

      const query: Record<string, string | number | undefined> = {
        project_id: projectId,
        limit: parseInt(String(opts.tail), 10) || 20,
        level: opts.level,
        // `source` is filtered server-side today. `function` is forwarded
        // forward-compatibly: GET /logs does not yet filter by a specific
        // function route (only by `source`), so the worker ignores it until a
        // matching filter ships.
        source: opts.source,
        function: opts.function,
      };

      try {
        const result = await client.call<{
          logs: Array<{
            level: string;
            message: string;
            created_at: string;
            source?: string;
          }>;
        }>('GET', '/logs', undefined, query);

        if (!result.logs?.length) {
          console.log(dim('  No logs yet.'));
          return;
        }

        for (const log of result.logs.reverse()) {
          const time = new Date(log.created_at).toLocaleTimeString();
          const levelStr = formatLevel(log.level);
          console.log(`  ${dim(`[${levelStr}]`)}  ${dim(time)}  ${log.message}`);
        }

        if (opts.follow) {
          console.log(dim('\n  Polling for new logs... (Ctrl+C to stop)\n'));
          let lastSeen = result.logs[result.logs.length - 1]?.created_at;

          const poll = async () => {
            try {
              const fresh = await client.call<{
                logs: Array<{
                  level: string;
                  message: string;
                  created_at: string;
                }>;
              }>('GET', '/logs', undefined, {
                project_id: projectId,
                limit: 50,
                level: opts.level,
                source: opts.source,
                function: opts.function,
                after: lastSeen,
              });
              for (const log of (fresh.logs ?? []).reverse()) {
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
