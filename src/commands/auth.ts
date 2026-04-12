import { Command } from 'commander';
import ora from 'ora';
import { browserLogin } from '../lib/auth.js';
import { ApiClient } from '../lib/client.js';
import { clearConfig, getToken, loadConfig, saveConfig } from '../lib/config.js';
import { dim, error, info, success, teal } from '../lib/output.js';

export function registerAuth(program: Command) {
  program
    .command('login')
    .description('Authenticate with somewhere.tech via browser')
    .action(async () => {
      const spinner = ora('Opening browser for authentication...').start();
      try {
        const config = await browserLogin();
        saveConfig(config);
        spinner.stop();
        success(`Logged in as ${teal(config.user.email)}`);
        info(`API key stored in ${dim('~/.somewhere/config.json')}`);
      } catch (err) {
        spinner.fail('Login failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  program
    .command('logout')
    .description('Remove stored credentials')
    .action(() => {
      clearConfig();
      success('Logged out. Token removed from ~/.somewhere/config.json');
    });

  program
    .command('whoami')
    .description('Show current user info')
    .action(async () => {
      const config = loadConfig();
      if (!config) {
        error('Not logged in. Run: somewhere login');
        process.exit(1);
      }

      const client = new ApiClient(config.token);
      try {
        const billing = await client.call<{
          tier: string;
          apps_used: number;
          total_app_slots: number;
        }>('GET', '/billing/status');

        const projects = await client.call<{
          projects: Array<{ status: string }>;
          deployed_count: number;
        }>('GET', '/projects');

        const deployed = projects.deployed_count ?? 0;
        const draft = (projects.projects ?? []).filter(
          (p) => p.status === 'draft',
        ).length;

        console.log(`${teal(config.user.email)} (${config.user.username})`);
        info(`Plan: ${billing.tier === 'builder' ? 'Builder' : 'Free'}`);
        info(`Projects: ${projects.projects.length} (${deployed} deployed, ${draft} draft)`);
        info(`Profile: ${config.user.username}.somewhere.tech`);
      } catch (err) {
        console.log(teal(config.user.email));
        info(dim('Could not fetch account details'));
      }
    });
}
