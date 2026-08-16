import { Command } from 'commander';
import _open from '../lib/open.js';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info } from '../lib/output.js';
import { getProjectServingUrl } from '../lib/project-urls.js';

export function registerOpen(program: Command) {
  program
    .command('open [project]')
    .description('Open the project URL in your browser')
    .option('--dashboard', 'Open the dashboard instead')
    .action(async (project: string | undefined, opts) => {
      if (opts.dashboard) {
        info(`Opening ${dim('https://somewhere.tech/dashboard')}...`);
        await _open('https://somewhere.tech/dashboard');
        return;
      }

      const token = getToken();
      const client = new ApiClient(token);

      let projectRef: string | undefined;

      if (project) {
        projectRef = project;
      } else {
        const config = loadProjectConfig();
        projectRef = config?.project_id;
      }

      if (!projectRef) {
        error(
          'No project linked. Pass a project name or run from a linked directory.',
        );
        process.exit(1);
      }

      try {
        const servingUrl = await getProjectServingUrl(client, projectRef);
        if (!servingUrl) throw new Error('The platform did not return a live URL for this project.');
        info(`Opening ${dim(servingUrl)}...`);
        await _open(servingUrl);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
