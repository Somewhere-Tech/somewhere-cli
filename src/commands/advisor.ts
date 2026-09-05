import { Command } from 'commander';
import { error, printJson } from '../lib/output.js';
import { callPlatformHelpTool } from '../lib/platform-tools.js';
import { buildAdvisorContext, contextNotice } from '../lib/advisor-context.js';
export { callPlatformHelpTool };

export function registerAdvisor(program: Command): void {
  program
    .command('advisor <question>')
    .description('Ask the somewhere.tech platform advisor a question')
    .option('--json', 'Print the advisor response in a JSON envelope')
    .option('--file <path>', 'Attach a trimmed, redacted local file as context')
    .option('--no-context', 'Do not attach the linked project, previous run, or file')
    .action(async (question: string, opts: { json?: boolean; file?: string; context?: boolean }) => {
      try {
        const context = opts.context === false ? undefined : buildAdvisorContext(opts.file);
        process.stderr.write(`${contextNotice(context)}\n`);
        const answer = await callPlatformHelpTool('advisor', {
          question,
          ...(context ? { context } : {}),
        });
        if (opts.json) {
          printJson({ question, answer });
        } else {
          process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
