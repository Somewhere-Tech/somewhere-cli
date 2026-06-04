import { Command } from 'commander';
import ora from 'ora';
import prompts from 'prompts';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, success, teal, warn } from '../lib/output.js';

interface PromoteResult {
  url: string;
  version: number;
  files_promoted: number;
  has_functions: boolean;
}

export function registerPromote(program: Command) {
  program
    .command('promote [project]')
    .description('Promote the dev environment to production')
    .option('-m, --message <msg>', 'Release notes for this version')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (projectArg: string | undefined, opts) => {
      const client = new ApiClient(getToken());

      let projectId = projectArg;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      if (!opts.yes) {
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Promote ${teal(projectId)} dev → prod?`,
          initial: true,
        });
        if (!ok) {
          warn('Aborted.');
          return;
        }
      }

      const spinner = ora('Promoting...').start();
      try {
        const r = await client.call<PromoteResult>('POST', '/promote', {
          project_id: projectId,
          message: opts.message,
        });
        spinner.stop();
        success(`Promoted v${r.version} (${r.files_promoted} file${r.files_promoted === 1 ? '' : 's'}${r.has_functions ? ' + functions' : ''})`);
        info(`Live at ${teal(r.url)}`);
        if (opts.message) info(dim(`Notes: ${opts.message}`));
      } catch (err) {
        spinner.fail('Promote failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
