import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAuth } from './commands/auth.js';
import { registerInit } from './commands/init.js';
import { registerProject } from './commands/project.js';
import { registerDeploy } from './commands/deploy.js';
import { registerPull } from './commands/pull.js';
import { registerTypecheck } from './commands/typecheck.js';
import { registerPromote } from './commands/promote.js';
import { registerRollback } from './commands/rollback.js';
import { registerDb } from './commands/db.js';
import { registerLogs } from './commands/logs.js';
import { registerErrors } from './commands/errors.js';
import { registerEnv } from './commands/env.js';
import { registerRun } from './commands/run.js';
import { registerStatus } from './commands/status.js';
import { registerOpen } from './commands/open.js';
import { registerDev } from './commands/dev.js';
import { registerExec } from './commands/exec.js';
import { registerApi } from './commands/api.js';
import { registerMcp } from './commands/mcp.js';
import { registerSwpx } from './commands/swpx.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };

const program = new Command()
  .name('somewhere')
  .description('CLI for somewhere.tech')
  .version(pkg.version);

// Required so the npx/npm pass-through commands can forward unknown flags to the
// wrapped tool (passThroughOptions). Only affects program-level option ordering
// (global -V/--version/--help still work); each subcommand parses as before.
program.enablePositionalOptions();

registerAuth(program);
registerInit(program);
registerProject(program);
registerDeploy(program);
registerPull(program);
registerTypecheck(program);
registerPromote(program);
registerRollback(program);
registerDb(program);
registerLogs(program);
registerErrors(program);
registerEnv(program);
registerRun(program);
registerStatus(program);
registerOpen(program);
registerDev(program);
registerExec(program);
registerApi(program);
registerMcp(program);
registerSwpx(program);

program.parse();
