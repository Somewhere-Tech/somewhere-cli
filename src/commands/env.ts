import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, success, teal } from '../lib/output.js';

function resolveProjectId(explicit?: string): string {
  if (explicit) return explicit;
  const config = loadProjectConfig();
  if (!config) {
    error('No project. Pass --project or run from a linked directory.');
    process.exit(1);
  }
  return config.project_id;
}

export function registerEnv(program: Command) {
  const env = program
    .command('env')
    .description('Manage environment variables');

  env
    .command('list')
    .alias('ls')
    .description('List environment variables')
    .option('--project <id>', 'Project ID')
    .action(async (opts) => {
      const client = new ApiClient(getToken());
      const pid = resolveProjectId(opts.project);
      try {
        const result = await client.call<{
          keys?: Array<{ key: string; created_at?: string }>;
          vars?: Array<{ key: string; created_at?: string }>;
        }>('GET', '/env', undefined, { project_id: pid });

        const vars = result.keys ?? result.vars ?? [];
        if (!vars.length) {
          info(dim('No environment variables set.'));
          return;
        }
        for (const v of vars) {
          console.log(`  ${teal(v.key)}`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  env
    .command('set <key> <value>')
    .description('Set an environment variable')
    .option('--project <id>', 'Project ID')
    .action(async (key: string, value: string, opts) => {
      const client = new ApiClient(getToken());
      const pid = resolveProjectId(opts.project);
      try {
        await client.call('POST', '/env', {
          project_id: pid,
          key,
          value,
        });
        success(`${key} updated`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  env
    .command('delete <key>')
    .alias('rm')
    .description('Delete an environment variable')
    .option('--project <id>', 'Project ID')
    .action(async (key: string, opts) => {
      const client = new ApiClient(getToken());
      const pid = resolveProjectId(opts.project);
      try {
        await client.call(
          'DELETE',
          `/env/${encodeURIComponent(pid)}/${encodeURIComponent(key)}`,
        );
        success(`${key} deleted`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
