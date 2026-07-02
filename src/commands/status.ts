import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, statusDot, teal, timeAgo } from '../lib/output.js';

export function registerStatus(program: Command) {
  program
    .command('status [project]')
    .description('Show project and workspace status')
    .action(async (projectArg: string | undefined) => {
      const token = getToken();
      const client = new ApiClient(token);

      let projectId = projectArg;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass a project ID or run `somewhere init`.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      try {
        const p = await client.call<{
          name: string;
          status: string;
          subdomain: string;
          updated_at?: string;
        }>('GET', `/projects/${encodeURIComponent(projectId)}`);

        console.log(`\n  Project: ${teal(p.name)} (${statusDot(p.status)})`);
        if (p.subdomain) {
          info(`URL: https://${p.subdomain}.somewhere.tech`);
        }
        if (p.updated_at) {
          info(`Last deploy: ${timeAgo(p.updated_at)}`);
        }
      } catch (err) {
        error(`Project: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1; // a failed status must not report success to a script
      }

      try {
        const ws = await client.call<{
          status: string;
          terminal_url?: string | null;
        }>('GET', '/hosted/status');

        console.log('');
        // The hosted code workspace is OPTIONAL and separate from the deployed
        // app — a non-'ready' status here (e.g. "waking") NEVER means the live
        // site is down (audit #8 / tsk_30633bb3). Label it as the dev workspace
        // and say so, so "waking" doesn't read as an outage.
        const wsStatus = ws.status === 'ready' ? 'running' : `${ws.status} (starting)`;
        info(`Dev workspace: ${wsStatus} ${dim('— optional code workspace; your deployed app serves regardless')}`);
        if (ws.terminal_url) {
          info(`Terminal: ${dim(ws.terminal_url)}`);
        }
      } catch {
        // No workspace or not configured — just skip
      }

      console.log('');
    });
}
