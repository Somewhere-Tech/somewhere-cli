import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import {
  compactRecord,
  isRecord,
  resolveProjectRef,
  unwrapPlatformData,
} from '../lib/platform-command.js';
import { error, printJson } from '../lib/output.js';

interface GrepOptions {
  project?: string;
  glob?: string;
  env?: string;
  maxResults?: string;
  ignoreCase?: boolean;
  json?: boolean;
}

export function registerGrep(program: Command): void {
  program
    .command('grep <pattern>')
    .description('Regex-search deployed project source and print file:line matches')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('-g, --glob <glob>', 'Limit matching paths, for example src/** or *.tsx')
    .option('--env <env>', 'prod or dev', 'prod')
    .option('--max-results <n>', 'Maximum matches, up to 1000', '100')
    .option('-i, --ignore-case', 'Match case-insensitively')
    .option('--json', 'Print the complete response as JSON')
    .action(async (pattern: string, opts: GrepOptions) => {
      try {
        const maxResults = Number(opts.maxResults);
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000) {
          throw new Error('--max-results must be an integer from 1 to 1000.');
        }
        const value = await callPlatformTool('project_grep', compactRecord([
          ['project_id', resolveProjectRef(opts.project)],
          ['pattern', pattern],
          ['glob', opts.glob],
          ['env', opts.env],
          ['max_results', maxResults],
          ['case_insensitive', opts.ignoreCase],
        ]), { allTools: true });
        if (opts.json) {
          printJson(value);
          return;
        }
        const data = unwrapPlatformData(value);
        if (!isRecord(data) || !Array.isArray(data.matches)) {
          throw new Error('project_grep returned an unexpected response.');
        }
        for (const match of data.matches) {
          if (!isRecord(match)) continue;
          const path = typeof match.path === 'string' ? match.path : 'unknown';
          const line = typeof match.line === 'number' ? match.line : 0;
          const col = typeof match.col === 'number' ? `:${match.col}` : '';
          const text = typeof match.text === 'string' ? match.text.trimEnd() : '';
          process.stdout.write(`${path}:${line}${col}: ${text}\n`);
        }
        if (data.truncated === true) {
          process.stderr.write('Results truncated. Narrow --glob or pattern, or raise --max-results.\n');
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
