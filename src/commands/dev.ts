import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ora from 'ora';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, success, teal } from '../lib/output.js';

export function registerDev(program: Command) {
  program
    .command('dev [cmd...]')
    .description('Start local dev with platform env vars injected')
    .action(async (cmdParts: string[]) => {
      const token = getToken();
      const client = new ApiClient(token);
      const config = loadProjectConfig();

      if (!config) {
        error('No project linked. Run `somewhere init` first.');
        process.exit(1);
      }

      const spinner = ora('Loading env vars from somewhere.tech...').start();
      try {
        const result = await client.call<{
          keys?: Array<{ key: string }>;
          vars?: Array<{ key: string }>;
        }>('GET', '/env', undefined, { project_id: config.project_id });

        const vars = result.keys ?? result.vars ?? [];
        spinner.stop();
        success(`${vars.length} env vars loaded`);

        // Detect dev command
        let command = cmdParts.join(' ');
        if (!command) {
          command = detectDevCommand();
        }
        if (!command) {
          error(
            'Could not detect a dev command. Pass one: somewhere dev npm run dev',
          );
          process.exit(1);
        }

        info(`Starting: ${dim(command)}`);
        console.log('');

        const envOverrides: Record<string, string> = {
          SOMEWHERE_PROJECT_ID: config.project_id,
          SOMEWHERE_SUBDOMAIN: config.subdomain,
          SOMEWHERE_URL: `https://${config.subdomain}.somewhere.tech`,
        };
        // Env var VALUES aren't returned by the API (encrypted). The user's
        // functions/server will read them from the platform at runtime.
        // Here we just inject the project context vars.

        const child = spawn(command, {
          shell: true,
          stdio: 'inherit',
          env: { ...process.env, ...envOverrides },
        });

        child.on('exit', (code) => process.exit(code ?? 0));
      } catch (err) {
        spinner.fail('Failed to load env vars');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function detectDevCommand(): string {
  const pkgPath = join(process.cwd(), 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.dev) return 'npm run dev';
      if (pkg.scripts?.start) return 'npm start';
    } catch {}
  }
  return '';
}
