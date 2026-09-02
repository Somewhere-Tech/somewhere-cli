import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { registerAuth } from './commands/auth.js';
import { registerInit } from './commands/init.js';
import { registerLink } from './commands/link.js';
import { registerProject } from './commands/project.js';
import { registerDeploy } from './commands/deploy.js';
import { registerPull } from './commands/pull.js';
import { registerTypecheck } from './commands/typecheck.js';
import { registerPromote } from './commands/promote.js';
import { registerRollback } from './commands/rollback.js';
import { registerDb } from './commands/db.js';
import { registerDocs } from './commands/docs.js';
import { registerAdvisor } from './commands/advisor.js';
import { registerCatalog } from './commands/catalog.js';
import { registerLogs } from './commands/logs.js';
import { registerErrors } from './commands/errors.js';
import { registerEnv } from './commands/env.js';
import { registerRun } from './commands/run.js';
import { registerStatus } from './commands/status.js';
import { registerOpen } from './commands/open.js';
import { registerDev, registerPreview } from './commands/dev.js';
import { registerExec } from './commands/exec.js';
import { registerBrowser } from './commands/browser.js';
import { registerCheck } from './commands/check.js';
import { registerApi } from './commands/api.js';
import { registerFs } from './commands/fs.js';
import { registerMcp } from './commands/mcp.js';
import { registerSwpx } from './commands/swpx.js';
import { registerUpdate } from './commands/update.js';
import { registerCall } from './commands/call.js';
import { registerTasks } from './commands/tasks.js';
import { registerFeedback } from './commands/feedback.js';
import { registerGrep } from './commands/grep.js';
import { registerUsage } from './commands/usage.js';
import { registerGit } from './commands/git.js';
import { collectNotices } from './lib/notify/index.js';
import { error, printJsonError, setJsonOutputMode, stripAnsi } from './lib/output.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };

const program = new Command()
  .name('somewhere')
  .description('CLI for somewhere.tech')
  .version(pkg.version);

const passThroughCommand = process.argv[2] === 'npx' || process.argv[2] === 'npm';
const jsonOutputRequested = !passThroughCommand && process.argv.includes('--json');
setJsonOutputMode(jsonOutputRequested);
if (jsonOutputRequested) {
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
}

// Required so the npx/npm pass-through commands can forward unknown flags to the
// wrapped tool (passThroughOptions). Only affects program-level option ordering
// (global -V/--version/--help still work); each subcommand parses as before.
program.enablePositionalOptions();

registerAuth(program);
registerInit(program);
registerLink(program);
registerProject(program);
registerDeploy(program);
registerPull(program);
registerTypecheck(program);
registerPromote(program);
registerRollback(program);
registerDb(program);
registerDocs(program);
registerAdvisor(program);
registerCatalog(program);
registerLogs(program);
registerErrors(program);
registerEnv(program);
registerRun(program);
registerStatus(program);
registerOpen(program);
registerDev(program);
registerPreview(program);
registerExec(program);
registerBrowser(program);
registerCheck(program);
registerApi(program);
registerFs(program);
registerMcp(program);
registerSwpx(program);
registerUpdate(program);
registerCall(program);
registerTasks(program);
registerFeedback(program);
registerGrep(program);
registerUsage(program);
registerGit(program);

// User-notification pipeline (update-available, advisories, announcements…).
// Centrally gated to interactive, non-CI, non-pass-through commands and emitted to
// STDERR as a parting line AFTER the command — never stdout, agent, or swpx/swpm
// safety output. Fail-open: collectNotices swallows all errors.
//
// Do NOT await this before parsing — the once-a-day cache-refresh fetch would add
// startup latency to every command. Kick it off, parse immediately; if it resolves
// before the process exits (the common cache-hit path is instant) it prints on
// exit, otherwise it silently lags to the next invocation.
collectNotices(process.argv)
  .then((notices) => {
    if (notices.length) process.on('exit', () => process.stderr.write('\n' + notices.join('\n') + '\n'));
  })
  .catch(() => {});
try {
  await program.parseAsync();
} catch (err) {
  if (jsonOutputRequested && err instanceof CommanderError) {
    if (err.code !== 'commander.helpDisplayed' && err.code !== 'commander.version') {
      printJsonError('USAGE_ERROR', stripAnsi(err.message.replace(/^error:\s*/i, '')));
      process.exitCode = err.exitCode || 1;
    }
  } else if (err instanceof Error) {
    error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
