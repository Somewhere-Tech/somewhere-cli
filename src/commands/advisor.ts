import { Command } from 'commander';
import { error, printJson } from '../lib/output.js';
import { callPlatformHelpTool } from '../lib/platform-tools.js';
export { callPlatformHelpTool };

export function registerAdvisor(program: Command): void {
  program
    .command('advisor <question>')
    .description('Ask the somewhere.tech platform advisor a question')
    .option('--json', 'Print the advisor response in a JSON envelope')
    .action(async (question: string, opts: { json?: boolean }) => {
      try {
        const answer = await callPlatformHelpTool('advisor', { question });
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
