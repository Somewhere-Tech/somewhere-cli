import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, printJson, statusDot, teal, timeAgo } from '../lib/output.js';
import { callPlatformTool } from '../lib/platform-tools.js';
import { isRecord, unwrapPlatformData } from '../lib/platform-command.js';
import { fallbackProjectServingUrl, getProjectServingUrl } from '../lib/project-urls.js';

export function registerStatus(program: Command) {
  program
    .command('status [project]')
    .description('Show project and workspace status')
    .option('--json', 'Print the raw status responses as JSON')
    .action(async (projectArg: string | undefined, opts) => {
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

      let projectStatus: {
        name: string;
        status: string;
        subdomain: string;
        slug?: string;
        updated_at?: string;
      } | null = null;
      let projectError: string | null = null;
      let deploymentStatus: Record<string, unknown> | null = null;
      let deploymentError: string | null = null;
      let workspaceStatus: {
        status: string;
        terminal_url?: string | null;
      } | null = null;

      try {
        const p = await client.call<{
          name: string;
          status: string;
          subdomain: string;
          slug?: string;
          updated_at?: string;
        }>('GET', `/projects/${encodeURIComponent(projectId)}`);
        projectStatus = p;

        const servingUrl = await getProjectServingUrl(client, projectId).catch(() =>
          fallbackProjectServingUrl(p),
        );

        if (!opts.json) {
          console.log(`\n  Project: ${teal(p.name)} (${statusDot(p.status)})`);
          if (servingUrl) info(`URL: ${servingUrl}`);
          if (p.updated_at) {
            info(`Last deploy: ${timeAgo(p.updated_at)}`);
          }
        }
      } catch (err) {
        projectError = err instanceof Error ? err.message : String(err);
        if (!opts.json) error(`Project: ${projectError}`);
        process.exitCode = 1; // a failed status must not report success to a script
      }

      try {
        const deployment = unwrapPlatformData(await callPlatformTool(
          'deploy_status',
          { project_id: projectId },
          { allTools: true },
        ));
        if (!isRecord(deployment)) throw new Error('deploy_status returned an unexpected response.');
        deploymentStatus = deployment;
        if (!opts.json) {
          const prodVersion = typeof deployment.prod_version === 'number'
            ? deployment.prod_version
            : typeof deployment.dev_version === 'number' && deployment.in_sync === true
              ? deployment.dev_version
              : null;
          if (prodVersion !== null) info(`Production version: ${teal(String(prodVersion))}`);
          if (typeof deployment.active_release_id === 'string') {
            info(`Active release: ${dim(deployment.active_release_id)}`);
          }
          if (deployment.dev_ahead === true) {
            info(`Draft: ${deployment.files_changed ?? 'some'} file(s) ahead of production`);
          } else if (deployment.in_sync === true) {
            info('Deploy state: dev and production are in sync');
          }
        }
      } catch (err) {
        deploymentError = err instanceof Error ? err.message : String(err);
        if (!opts.json) error(`Deploy status: ${deploymentError}`);
        process.exitCode = 1;
      }

      try {
        const ws = await client.call<{
          status: string;
          terminal_url?: string | null;
        }>('GET', '/hosted/status');
        workspaceStatus = ws;

        if (!opts.json) {
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
        }
      } catch {
        // No workspace or not configured — just skip
      }

      if (opts.json) {
        printJson({
          project: projectStatus,
          deployment: deploymentStatus,
          workspace: workspaceStatus,
          project_error: projectError,
          deployment_error: deploymentError,
        });
      } else {
        console.log('');
      }
    });
}
