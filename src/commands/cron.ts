import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import {
  compactRecord,
  isRecord,
  resolveProjectRef,
  truncateText,
  unwrapPlatformData,
} from '../lib/platform-command.js';
import { dim, error, printJson, success, table } from '../lib/output.js';

interface ProjectOptions {
  project?: string;
  json?: boolean;
}

interface CronCreateOptions extends ProjectOptions {
  name?: string;
  payload?: string;
  disabled?: boolean;
}

interface CronUpdateOptions {
  schedule?: string;
  handler?: string;
  name?: string;
  payload?: string;
  enable?: boolean;
  disable?: boolean;
  json?: boolean;
}

function parsePayload(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (err) {
    throw new Error(`Payload must be a JSON object. ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new Error('Payload must be a JSON object.');
  return parsed;
}

async function runCronTool(
  name: string,
  args: Record<string, unknown>,
  json: boolean | undefined,
  human: (value: unknown) => void,
): Promise<void> {
  try {
    const value = await callPlatformTool(name, args, { allTools: true });
    if (json) printJson(value);
    else human(value);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function cronRows(value: unknown): Record<string, unknown>[] {
  const data = unwrapPlatformData(value);
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.crons)
      ? data.crons
      : null;
  if (!rows) throw new Error('cron_list returned an unexpected response.');
  return rows.filter(isRecord);
}

function printCronMutation(verb: string, value: unknown): void {
  const data = unwrapPlatformData(value);
  const id = isRecord(data) && typeof data.id === 'string'
    ? data.id
    : isRecord(data) && typeof data.cron_id === 'string'
      ? data.cron_id
      : null;
  success(`${verb}${id ? ` ${id}` : ''}.`);
}

export function registerCron(program: Command): void {
  const cron = program
    .command('cron')
    .description('Manage scheduled triggers')
    .addHelpText(
      'after',
      '\nExample:\n  somewhere cron create "0 8 * * *" /api/daily-digest --project my-app\n',
    );

  cron
    .command('list')
    .alias('ls')
    .description('List scheduled triggers')
    .option('-p, --project <project>', 'Project slug or ID; omit to list across projects')
    .option('--json', 'Print the complete response as JSON')
    .action(async (opts: ProjectOptions) => {
      await runCronTool('cron_list', compactRecord([
        ['project_id', opts.project],
      ]), opts.json, (value) => {
        const rows = cronRows(value);
        if (rows.length === 0) {
          console.log(dim('No scheduled triggers.'));
          return;
        }
        table(['ID', 'Name', 'Schedule (UTC)', 'Handler', 'Enabled'], rows.map((row) => [
          typeof row.id === 'string' ? row.id : '—',
          truncateText(row.name, 32),
          typeof row.schedule === 'string' ? row.schedule : '—',
          truncateText(row.handler, 48),
          row.enabled === false ? 'no' : 'yes',
        ]));
      });
    });

  cron
    .command('create <schedule> <handler>')
    .description('Create a scheduled trigger (5-field UTC cron expression)')
    .requiredOption('-p, --project <project>', 'Project slug or ID')
    .option('--name <name>', 'Display name')
    .option('--payload <json>', 'JSON object sent to the handler')
    .option('--disabled', 'Create without firing on schedule')
    .option('--json', 'Print the complete response as JSON')
    .action(async (schedule: string, handler: string, opts: CronCreateOptions) => {
      try {
        const args = compactRecord([
          ['project_id', resolveProjectRef(opts.project)],
          ['schedule', schedule],
          ['handler', handler],
          ['name', opts.name],
          ['payload', parsePayload(opts.payload)],
          ['enabled', opts.disabled ? false : undefined],
        ]);
        await runCronTool('cron_create', args, opts.json, (value) => printCronMutation('Scheduled trigger created', value));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cron
    .command('update <cron-id>')
    .description('Update a scheduled trigger')
    .option('--schedule <expression>', 'New 5-field UTC cron expression')
    .option('--handler <path-or-url>', 'New project-relative /api path or https URL')
    .option('--name <name>', 'New display name')
    .option('--payload <json>', 'New JSON object sent to the handler')
    .option('--enable', 'Resume future runs')
    .option('--disable', 'Pause future runs')
    .option('--json', 'Print the complete response as JSON')
    .action(async (cronId: string, opts: CronUpdateOptions) => {
      try {
        if (opts.enable && opts.disable) throw new Error('Pass --enable or --disable, not both.');
        const args = compactRecord([
          ['cron_id', cronId],
          ['schedule', opts.schedule],
          ['handler', opts.handler],
          ['name', opts.name],
          ['payload', parsePayload(opts.payload)],
          ['enabled', opts.enable ? true : opts.disable ? false : undefined],
        ]);
        if (Object.keys(args).length === 1) {
          throw new Error('No update supplied. Pass a field such as --schedule, --handler, --enable, or --disable.');
        }
        await runCronTool('cron_update', args, opts.json, (value) => printCronMutation('Scheduled trigger updated', value));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cron
    .command('delete <cron-id>')
    .alias('rm')
    .description('Delete a scheduled trigger')
    .option('--json', 'Print the complete response as JSON')
    .action(async (cronId: string, opts: { json?: boolean }) => {
      await runCronTool('cron_delete', { cron_id: cronId }, opts.json, (value) => {
        printCronMutation('Scheduled trigger deleted', value);
      });
    });
}
