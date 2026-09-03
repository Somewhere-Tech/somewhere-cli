import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import { compactRecord, resolveProjectRef } from '../lib/platform-command.js';
import { error, printJson, success } from '../lib/output.js';

interface EmailSendOptions {
  project?: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  json?: boolean;
}

export function registerEmail(program: Command): void {
  const email = program
    .command('email')
    .description('Send transactional email')
    .addHelpText(
      'after',
      '\nExample:\n  somewhere email send alice@example.com --from hello@myapp.com --subject "Welcome" --text "You are in." --project my-app\n',
    );

  email
    .command('send <recipient>')
    .description('Send one transactional email')
    .requiredOption('-p, --project <project>', 'Project slug or ID')
    .requiredOption('--from <sender>', 'Sender on a verified project domain')
    .requiredOption('--subject <subject>', 'Subject line')
    .option('--text <body>', 'Plaintext body')
    .option('--html <body>', 'HTML body')
    .option('--json', 'Print the complete response as JSON')
    .action(async (recipient: string, opts: EmailSendOptions) => {
      try {
        if (opts.text === undefined && opts.html === undefined) {
          throw new Error('Pass --text <body>, --html <body>, or both.');
        }
        const value = await callPlatformTool('email_send', compactRecord([
          ['project_id', resolveProjectRef(opts.project)],
          ['to', recipient],
          ['from', opts.from],
          ['subject', opts.subject],
          ['text', opts.text],
          ['html', opts.html],
        ]), { allTools: true });
        if (opts.json) printJson(value);
        else success(`Email sent to ${recipient}.`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
