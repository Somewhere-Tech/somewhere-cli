import { Command } from 'commander';
import { registerAuth } from './commands/auth.js';
import { registerInit } from './commands/init.js';
import { registerProject } from './commands/project.js';
import { registerDeploy } from './commands/deploy.js';
import { registerLogs } from './commands/logs.js';
import { registerEnv } from './commands/env.js';
import { registerStatus } from './commands/status.js';
import { registerOpen } from './commands/open.js';
import { registerDev } from './commands/dev.js';
import { registerApi } from './commands/api.js';

const program = new Command()
  .name('somewhere')
  .description('CLI for somewhere.tech')
  .version('0.1.0');

registerAuth(program);
registerInit(program);
registerProject(program);
registerDeploy(program);
registerLogs(program);
registerEnv(program);
registerStatus(program);
registerOpen(program);
registerDev(program);
registerApi(program);

program.parse();
