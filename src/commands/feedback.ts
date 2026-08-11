import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import {
  isRecord,
  resolveProjectRef,
  truncateText,
  unwrapPlatformData,
} from '../lib/platform-command.js';
import { dim, error, printJson, table, timeAgo } from '../lib/output.js';

interface FeedbackOptions {
  project?: string;
  pageUrl?: string;
  json?: boolean;
}

async function feedbackCall(
  args: Record<string, unknown>,
  json: boolean | undefined,
  printer: (value: unknown) => void,
): Promise<void> {
  try {
    const value = await callPlatformTool('feedback', args, { allTools: true });
    if (json) printJson(value);
    else printer(value);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function printFeedbackList(value: unknown): void {
  const data = unwrapPlatformData(value);
  const rowsValue = isRecord(data) ? data.feedback : undefined;
  if (!Array.isArray(rowsValue)) {
    printJson(data);
    return;
  }
  if (rowsValue.length === 0) {
    console.log(dim('No project feedback.'));
    return;
  }
  const rows = rowsValue.map((row): string[] => {
    if (!isRecord(row)) return ['—', '—', '—', '—'];
    const created = typeof row.created_at === 'number'
      ? timeAgo(new Date(row.created_at).toISOString())
      : typeof row.created_at === 'string'
        ? timeAgo(row.created_at)
        : '—';
    return [
      typeof row.id === 'string' ? row.id : '—',
      truncateText(row.message, 72),
      typeof row.status === 'string' ? row.status : row.resolved === true ? 'resolved' : 'open',
      created,
    ];
  });
  table(['ID', 'Message', 'Status', 'When'], rows);
}

export function registerFeedback(program: Command): void {
  const feedback = program
    .command('feedback')
    .description('List or submit feedback for a project-owned application');

  feedback
    .command('list')
    .description('List feedback sent to the project owner inbox')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--json', 'Print the complete response as JSON')
    .action(async (opts: FeedbackOptions) => {
      await feedbackCall(
        { project_id: resolveProjectRef(opts.project) },
        opts.json,
        printFeedbackList,
      );
    });

  feedback
    .command('submit <message>')
    .description('Submit app feedback to the project owner inbox')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--page-url <url>', 'Page URL the feedback concerns')
    .option('--json', 'Print the complete response as JSON')
    .action(async (message: string, opts: FeedbackOptions) => {
      await feedbackCall({
        project_id: resolveProjectRef(opts.project),
        message,
        ...(opts.pageUrl ? { page_url: opts.pageUrl } : {}),
      }, opts.json, (value) => {
        const data = unwrapPlatformData(value);
        printJson(data);
        console.log(dim('Destination: project owner inbox. For a platform bug, use `somewhere call support_ticket`.'));
      });
    });
}
