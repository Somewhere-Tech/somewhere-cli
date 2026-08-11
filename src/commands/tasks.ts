import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import {
  compactRecord,
  isRecord,
  parseCommaList,
  resolveProjectRef,
  truncateText,
  unwrapPlatformData,
} from '../lib/platform-command.js';
import { dim, error, printJson, table, teal, timeAgo } from '../lib/output.js';

interface ProjectOptions {
  project?: string;
  json?: boolean;
}

interface TaskListOptions extends ProjectOptions {
  status?: string;
  assignee?: string;
  area?: string;
  parent?: string;
  query?: string;
  active?: boolean;
  stale?: boolean;
  staleDays?: string;
  sort?: string;
  full?: boolean;
  limit?: string;
  offset?: string;
}

interface TaskWriteOptions extends ProjectOptions {
  description?: string;
  status?: string;
  priority?: string;
  type?: string;
  assignee?: string;
  labels?: string;
  area?: string;
  parent?: string;
  dueAt?: string;
  statusNote?: string;
  health?: string;
  comment?: string;
  resolutionNote?: string;
  shippedIn?: string;
  deploymentProject?: string;
  deploymentVersion?: string;
}

function numberOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, received "${value}".`);
  return parsed;
}

function taskRows(value: unknown): string[][] {
  const data = unwrapPlatformData(value);
  if (!Array.isArray(data)) throw new Error('tasks_list returned an unexpected response.');
  return data.map((task) => {
    if (!isRecord(task)) return ['—', '—', '—', '—', '—'];
    const updated = typeof task.updated_at === 'number'
      ? timeAgo(new Date(task.updated_at).toISOString())
      : '—';
    return [
      typeof task.id === 'string' ? task.id : '—',
      truncateText(task.title, 56),
      typeof task.status === 'string' ? task.status : '—',
      typeof task.priority === 'string' ? task.priority : '—',
      updated,
    ];
  });
}

function printTaskMutation(value: unknown): void {
  const data = unwrapPlatformData(value);
  if (!isRecord(data)) {
    printJson(value);
    return;
  }
  const id = typeof data.id === 'string' ? data.id : null;
  const title = typeof data.title === 'string' ? data.title : null;
  const status = typeof data.status === 'string' ? data.status : null;
  console.log(`${teal(id ?? 'Task updated')}${title ? `  ${title}` : ''}${status ? `  ${dim(status)}` : ''}`);
  if (id) console.log(dim(`Next: somewhere tasks get ${id}`));
}

async function runTaskTool(
  name: string,
  args: Record<string, unknown>,
  json: boolean | undefined,
  printer: (value: unknown) => void,
): Promise<void> {
  try {
    const value = await callPlatformTool(name, args, { allTools: true });
    if (json) printJson(value);
    else printer(value);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export function registerTasks(program: Command): void {
  const tasks = program
    .command('tasks')
    .description('List, read, create, and update platform tasks');

  tasks
    .command('list')
    .description('List tasks')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--status <status>', 'Filter by status')
    .option('--assignee <assignee>', 'Filter by assignee')
    .option('--area <area>', 'Filter by area')
    .option('--parent <task-id>', 'Filter by parent task; use "null" for top-level tasks')
    .option('-q, --query <text>', 'Search task titles and descriptions')
    .option('--active', 'Only open and in-progress tasks')
    .option('--stale', 'Only stale in-progress tasks')
    .option('--stale-days <days>', 'Staleness threshold')
    .option('--sort <sort>', 'Sort by priority, updated, or created')
    .option('--full', 'Return complete descriptions')
    .option('--limit <n>', 'Maximum rows')
    .option('--offset <n>', 'Rows to skip')
    .option('--json', 'Print the complete response as JSON')
    .action(async (opts: TaskListOptions) => {
      const args = compactRecord([
        ['project_id', resolveProjectRef(opts.project)],
        ['status', opts.status],
        ['assignee', opts.assignee],
        ['area', opts.area],
        ['parent_id', opts.parent],
        ['q', opts.query],
        ['active', opts.active],
        ['stale', opts.stale],
        ['stale_days', numberOption(opts.staleDays)],
        ['sort', opts.sort],
        ['detail', opts.full ? 'full' : undefined],
        ['limit', numberOption(opts.limit)],
        ['offset', numberOption(opts.offset)],
      ]);
      await runTaskTool('tasks_list', args, opts.json, (value) => {
        const rows = taskRows(value);
        if (rows.length === 0) console.log(dim('No matching tasks.'));
        else table(['ID', 'Title', 'Status', 'Priority', 'Updated'], rows);
      });
    });

  tasks
    .command('get <task-id>')
    .description('Get one task with comments, activity, and relationships')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--json', 'Print the complete response as JSON')
    .action(async (taskId: string, opts: ProjectOptions) => {
      await runTaskTool('tasks_get', {
        project_id: resolveProjectRef(opts.project),
        task_id: taskId,
      }, opts.json, (value) => printJson(unwrapPlatformData(value)));
    });

  tasks
    .command('create <title>')
    .description('Create a task without opening an editor')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('-d, --description <text>', 'Long-form task description')
    .option('--status <status>', 'Initial status')
    .option('--priority <priority>', 'low, normal, high, or urgent')
    .option('--type <type>', 'Task type')
    .option('--assignee <assignee>', 'Assignee')
    .option('--labels <labels>', 'Comma-separated labels')
    .option('--area <area>', 'Subsystem area')
    .option('--parent <task-id>', 'Parent task ID')
    .option('--due-at <unix-ms>', 'Due time as a Unix timestamp in milliseconds')
    .option('--json', 'Print the complete response as JSON')
    .action(async (title: string, opts: TaskWriteOptions) => {
      const args = compactRecord([
        ['project_id', resolveProjectRef(opts.project)],
        ['title', title],
        ['description', opts.description],
        ['status', opts.status],
        ['priority', opts.priority],
        ['type', opts.type],
        ['assignee', opts.assignee],
        ['labels', parseCommaList(opts.labels)],
        ['area', opts.area],
        ['parent_id', opts.parent],
        ['due_at', numberOption(opts.dueAt)],
      ]);
      await runTaskTool('tasks_create', args, opts.json, printTaskMutation);
    });

  tasks
    .command('update <task-id>')
    .description('Update task fields or add a comment')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--title <title>', 'New title')
    .option('-d, --description <text>', 'New description')
    .option('--status <status>', 'New status')
    .option('--priority <priority>', 'New priority')
    .option('--type <type>', 'New type')
    .option('--assignee <assignee>', 'New assignee')
    .option('--labels <labels>', 'Replacement comma-separated labels')
    .option('--area <area>', 'New area; pass an empty string to clear')
    .option('--parent <task-id>', 'New parent; pass an empty string to detach')
    .option('--due-at <unix-ms>', 'Due time as a Unix timestamp in milliseconds')
    .option('--status-note <text>', 'Overwrite the current status note')
    .option('--health <health>', 'on_track, at_risk, or off_track')
    .option('--comment <text>', 'Append an evidence comment')
    .option('--resolution-note <text>', 'Resolution note when closing the task')
    .option('--shipped-in <version>', 'Release/version tag this task shipped in')
    .option('--deployment-project <project>', 'Project owning --deployment-version')
    .option('--deployment-version <version>', 'Verified production version to link')
    .option('--json', 'Print the complete response as JSON')
    .action(async (taskId: string, opts: TaskWriteOptions & { title?: string }) => {
      const args = compactRecord([
        ['project_id', resolveProjectRef(opts.project)],
        ['task_id', taskId],
        ['title', opts.title],
        ['description', opts.description],
        ['status', opts.status],
        ['priority', opts.priority],
        ['type', opts.type],
        ['assignee', opts.assignee],
        ['labels', parseCommaList(opts.labels)],
        ['area', opts.area],
        ['parent_id', opts.parent],
        ['due_at', numberOption(opts.dueAt)],
        ['status_note', opts.statusNote],
        ['health', opts.health],
        ['comment', opts.comment],
        ['resolution_note', opts.resolutionNote],
        ['shipped_in', opts.shippedIn],
        ['deployment_project_id', opts.deploymentProject],
        ['deployment_version', numberOption(opts.deploymentVersion)],
      ]);
      if (Object.keys(args).length === 2) {
        error('No update supplied. Pass a field such as --status, --status-note, or --comment.');
        process.exitCode = 1;
        return;
      }
      await runTaskTool('tasks_update', args, opts.json, printTaskMutation);
    });
}
