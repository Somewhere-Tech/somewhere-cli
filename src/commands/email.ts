import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import { compactRecord, isRecord, resolveProjectRef, unwrapPlatformData } from '../lib/platform-command.js';
import { dim, error, printJson, printJsonError, success } from '../lib/output.js';

interface EmailSendOptions {
  project?: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  json?: boolean;
}

interface EmailTestInboxMessage {
  id: string;
  to: string;
  subject: string;
  html: string | null;
  text: string | null;
  created_at: string;
  magic_link: string | null;
}

interface EmailTestInboxResult {
  address: string;
  messages: EmailTestInboxMessage[];
  limit?: number;
}

const TEST_INBOX_UNAVAILABLE = 'Test inbox is not available on this platform version yet.';

function parseTestInbox(value: unknown): EmailTestInboxResult {
  const data = unwrapPlatformData(value);
  if (!isRecord(data) || typeof data.address !== 'string' || !Array.isArray(data.messages)) {
    throw new Error('email_test_inbox returned an unexpected response.');
  }
  const messages = data.messages.map((message, index) => {
    if (!isRecord(message)
        || typeof message.id !== 'string'
        || typeof message.to !== 'string'
        || typeof message.subject !== 'string'
        || typeof message.created_at !== 'string') {
      throw new Error(`email_test_inbox returned an invalid message at index ${index}.`);
    }
    return {
      id: message.id,
      to: message.to,
      subject: message.subject,
      html: typeof message.html === 'string' ? message.html : null,
      text: typeof message.text === 'string' ? message.text : null,
      created_at: message.created_at,
      magic_link: typeof message.magic_link === 'string' ? message.magic_link : null,
    };
  });
  return {
    address: data.address,
    messages,
    ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
  };
}

function printTestInbox(inbox: EmailTestInboxResult): void {
  console.log(`Test inbox ${inbox.address} — ${inbox.messages.length} message${inbox.messages.length === 1 ? '' : 's'}`);
  if (inbox.messages.length === 0) {
    console.log(dim('No stored messages.'));
    return;
  }
  for (const [index, message] of inbox.messages.entries()) {
    if (index > 0) console.log('');
    console.log(`${message.created_at}  ${message.subject}`);
    console.log(`id: ${message.id}`);
    console.log(`to: ${message.to}`);
    console.log(`magic_link: ${message.magic_link ?? 'null'}`);
    if (message.text !== null) console.log(`text:\n${message.text}`);
    if (message.html !== null) console.log(`html:\n${message.html}`);
  }
}

function testInboxUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unknown tool:?\s*["']?email_test_inbox/i.test(message)
    || /tool\s+["']?email_test_inbox["']?\s+(?:was\s+)?not found/i.test(message)
    || (/NOT_FOUND/i.test(message) && /email_test_inbox|tool/i.test(message));
}

function platformErrorParts(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^([A-Z][A-Z0-9_]+):\s*(.+)$/s.exec(message);
  return match ? { code: match[1], message: match[2] } : { code: 'CLI_ERROR', message };
}

export function registerEmail(program: Command): void {
  const email = program
    .command('email')
    .description('Send transactional email and inspect project test messages')
    .addHelpText(
      'after',
      '\nExamples:\n  somewhere email send alice@example.com --from hello@myapp.com --subject "Welcome" --text "You are in." --project my-app\n  somewhere email test-inbox robot@my-app.test.somewhere.site --project my-app\n',
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

  email
    .command('test-inbox <address>')
    .description('Read stored auth messages for a project-owned test address')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--json', 'Print the complete response as JSON')
    .action(async (address: string, opts: { project?: string; json?: boolean }) => {
      try {
        const value = await callPlatformTool('email_test_inbox', {
          project_id: resolveProjectRef(opts.project),
          address,
        }, { allTools: true });
        if (opts.json) printJson(value);
        else printTestInbox(parseTestInbox(value));
      } catch (err) {
        if (testInboxUnavailable(err)) {
          if (opts.json) printJsonError('EMAIL_TEST_INBOX_NOT_AVAILABLE', TEST_INBOX_UNAVAILABLE);
          else error(`EMAIL_TEST_INBOX_NOT_AVAILABLE: ${TEST_INBOX_UNAVAILABLE}`);
        } else {
          const { code, message } = platformErrorParts(err);
          if (opts.json) printJsonError(code, message);
          else error(`${code}: ${message}`);
        }
        process.exitCode = 1;
      }
    });
}
