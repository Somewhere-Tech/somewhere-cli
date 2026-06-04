import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAuth } from './commands/auth.js';
import { registerInit } from './commands/init.js';
import { registerProject } from './commands/project.js';
import { registerDeploy } from './commands/deploy.js';
import { registerPull } from './commands/pull.js';
import { registerPromote } from './commands/promote.js';
import { registerDb } from './commands/db.js';
import { registerLogs } from './commands/logs.js';
import { registerEnv } from './commands/env.js';
import { registerStatus } from './commands/status.js';
import { registerOpen } from './commands/open.js';
import { registerDev } from './commands/dev.js';
import { registerApi } from './commands/api.js';
import { registerMcp } from './commands/mcp.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };

const program = new Command()
  .name('somewhere')
  .description('CLI for somewhere.tech')
  .version(pkg.version);

registerAuth(program);
registerInit(program);
registerProject(program);
registerDeploy(program);
registerPull(program);
registerPromote(program);
registerDb(program);
registerLogs(program);
registerEnv(program);
registerStatus(program);
registerOpen(program);
registerDev(program);
registerApi(program);
registerMcp(program);

program.parse();
