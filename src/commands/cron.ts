import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import {
  compactRecord,
  isRecord,
  resolveProjectRef,
  truncateText,
  unwrapPlatformData,
} from '../lib/platform-command.js';
import { dim, error, printJson, printJsonError, success, table } from '../lib/output.js';

interface ProjectOptions {
  project?: string;
  json?: boolean;
}

interface CronCreateOptions extends ProjectOptions {
  name?: string;
  payload?: string;
  disabled?: boolean;
  timezone?: string;
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

interface CronRow extends Record<string, unknown> {
  cron_id?: string;
  id?: string;
  name?: string;
}

interface CronRunResult extends Record<string, unknown> {
  cron_id: string;
  job_id: string;
  status: string;
  trigger: string;
}

const CRON_RUN_UNAVAILABLE = 'Cron run is not available on this platform version yet.';

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

function cronRows(value: unknown): CronRow[] {
  const data = unwrapPlatformData(value);
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.crons)
      ? data.crons
      : null;
  if (!rows) throw new Error('cron_list returned an unexpected response.');
  return rows.filter(isRecord);
}

function cronRowId(row: CronRow): string | null {
  if (typeof row.cron_id === 'string' && row.cron_id.length > 0) return row.cron_id;
  if (typeof row.id === 'string' && row.id.length > 0) return row.id;
  return null;
}

function cronRunResult(value: unknown): CronRunResult {
  const data = unwrapPlatformData(value);
  if (!isRecord(data)
      || typeof data.cron_id !== 'string'
      || typeof data.job_id !== 'string'
      || typeof data.status !== 'string'
      || typeof data.trigger !== 'string') {
    throw new Error('cron_run returned an unexpected response.');
  }
  return data as CronRunResult;
}

function platformErrorParts(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^([A-Z][A-Z0-9_]+):\s*(.+)$/s.exec(message);
  return match ? { code: match[1], message: match[2] } : { code: 'CLI_ERROR', message };
}

function cronRunUnavailable(err: unknown): boolean {
  const { code, message } = platformErrorParts(err);
  if (/unknown tool\s+["']?cron_run/i.test(message)) return true;
  if (code === 'FORBIDDEN') return true;
  return code === 'NOT_FOUND' && !/^Scheduled task not found\.?$/i.test(message.trim());
}

function printTypedCronError(code: string, message: string, json: boolean | undefined): void {
  if (json) printJsonError(code, message);
  else error(`${code}: ${message}`);
  process.exitCode = 1;
}

async function resolveCronRunId(target: string, project: string | undefined): Promise<string> {
  if (target.startsWith('cron_')) return target;
  const rows = cronRows(await callPlatformTool('cron_list', compactRecord([
    ['project_id', project],
  ]), { allTools: true }));
  const matches = rows.filter((row) => row.name === target);
  if (matches.length === 0) {
    throw new Error(`CRON_NOT_FOUND: No scheduled task named "${target}" was found${project ? ` in project "${project}"` : ''}.`);
  }
  if (matches.length > 1) {
    throw new Error(`CRON_NAME_AMBIGUOUS: More than one scheduled task is named "${target}". Pass --project or use a cron ID.`);
  }
  const id = cronRowId(matches[0]);
  if (!id) throw new Error('cron_list returned a scheduled task without a cron_id.');
  return id;
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
      '\nExamples:\n  somewhere cron create "0 8 * * *" /api/daily-digest --project my-app\n'
        + '  somewhere cron create "0 9 * * *" /api/daily-digest --project my-app --timezone America/Los_Angeles\n'
        + '\nSchedules are read in UTC unless --timezone names an IANA zone.\n',
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
          cronRowId(row) ?? '—',
          truncateText(row.name, 32),
          typeof row.schedule === 'string' ? row.schedule : '—',
          truncateText(row.handler, 48),
          row.enabled === false ? 'no' : 'yes',
        ]));
      });
    });

  cron
    .command('run <cron-id-or-name>')
    .description('Run a scheduled task once now without changing its schedule')
    .option('-p, --project <project>', 'Project slug or ID; used to resolve a task name')
    .option('--json', 'Print the complete response as JSON')
    .action(async (target: string, opts: ProjectOptions) => {
      try {
        const cronId = await resolveCronRunId(target, opts.project);
        const value = await callPlatformTool('cron_run', { cron_id: cronId }, { allTools: true });
        if (opts.json) {
          printJson(value);
          return;
        }
        const result = cronRunResult(value);
        success('Scheduled task ran once, see history.');
        console.log(dim(`Cron ${result.cron_id}  Job ${result.job_id}  ${result.status}  trigger: ${result.trigger}`));
      } catch (err) {
        if (cronRunUnavailable(err)) {
          printTypedCronError('CRON_RUN_NOT_AVAILABLE', CRON_RUN_UNAVAILABLE, opts.json);
          return;
        }
        const { code, message } = platformErrorParts(err);
        printTypedCronError(code, message, opts.json);
      }
    });

  cron
    .command('create <schedule> <handler>')
    .description('Create a scheduled trigger (5-field cron expression, read in UTC unless --timezone says otherwise)')
    .requiredOption('-p, --project <project>', 'Project slug or ID')
    .option(
      '--timezone <iana>',
      'IANA time zone the schedule is read in, e.g. America/Los_Angeles. Daylight saving is handled for you. Omit for UTC.',
    )
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
          // Forwarded verbatim: the platform owns time-zone validation and DST,
          // so the CLI never converts an offset or second-guesses the name.
          ['timezone', opts.timezone],
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
