import { Command } from 'commander';
import { callPlatformTool, listPlatformTools } from '../lib/platform-tools.js';
import { error, printJson } from '../lib/output.js';
import { isRecord } from '../lib/platform-command.js';

function parseArguments(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (err) {
    throw new Error(`Arguments must be valid JSON. ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('Arguments must be a JSON object, for example: \'{"project_id":"default"}\'.');
  }
  return parsed;
}

export function registerCall(program: Command): void {
  program
    .command('call [tool] [json]')
    .description('Invoke any platform tool by name with JSON arguments')
    .option('--list', 'List every available platform tool and its input schema')
    .option('--json', 'Print stable JSON output')
    .action(async (
      tool: string | undefined,
      jsonArgs: string | undefined,
      opts: { list?: boolean; json?: boolean },
    ) => {
      try {
        if (opts.list) {
          if (tool || jsonArgs) throw new Error('Do not pass a tool name with --list.');
          const tools = await listPlatformTools({ allTools: true });
          if (opts.json) {
            printJson({ tools, count: tools.length });
            return;
          }
          for (const entry of tools) {
            const summary = entry.description?.split('\n')[0] ?? '';
            process.stdout.write(`${entry.name}\t${summary}\n`);
          }
          return;
        }

        if (!tool) {
          throw new Error('Missing tool name. Run `somewhere call --list` to discover tools.');
        }
        const value = await callPlatformTool(tool, parseArguments(jsonArgs), { allTools: true });
        if (opts.json || typeof value !== 'string') {
          printJson(value);
        } else {
          process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const next = /unknown tool|not found/i.test(message)
          ? ' Run `somewhere call --list` to see exact tool names.'
          : '';
        error(`${message}${next}`);
        process.exitCode = 1;
      }
    });
}
