import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import prompts from 'prompts';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { buildEnvTemplate } from '../lib/envfile-write.js';
import { dim, error, info, printJson, success, teal, warn } from '../lib/output.js';

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
    .option('--json', 'Print the raw env response as JSON')
    .action(async (opts) => {
      const client = new ApiClient(getToken());
      const pid = resolveProjectId(opts.project);
      try {
        const result = await client.call<{
          keys?: Array<{ key: string; created_at?: string }>;
          vars?: Array<{ key: string; created_at?: string }>;
        }>('GET', '/env', undefined, { project_id: pid });

        if (opts.json) {
          printJson(result);
          return;
        }

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
    .command('pull')
    .description(
      'Write a local .env file listing the env vars this project expects (for ' +
        'the local-dev loop). Values are NOT included — the platform never ' +
        'returns secret values; fill them in for `somewhere dev`.',
    )
    .option('--project <id>', 'Project ID')
    .option('--out <file>', 'Output path', '.env')
    .option('--force', 'Overwrite the file without prompting')
    .option('--json', 'Print the raw env response as JSON')
    .action(async (opts) => {
      const client = new ApiClient(getToken());
      const pid = resolveProjectId(opts.project);
      let keys: Array<{ key: string; scope?: string }>;
      let result: {
        keys?: Array<{ key: string; scope?: string }>;
        vars?: Array<{ key: string; scope?: string }>;
      };
      try {
        result = await client.call<{
          keys?: Array<{ key: string; scope?: string }>;
          vars?: Array<{ key: string; scope?: string }>;
        }>('GET', '/env', undefined, { project_id: pid });
        keys = result.keys ?? result.vars ?? [];
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (!keys.length) {
        if (opts.json) {
          printJson(result);
          return;
        }
        info(dim('No environment variables set for this project — nothing to pull.'));
        return;
      }

      const outPath = resolve(process.cwd(), String(opts.out));
      if (existsSync(outPath) && !opts.force && opts.json) {
        error(`${opts.out} exists. Pass --force to overwrite in --json mode.`);
        process.exit(1);
      }
      if (existsSync(outPath) && !opts.force) {
        const existing = readFileSync(outPath, 'utf-8');
        const hasValues = existing
          .split('\n')
          .some((l) => /^[^#=]+=.+/.test(l.trim()));
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: hasValues
            ? `${opts.out} exists and has values set. Overwrite (you'll lose those values)?`
            : `${opts.out} exists. Overwrite?`,
          initial: !hasValues,
        });
        if (!ok) {
          warn('Aborted — existing file left untouched.');
          return;
        }
      }

      writeFileSync(outPath, buildEnvTemplate(keys, { projectId: pid }));
      if (opts.json) {
        printJson(result);
        return;
      }
      success(`Wrote ${keys.length} key${keys.length === 1 ? '' : 's'} to ${teal(opts.out)} (values blank — fill them in for local runs)`);
    });

  env
    .command('set <key> <value>')
    .description('Set an environment variable')
    .option('--project <id>', 'Project ID')
    .option('--json', 'Print the raw env response as JSON')
    .action(async (key: string, value: string, opts) => {
      const client = new ApiClient(getToken());
      const pid = resolveProjectId(opts.project);
      try {
        const result = await client.call('POST', '/env', {
          project_id: pid,
          key,
          value,
        });
        if (opts.json) {
          printJson(result);
          return;
        }
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
    .option('--json', 'Print the raw env response as JSON')
    .action(async (key: string, opts) => {
      const client = new ApiClient(getToken());
      const pid = resolveProjectId(opts.project);
      try {
        const result = await client.call(
          'DELETE',
          `/env/${encodeURIComponent(pid)}/${encodeURIComponent(key)}`,
        );
        if (opts.json) {
          printJson(result);
          return;
        }
        success(`${key} deleted`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
