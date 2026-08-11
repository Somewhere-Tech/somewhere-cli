import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import {
  compactRecord,
  isRecord,
  unwrapPlatformData,
} from '../lib/platform-command.js';
import { error, printJson, table } from '../lib/output.js';

interface UsageOptions {
  period?: string;
  json?: boolean;
}

function displayCost(cents: unknown): string {
  return typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '—';
}

export function registerUsage(program: Command): void {
  program
    .command('usage [project]')
    .description('Show deploy, AI, proxy, and email usage for one project or the account')
    .option('--period <period>', 'Time period such as 7d or 30d', '30d')
    .option('--json', 'Print the complete response as JSON')
    .action(async (project: string | undefined, opts: UsageOptions) => {
      try {
        const value = await callPlatformTool('usage_summary', compactRecord([
          ['project_id', project],
          ['period', opts.period],
        ]), { allTools: true });
        if (opts.json) {
          printJson(value);
          return;
        }
        const data = unwrapPlatformData(value);
        const dataRecord = isRecord(data) ? data : null;
        const totals = dataRecord && isRecord(dataRecord.totals) ? dataRecord.totals : null;
        if (!totals) throw new Error('usage_summary returned an unexpected response.');
        const period = dataRecord && typeof dataRecord.period === 'string'
          ? dataRecord.period
          : opts.period ?? '30d';
        table(['Metric', 'Value'], [
          ['Period', period],
          ['Deploys', String(totals.deploys ?? 0)],
          ['AI calls', String(totals.ai_calls ?? 0)],
          ['AI cost', displayCost(totals.ai_cost_cents)],
          ['API proxy cost', displayCost(totals.api_proxy_cost_cents)],
          ['Emails sent', String(totals.emails_sent ?? 0)],
        ]);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
