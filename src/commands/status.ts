import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, statusDot, teal, timeAgo } from '../lib/output.js';

export function registerStatus(program: Command) {
  program
    .command('status')
    .description('Show project and workspace status')
    .action(async () => {
      const token = getToken();
      const client = new ApiClient(token);
      const config = loadProjectConfig();

      if (!config) {
        error('No project linked. Run `somewhere init` first.');
        process.exit(1);
      }

      try {
        const p = await client.call<{
          name: string;
          status: string;
          subdomain: string;
          updated_at?: string;
        }>('GET', `/projects/${encodeURIComponent(config.project_id)}`);

        console.log(`\n  Project: ${teal(p.name)} (${statusDot(p.status)})`);
        if (p.subdomain) {
          info(`URL: https://${p.subdomain}.somewhere.tech`);
        }
        if (p.updated_at) {
          info(`Last deploy: ${timeAgo(p.updated_at)}`);
        }
      } catch (err) {
        error(`Project: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const ws = await client.call<{
          status: string;
          terminal_url?: string | null;
        }>('GET', '/hosted/status');

        console.log('');
        const wsStatus = ws.status === 'ready' ? `Running` : ws.status;
        info(`Workspace: ${wsStatus}`);
        if (ws.terminal_url) {
          info(`Terminal: ${dim(ws.terminal_url)}`);
        }
      } catch {
        // No workspace or not configured — just skip
      }

      console.log('');
    });
}
