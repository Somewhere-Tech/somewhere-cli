import { Command } from 'commander';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { callPlatformTool, listPlatformTools } from '../lib/platform-tools.js';
import { loadProjectConfig } from '../lib/config.js';
import { dim, error, printJson } from '../lib/output.js';
import { isRecord } from '../lib/platform-command.js';
import type { ProjectConfig } from '../types.js';

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

function acceptsProjectId(tool: Tool | undefined): boolean {
  const properties = tool?.inputSchema?.properties;
  return isRecord(properties) && 'project_id' in properties;
}

export type CallScope =
  | { kind: 'explicit' }
  | { kind: 'linked'; args: Record<string, unknown>; note: string }
  | { kind: 'account'; reason: 'all-projects' | 'not-linked' | 'no-project-arg' };

/** Decide which project a generic tool call runs against (tsk_0a027a93).
 *  An explicit `project_id` always wins. In a linked directory, a tool that
 *  takes `project_id` runs against the linked project, as the first-class
 *  commands do; results spanning every project need `--all-projects`.
 *  `tool` is the catalog entry, looked up only when injection is possible. */
export function chooseCallScope(
  args: Record<string, unknown>,
  linked: ProjectConfig | null,
  allProjects: boolean,
  tool: Tool | undefined,
): CallScope {
  if ('project_id' in args) {
    if (allProjects) throw new Error('Pass "project_id" in the JSON or --all-projects, not both.');
    return { kind: 'explicit' };
  }
  if (allProjects) return { kind: 'account', reason: 'all-projects' };
  if (!linked?.project_id) return { kind: 'account', reason: 'not-linked' };
  if (!acceptsProjectId(tool)) return { kind: 'account', reason: 'no-project-arg' };
  const label = linked.subdomain || linked.name || linked.project_id;
  return {
    kind: 'linked',
    args: { ...args, project_id: linked.project_id },
    note: `Using the linked project ${label} (.somewhere.json). `
      + 'Pass "project_id" to choose another, or --all-projects for every project.',
  };
}

export function registerCall(program: Command): void {
  program
    .command('call [tool] [json]')
    .description('Invoke any platform tool by name with JSON arguments')
    .option('--list', 'List every available platform tool and its input schema')
    .option('--all-projects', 'In a linked directory, do not default project_id to the linked project')
    .option('--json', 'Print stable JSON output')
    .addHelpText('after', '\nIn a directory linked with .somewhere.json, a tool that takes project_id runs against the\n'
      + 'linked project unless the JSON names one. Use --all-projects for account-wide results.\n')
    .action(async (
      tool: string | undefined,
      jsonArgs: string | undefined,
      opts: { list?: boolean; json?: boolean; allProjects?: boolean },
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
        let args = parseArguments(jsonArgs);
        const linked = loadProjectConfig();
        const needsCatalog = !('project_id' in args) && !opts.allProjects && Boolean(linked?.project_id);
        const entry = needsCatalog
          ? (await listPlatformTools({ allTools: true })).find((candidate) => candidate.name === tool)
          : undefined;
        const scope = chooseCallScope(args, linked, opts.allProjects === true, entry);
        if (scope.kind === 'linked') {
          args = scope.args;
          console.error(dim(scope.note));
        }
        const value = await callPlatformTool(tool, args, { allTools: true });
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
        error(`${message}${next}`, err);
        process.exitCode = 1;
      }
    });
}
