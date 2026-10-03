import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import prompts from 'prompts';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { buildEnvTemplate } from '../lib/envfile-write.js';
import { dim, error, info, printJson, success, teal, warn } from '../lib/output.js';
import type { EnvKey, EnvScope, EnvSetResult } from '../types.js';

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
        const result = await client.call<{ keys?: EnvKey[]; vars?: EnvKey[] }>('GET', '/env', undefined, { project_id: pid });

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
          console.log(`  ${teal(v.key)}  ${dim(`${v.scope ?? 'all'} · ${v.visibility === 'public' ? 'public' : 'server-only'}`)}`);
          if (v.provider || v.purpose) info(dim([v.provider, v.purpose].filter(Boolean).join(' · ')));
          if (v.server_reference) info(`Server: ${v.server_reference}`);
          if (v.browser_reference) info(`Browser: ${v.browser_reference}`);
          if (v.browser_guidance) info(dim(v.browser_guidance));
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err), err);
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
        error(err instanceof Error ? err.message : String(err), err);
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
    .command('set <key> [value]')
    .description('Set an environment value; use --stdin to keep it out of shell history')
    .option('--project <id>', 'Project ID')
    .option('--stdin', 'Read the value from stdin (removes one final line ending)')
    .option('--public', 'Explicitly allow browser exposure for a VITE_/REACT_APP_ name')
    .option('--private', 'Keep this value server-only')
    .option('--scope <scope>', 'Environment: all, dev, or prod (default: all)')
    .option('--provider <name>', 'Optional provider label (max 64 characters)')
    .option('--purpose <text>', 'Optional purpose description (max 240 characters)')
    .option('--json', 'Print the raw env response as JSON')
    .action(async (key: string, positionalValue: string | undefined, opts: {
      project?: string; stdin?: boolean; public?: boolean; private?: boolean;
      scope?: string; provider?: string; purpose?: string; json?: boolean;
    }) => {
      if (opts.public && opts.private) {
        error('--public and --private cannot be used together.');
        process.exit(1);
      }
      if (opts.stdin && positionalValue !== undefined) {
        error('Pass either a positional value or --stdin, not both.');
        process.exit(1);
      }
      if (!opts.stdin && positionalValue === undefined) {
        error('Pass a value or use --stdin.');
        process.exit(1);
      }
      if (opts.stdin && process.stdin.isTTY) {
        error('Pipe a value into --stdin.');
        process.exit(1);
      }
      if (opts.scope && !['all', 'dev', 'prod'].includes(opts.scope)) {
        error('--scope must be all, dev, or prod.');
        process.exit(1);
      }
      if (opts.provider && opts.provider.length > 64) {
        error('--provider must be at most 64 characters.');
        process.exit(1);
      }
      if (opts.purpose && opts.purpose.length > 240) {
        error('--purpose must be at most 240 characters.');
        process.exit(1);
      }
      const value = opts.stdin ? readFileSync(0, 'utf8').replace(/\r?\n$/, '') : positionalValue!;
      const client = new ApiClient(getToken());
      const pid = resolveProjectId(opts.project);
      try {
        const result = await client.call<EnvSetResult>('POST', '/env', {
          project_id: pid,
          key,
          value,
          ...(opts.scope ? { scope: opts.scope as EnvScope } : {}),
          ...(opts.public ? { public: true } : {}),
          ...(opts.private ? { public: false } : {}),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        // The platform does not say whether the key already existed, so "set"
        // is the word that is true either way.
        success(`${key} set${result.visibility ? ` (${result.visibility === 'public' ? 'public' : 'server-only'}, ${result.scope})` : ''}`);
        if (result.server_reference) info(`Server: ${result.server_reference}`);
        if (result.browser_reference) info(`Browser: ${result.browser_reference}`);
        if (result.browser_guidance) info(dim(result.browser_guidance));
        if (result.requires_deploy) info(dim('This value reaches your app on its next deploy.'));
        const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
        for (const w of warnings) if (typeof w === 'string') warn(w);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err), err);
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
        error(err instanceof Error ? err.message : String(err), err);
        process.exit(1);
      }
    });
}
