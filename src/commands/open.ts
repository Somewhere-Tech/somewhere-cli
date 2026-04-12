import { Command } from 'commander';
import _open from 'open';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info } from '../lib/output.js';

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

      let subdomain: string | undefined;

      if (project) {
        try {
          const p = await client.call<{ subdomain: string }>(
            'GET',
            `/projects/${encodeURIComponent(project)}`,
          );
          subdomain = p.subdomain;
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      } else {
        const config = loadProjectConfig();
        subdomain = config?.subdomain;
      }

      if (!subdomain) {
        error(
          'No project linked. Pass a project name or run from a linked directory.',
        );
        process.exit(1);
      }

      const url = `https://${subdomain}.somewhere.tech`;
      info(`Opening ${dim(url)}...`);
      await _open(url);
    });
}
