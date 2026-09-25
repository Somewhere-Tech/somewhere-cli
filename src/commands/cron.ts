import { Command } from 'commander';
import { loadProjectConfig } from '../lib/config.js';
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

interface CronListOptions extends ProjectOptions {
  all?: boolean;
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

interface CronRunOptions extends ProjectOptions {
  wait?: boolean;
  timeout?: string;
}

interface CronRunResult extends Record<string, unknown> {
  cron_id: string;
  job_id: string;
  status: string;
  trigger: string;
}

interface JobView extends Record<string, unknown> {
  job_id: string;
  status: string;
}

const DEFAULT_WAIT_TIMEOUT_SECONDS = 120;
const WAIT_POLL_INTERVAL_MS = 1000;
/** Statuses job_get reports once a job can no longer change. `indeterminate`
 *  is deliberately absent: it also appears briefly while a job is being
 *  dispatched, so --wait keeps polling it until the timeout. */
const JOB_SUCCESS_STATUS = 'complete';
const JOB_FAILURE_STATUSES = new Set(['failed', 'cancelled']);

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

function jobView(value: unknown): JobView {
  const data = unwrapPlatformData(value);
  if (!isRecord(data) || typeof data.job_id !== 'string' || typeof data.status !== 'string') {
    throw new Error('job_get returned an unexpected response.');
  }
  return data as JobView;
}

function parseWaitTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`USAGE_ERROR: --timeout must be a positive number of seconds, got "${value}".`);
  }
  return seconds;
}

function isTerminalJobStatus(status: string): boolean {
  return status === JOB_SUCCESS_STATUS || JOB_FAILURE_STATUSES.has(status);
}

/** Polls job_get until the job reaches a terminal status or the deadline
 *  passes; returns the last job view either way. */
async function waitForJob(jobId: string, timeoutSeconds: number): Promise<{ job: JobView; timedOut: boolean }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const job = jobView(await callPlatformTool('job_get', { job_id: jobId }, { allTools: true }));
    if (isTerminalJobStatus(job.status)) return { job, timedOut: false };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { job, timedOut: true };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(WAIT_POLL_INTERVAL_MS, remaining)));
  }
}

function formatJobValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function printWaitedJob(job: JobView, timedOut: boolean, timeoutSeconds: number): void {
  if (timedOut) {
    error(`Job ${job.job_id} has not finished after ${timeoutSeconds}s (status: ${job.status}). It may still complete; check it with \`somewhere call job_get '{"job_id":"${job.job_id}"}'\`.`);
  } else if (job.status === JOB_SUCCESS_STATUS) {
    success(`Scheduled task finished: job ${job.job_id} complete.`);
  } else {
    error(`Scheduled task did not succeed: job ${job.job_id} ${job.status}.`);
  }
  if (job.result !== undefined && job.result !== null) console.log(`Result: ${formatJobValue(job.result)}`);
  if (typeof job.error === 'string' && job.error.length > 0) {
    console.log(`Error: ${typeof job.error_code === 'string' ? `${job.error_code}: ` : ''}${job.error}`);
  }
  if (isRecord(job.recovery) && typeof job.recovery.recovery_error === 'string') {
    console.log(`Recovery: ${job.recovery.recovery_error}`);
  }
  const timings = compactRecord([
    ['created', job.created_at],
    ['started', job.started_at ?? undefined],
    ['completed', job.completed_at ?? undefined],
  ]);
  const timingText = Object.entries(timings).map(([label, at]) => `${label} ${formatJobValue(at)}`).join('  ');
  if (timingText) console.log(dim(timingText));
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

/** An explicit --project wins; otherwise the linked directory's project.
 *  Undefined only when neither exists, which the caller must treat as
 *  account-wide rather than guessing a project. */
function cronProjectScope(explicit: string | undefined): string | undefined {
  return explicit ?? loadProjectConfig()?.project_id;
}

async function resolveCronRunId(target: string, explicit: string | undefined): Promise<string> {
  if (target.startsWith('cron_')) return target;
  const project = cronProjectScope(explicit);
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
      '\nExamples:\n  somewhere cron list                 # linked project; --all lists every project\n'
        + '  somewhere cron create "0 8 * * *" /api/daily-digest --project my-app\n'
        + '  somewhere cron create "0 9 * * *" /api/daily-digest --project my-app --timezone America/Los_Angeles\n'
        + '  somewhere cron run daily-digest --wait   # queue one run now and wait for its result\n'
        + '\nSchedules are read in UTC unless --timezone names an IANA zone.\n',
    );

  cron
    .command('list')
    .alias('ls')
    .description('List scheduled triggers for the linked project, or across projects with --all')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--all', 'List scheduled triggers across every project you can access')
    .option('--json', 'Print the complete response as JSON')
    .action(async (opts: CronListOptions) => {
      if (opts.all && opts.project) {
        error('Pass --project <project> or --all, not both.');
        process.exitCode = 1;
        return;
      }
      const project = opts.all ? undefined : cronProjectScope(opts.project);
      if (!opts.all && !project) {
        console.error(dim('No linked project: listing across all projects. Pass --project <project> to scope, or --all to say so.'));
      }
      await runCronTool('cron_list', compactRecord([
        ['project_id', project],
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
    .description('Queue one run of a scheduled task now without changing its schedule; --wait waits for it to finish')
    .option('-p, --project <project>', 'Project slug or ID used to resolve a task name; defaults to the linked project')
    .option('--wait', 'Wait for the queued job to finish and print its result; exits non-zero on failure or timeout')
    .option('--timeout <seconds>', `With --wait, how long to wait before giving up (default ${DEFAULT_WAIT_TIMEOUT_SECONDS})`)
    .option('--json', 'Print the complete response as JSON')
    .addHelpText(
      'after',
      '\nWithout --wait the command returns as soon as the job is queued; the task has not run yet,\n'
        + 'so anything it writes may not be visible for a few seconds. Pass --wait before reading its effects.\n',
    )
    .action(async (target: string, opts: CronRunOptions) => {
      let queued = false;
      try {
        const timeoutSeconds = parseWaitTimeout(opts.timeout);
        if (opts.timeout !== undefined && !opts.wait) {
          throw new Error('USAGE_ERROR: --timeout only applies with --wait.');
        }
        const cronId = await resolveCronRunId(target, opts.project);
        const value = await callPlatformTool('cron_run', { cron_id: cronId }, { allTools: true });
        queued = true;
        if (!opts.wait) {
          if (opts.json) {
            printJson(value);
            return;
          }
          const result = cronRunResult(value);
          success(`Scheduled task queued (not finished yet). Job ${result.job_id}.`);
          console.log(dim(`Cron ${result.cron_id}  Job ${result.job_id}  ${result.status}  trigger: ${result.trigger}`));
          console.log(dim('Pass --wait to wait for the run to finish and see its result.'));
          return;
        }
        const result = cronRunResult(value);
        if (!opts.json) console.log(dim(`Job ${result.job_id} queued for cron ${result.cron_id}; waiting up to ${timeoutSeconds}s…`));
        const { job, timedOut } = await waitForJob(result.job_id, timeoutSeconds);
        const succeeded = !timedOut && job.status === JOB_SUCCESS_STATUS;
        if (!succeeded) process.exitCode = 1;
        if (opts.json) {
          const run = { cron_id: result.cron_id, job_id: result.job_id, trigger: result.trigger };
          if (timedOut) {
            printJsonError('CRON_RUN_WAIT_TIMEOUT', `Job ${job.job_id} has not finished after ${timeoutSeconds}s (status: ${job.status}).`, { data: { ...run, job } });
          } else if (!succeeded) {
            printJsonError('CRON_RUN_JOB_FAILED', `Job ${job.job_id} ${job.status}.`, { data: { ...run, job } });
          } else {
            printJson({ ok: true, data: { ...run, job } });
          }
          return;
        }
        printWaitedJob(job, timedOut, timeoutSeconds);
      } catch (err) {
        // Once cron_run has answered, a later error comes from job_get and
        // says nothing about whether cron run exists on this platform.
        if (!queued && cronRunUnavailable(err)) {
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
    .addHelpText('after', '\nHandler is a deployed route such as /api/tick, not a source filename such as api/tick.js.\n')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
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
