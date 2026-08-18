import { Command } from 'commander';
import { basename, resolve } from 'node:path';
import prompts from 'prompts';
import ora, { type Ora } from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { isBuildError, renderBuildError } from '../lib/build-errors.js';
import {
  getToken,
  loadConfig,
  loadProjectConfigEntry,
  projectConfigMatchesRef,
  readProjectDeployState,
  saveConfig,
  saveProjectConfig,
  saveProjectDeployState,
  type ProjectConfigEntry,
} from '../lib/config.js';
import { collectFiles, formatBytes } from '../lib/files.js';
import { mintTempAccount } from '../lib/temp-auth.js';
import { dim, error, green, info, printJson, printJsonError, red, success, teal, warn, yellow } from '../lib/output.js';
import type { CliConfig, ProjectConfig } from '../types.js';
import { showProjectNotices } from '../lib/project-notices.js';

// Resolve the deploy target directory. `resolve` (not `join`) so an absolute
// `dir` is honored as-is — `join(cwd, '/abs/path')` produced `/cwd/abs/path`
// → ENOENT (tsk_c616fe5d). `resolve` also normalizes `..` segments.
export function resolveTargetDir(dir?: string, cwd = process.cwd()): string {
  return dir ? resolve(cwd, dir) : cwd;
}

// `--prebuilt` (alias `--allow-bundled`) opts the deploy out of the
// raw-source contract: the worker's bundled-deploy guard keeps pre-built /
// bundled output as-is instead of rejecting it. We surface it as
// `allow_bundled: true` in the deploy body (the field the worker already
// reads). Returns true only when a flag was passed, so a normal deploy never
// sends the field — raw source stays the default.
export function prebuiltOptIn(opts: {
  prebuilt?: boolean;
  allowBundled?: boolean;
}): boolean {
  return Boolean(opts.prebuilt || opts.allowBundled);
}

// Node-server pre-flight (tsk_8e8c6bc8): the #1 first-deploy failure is an
// agent shipping an Express/Fastify app — it deploys "successfully" as dead
// static files (routes never run, server source publicly served). Detect the
// shape BEFORE upload and teach the platform shape. Warning only, never a
// block (rule 9): a static site that happens to carry a local dev server
// script must still deploy clean — hence the requirement that functions/ is
// EMPTY and the server signal is unambiguous.
const SERVER_FRAMEWORK_DEPS = ['express', 'fastify', 'koa', '@nestjs/core', '@hapi/hapi', 'restify'];
const SERVER_CODE_PATTERN = /\bapp\.listen\s*\(|\bhttp\.createServer\s*\(|\bfastify\s*\(\s*\)|new\s+Koa\s*\(/;
const NEXT_APP_SIGNAL_PREFIX = 'Next.js app';
const NEXT_CONFIG_PATTERN = /^next\.config\.(js|ts|mjs)$/;
const NEXT_ROUTER_FILE_PATTERN =
  /^(?:src\/)?(?:app\/(?:.*\/)?(?:page|layout|route|loading|error|not-found)\.(?:js|jsx|ts|tsx|mdx)|pages\/.+\.(?:js|jsx|ts|tsx|mdx))$/;
const NEXT_APP_WARNING =
  "somewhere.tech serves static files + serverless functions, not SSR — Next.js apps don't run here. " +
  'Port API routes to functions/ handlers, or start from a Vite React app; the platform compiles raw JSX/TSX on deploy.';
const DEPLOY_HEARTBEAT_MS = 30_000;
const DEPLOY_MAX_ATTEMPTS = 2;
const RETRYABLE_DEPLOY_CODES = new Set(['TIMEOUT', 'SERVER_SLOW', 'NETWORK_ERROR']);

export function isNextAppShapeSignal(signal: string): boolean {
  return signal.startsWith(`${NEXT_APP_SIGNAL_PREFIX} (`);
}

function detectNextAppShape(files: Record<string, string>): string | null {
  const pkgRaw = files['package.json'];
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.dependencies?.next || pkg.devDependencies?.next) {
        return `${NEXT_APP_SIGNAL_PREFIX} (package.json depends on "next")`;
      }
    } catch {
      /* unparseable package.json is someone else's problem */
    }
  }

  for (const path of Object.keys(files)) {
    if (NEXT_CONFIG_PATTERN.test(path)) return `${NEXT_APP_SIGNAL_PREFIX} (${path})`;
    if (NEXT_ROUTER_FILE_PATTERN.test(path)) return `${NEXT_APP_SIGNAL_PREFIX} (${path} router file)`;
  }

  return null;
}

export function detectNodeServerShape(
  files: Record<string, string>,
  functions: Record<string, string>,
): string | null {
  const nextSignal = detectNextAppShape(files);
  if (nextSignal) return nextSignal;

  if (Object.keys(functions).length > 0) return null; // has real functions — trust it
  const pkgRaw = files['package.json'];
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string> };
      const hit = SERVER_FRAMEWORK_DEPS.find((d) => pkg.dependencies?.[d]);
      if (hit) return `package.json depends on "${hit}"`;
    } catch {
      /* unparseable package.json is someone else's problem */
    }
  }
  for (const [path, content] of Object.entries(files)) {
    // Root-level entry files only — a vendored lib deep in the tree isn't a signal.
    if (!/^[^/]+\.(js|mjs|cjs|ts)$/.test(path)) continue;
    if (SERVER_CODE_PATTERN.test(content)) return `${path} starts a server (app.listen/createServer)`;
  }
  return null;
}

// --temporary auto-creates a project (no `somewhere init` to run without an
// account): name/subdomain both derive from the target dir's basename,
// slugified, plus a random suffix so a common dir name (e.g. "app") doesn't
// collide with someone else's temp project on a shared subdomain namespace.
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

export function deriveTempProjectName(dirPath: string): string {
  const base = slugify(basename(dirPath)) || 'project';
  return `${base}-${randomSuffix()}`;
}

// The first-mint claim-relay block derives its "N hours" from the server's
// ttl_seconds (10800 → 3). Reused sessions with no saved expiry (old configs)
// still fall back here instead of crashing.
export function formatTtlHours(ttlSeconds?: number): number {
  if (!ttlSeconds || !Number.isFinite(ttlSeconds)) return 3;
  return Math.round(ttlSeconds / 3600) || 3;
}

export function formatRemainingTempTime(expiresAt: string, nowMs = Date.now()): string | null {
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return null;

  const totalMinutes = Math.max(0, Math.ceil((expiresMs - nowMs) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function formatElapsed(at: string | undefined, nowMs = Date.now()): string {
  if (!at) return '';
  const then = new Date(at).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.floor((nowMs - then) / 60_000));
  if (minutes < 1) return ' just now';
  if (minutes < 60) return ` ${plural(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ` ${plural(hours, 'hour')} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return ` ${plural(days, 'day')} ago`;
  const months = Math.floor(days / 30);
  return ` ${plural(months, 'month')} ago`;
}

function formatChangeSource(source: string | undefined): string {
  const normalized = source?.trim().toLowerCase();
  if (!normalized) return '';
  if (['dashboard', 'dashboard-editor', 'editor', 'visual-editor'].includes(normalized)) {
    return ' via the dashboard editor';
  }
  if (['cli', 'somewhere-cli', 'command-line'].includes(normalized)) return ' via the CLI';
  if (['mcp', 'agent', 'mcp-agent', 'codex', 'claude'].includes(normalized)) return ' via an MCP agent';
  if (['api', 'public-api', 'rest-api', 'worker', 'd1', 'system', 'internal', 'cron'].includes(normalized)) {
    return ' via the platform';
  }
  return ' via the platform';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export interface StaleBaseDetails {
  current_version?: number;
  base_version?: number;
  changed_files: string[];
  last_change_source?: string;
  last_change_at?: string;
}

export function readStaleBaseDetails(data?: Record<string, unknown>): StaleBaseDetails {
  const current = data?.current_version;
  const base = data?.base_version;
  return {
    current_version: typeof current === 'number' ? current : undefined,
    base_version: typeof base === 'number' ? base : undefined,
    changed_files: readStringList(data?.changed_files),
    last_change_source: readString(data?.last_change_source),
    last_change_at: readString(data?.last_change_at),
  };
}

export function formatStaleBaseExplanation(
  details: StaleBaseDetails,
  nowMs = Date.now(),
): string {
  const files = details.changed_files;
  const source = formatChangeSource(details.last_change_source);
  const elapsed = formatElapsed(details.last_change_at, nowMs);
  const fileList = files.slice(0, 10).join(', ');
  const more = files.length > 10 ? `, and ${files.length - 10} more` : '';
  const changeSummary = files.length > 0
    ? `${plural(files.length, 'file')} edited${source}${elapsed}: ${fileList}${more}`
    : `remote edits${source}${elapsed}`;
  const versionSummary =
    details.current_version !== undefined && details.base_version !== undefined
      ? `Remote is now v${details.current_version}; this machine last deployed v${details.base_version}.`
      : null;

  return [
    `This project changed since your last deploy from this machine — ${changeSummary}. Your deploy was NOT applied.`,
    versionSummary,
    '',
    'Next steps:',
    '  Run `somewhere pull` to bring the latest deployed source into this directory, review it, then deploy again.',
    '  Run `somewhere deploy --force` to overwrite those remote changes intentionally.',
  ].filter((line): line is string => line !== null).join('\n');
}

// The release-native staleness guard. Unlike STALE_BASE, the server's
// STALE_RELEASE_BASE envelope carries only the declared vs. live release ids —
// no file/version diff — so instead of inventing a change summary we point the
// user at the tools that show the actual diff. This is the guard that fires on
// the live path when a dashboard/MCP/agent edit landed after the last CLI
// deploy (tsk_5e729c8): base_version alone does not protect it.
export function formatStaleReleaseBaseExplanation(): string {
  return [
    'This project changed since your last deploy from this machine — another publish landed first (via the dashboard, an MCP agent, or another machine). Your deploy was NOT applied.',
    '',
    'Next steps:',
    '  Run `somewhere deploy --dry-run` to see exactly what differs, or `somewhere pull` to bring the latest deployed source into this directory, then deploy again.',
    '  Run `somewhere deploy --force` to overwrite those remote changes intentionally.',
  ].join('\n');
}

function findProjectConfigEntry(targetDir: string): ProjectConfigEntry | null {
  const targetEntry = loadProjectConfigEntry(targetDir);
  if (targetEntry) return targetEntry;
  if (targetDir === process.cwd()) return null;
  return loadProjectConfigEntry();
}

function hasReusableTempCredential(
  config: CliConfig | null,
  nowMs = Date.now(),
): config is CliConfig & { temporary: true } {
  if (!config?.token || !config.temporary) return false;
  if (!config.temp_expires_at) return true;

  const expiresMs = new Date(config.temp_expires_at).getTime();
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

interface TempSession {
  claimUrl: string;
  ttlSeconds?: number;
  expiresAt?: string;
  reused: boolean;
}

export function registerDeploy(program: Command) {
  program
    .command('deploy [dir]')
    .description('Deploy the current directory (anonymous automatically when logged out)')
    .option(
      '--project <ref>',
      'Project to deploy to — accepts the project UUID, slug, or subdomain (all three resolve server-side)',
    )
    .option(
      '--scope <scope>',
      "Partial deploy: 'functions' (backend only, leaves the site untouched) or 'static' (site only, leaves functions untouched). Default deploys both.",
    )
    .option(
      '--dry-run',
      'Show what would change (added / modified / removed files) without deploying',
    )
    .option(
      '--replace-functions',
      'Delete deployed functions that are not in this directory (repo-as-truth). Default keeps them.',
    )
    .option(
      '--prebuilt',
      'Deploy pre-built / bundled output (e.g. a dist/ folder) instead of raw source. ' +
        'Raw source is the default and recommended path: the platform compiles your TSX/JSX/TS ' +
        'on deploy, which keeps the app editable end-to-end. Choosing --prebuilt trades that away — ' +
        'pull/export round-trips, find/replace patches, and visual (source-map) editing are disabled ' +
        'for the bundled files. Use it only when you need full control of your own build.',
    )
    .option(
      '--allow-bundled',
      'Alias for --prebuilt.',
    )
    .option(
      '--temporary',
      'Explicitly deploy to a temporary 3-hour workspace (automatic when logged out)',
    )
    .option(
      '--force',
      'Overwrite remote changes even when this machine last deployed an older version',
    )
    .option('--yes', 'Skip confirmation prompts (for --force)')
    .option('--json', 'Print the raw deploy response as JSON')
    .action(async (dir: string | undefined, opts) => {
      const targetDir = resolveTargetDir(dir);
      const storedConfig = loadConfig();

      // Anonymous deploy is the default first-touch path. A caller with no
      // saved credential should get a live app from `somewhere deploy`, not a
      // successful no-op that asks them to discover and rerun a hidden flag.
      // Stored temporary sessions follow the same path so every redeploy keeps
      // relaying its claim URL and expiry without requiring --temporary again.
      const useTemporary = Boolean(
        opts.temporary || !storedConfig?.token || storedConfig.temporary,
      );

      // Resolved below: present only for a temp (minted or reused) session,
      // never for a normal login — gates both project auto-create and the
      // claim-relay success block.
      let tempSession: TempSession | undefined;

      let token: string;
      if (useTemporary) {
        if (storedConfig?.token && !storedConfig.temporary) {
          // Already have a real account — --temporary would be a downgrade,
          // so ignore it rather than silently minting a throwaway workspace
          // next to the dev's own projects.
          if (!opts.json) info('Already logged in — deploying to your account.');
          token = getToken();
        } else if (hasReusableTempCredential(storedConfig)) {
          // Reuse silently — this is the "one credential across shells"
          // requirement: a second `--temporary` deploy in the same 3h window
          // (a different terminal, a re-run) must not mint a second project.
          token = storedConfig.token;
          tempSession = {
            claimUrl: storedConfig.claim_url ?? '',
            expiresAt: storedConfig.temp_expires_at,
            reused: true,
          };
        } else {
          const powSpinner = opts.json ? null : ora('Solving proof-of-work…').start();
          try {
            const account = await mintTempAccount();
            powSpinner?.stop();
            saveConfig({
              token: account.key,
              temporary: true,
              temp_expires_at: account.expires_at,
              claim_url: account.claim_url,
              user: { email: '', username: '' },
            });
            token = account.key;
            tempSession = {
              claimUrl: account.claim_url,
              ttlSeconds: account.ttl_seconds,
              expiresAt: account.expires_at,
              reused: false,
            };
          } catch (err) {
            powSpinner?.fail('Could not create a temporary session');
            error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
        }
      } else {
        token = getToken();
      }

      const client = new ApiClient(token);

      // --scope maps to the worker's partial-deploy guard. Reject unknown
      // values up front so a typo can't silently fall back to a full deploy
      // (e.g. `--scope function` wiping the frontend the user meant to keep).
      let scope: 'functions' | 'static' | undefined;
      if (opts.scope !== undefined) {
        if (opts.scope !== 'functions' && opts.scope !== 'static') {
          error(`--scope must be "functions" or "static" (got "${opts.scope}")`);
          process.exit(1);
        }
        scope = opts.scope;
      }

      const linkedProjectEntry = findProjectConfigEntry(targetDir);
      let targetProjectConfig = linkedProjectEntry?.config;
      let deployStateEntry: ProjectConfigEntry | null = null;
      let projectId = opts.project as string | undefined;
      if (!projectId) {
        if (linkedProjectEntry) {
          projectId = linkedProjectEntry.config.project_id;
          deployStateEntry = linkedProjectEntry;
        } else if (tempSession) {
          // No `.somewhere.json` and no account to run `somewhere init` —
          // auto-create the project so a temp deploy is a single command.
          const createSpinner = opts.json ? null : ora('Creating a temporary project...').start();
          try {
            const name = deriveTempProjectName(targetDir);
            const created = await client.call<{ id: string; name: string; subdomain: string }>(
              'POST',
              '/projects',
              { name, subdomain: name },
            );
            createSpinner?.stop();
            targetProjectConfig = {
              project_id: created.id,
              name: created.name,
              subdomain: created.subdomain ?? name,
            };
            saveProjectConfig(targetDir, targetProjectConfig);
            projectId = created.id;
          } catch (err) {
            createSpinner?.fail('Could not create a temporary project');
            error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
        } else {
          error(
            'No project linked. Run `somewhere init` or pass --project <id>',
          );
          process.exit(1);
        }
      } else if (linkedProjectEntry && projectConfigMatchesRef(linkedProjectEntry.config, projectId)) {
        deployStateEntry = linkedProjectEntry;
      }

      await showProjectNotices(client, projectId);

      if (opts.force && !opts.yes) {
        if (!process.stdin.isTTY) {
          const message = 'Refusing to force deploy without confirmation in a non-interactive shell. Run `somewhere deploy --force --yes` to overwrite remote changes intentionally.';
          if (opts.json) {
            printJsonError('CONFIRMATION_REQUIRED', message);
          } else {
            error(message);
          }
          process.exit(1);
        }
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Overwrite remote changes for ${teal(projectId)}? This discards edits made outside this machine.`,
          initial: false,
          stdout: opts.json ? process.stderr : undefined,
        });
        if (!ok) {
          if (opts.json) {
            printJsonError('ABORTED', 'Aborted.');
            process.exit(1);
          }
          warn('Aborted.');
          process.exit(1);
        }
      }

      const spinner = opts.json ? null : ora('Collecting files...').start();

      const { files, binaryFiles, functions, skipped } = collectFiles(targetDir);

      // A deploy replaces the whole project, so a file we skip is DELETED from
      // production if it was there before. Never silent — surface every skip.
      if (skipped.length && !opts.json) {
        spinner?.stop();
        warn(
          `${skipped.length} file(s) will NOT be uploaded — a deploy is a full ` +
            `replacement, so any already deployed will be REMOVED from production:`,
        );
        for (const s of skipped) warn(`  ${dim('•')} ${s.path} — ${s.reason}`);
        spinner?.start();
      }

      // Node-server pre-flight (tsk_8e8c6bc8) — see detectNodeServerShape.
      const serverSignal = detectNodeServerShape(files, functions);
      if (serverSignal && !opts.json) {
        spinner?.stop();
        if (isNextAppShapeSignal(serverSignal)) {
          warn(NEXT_APP_WARNING);
        } else {
          warn(`This looks like a Node server app (${serverSignal}) — somewhere.tech does not run server processes.`);
          warn('It will deploy as static files only: your routes will NOT run, and the');
          warn('server source will be publicly readable at its file path.');
          warn('The platform shape: static files at the root + API handlers under functions/');
          warn('(each default-exports async (req, sw) and becomes a route).');
          warn('Full quickstart: somewhere docs start');
        }
        spinner?.start();
      }

      const totalFiles =
        Object.keys(files).length +
        Object.keys(binaryFiles).length +
        Object.keys(functions).length;
      const textBytes = Object.values(files)
        .concat(Object.values(functions))
        .reduce((sum, c) => sum + c.length, 0);
      const binaryBytes = Object.values(binaryFiles)
        .reduce((sum, b64) => sum + Math.floor((b64.length * 3) / 4), 0);
      const totalBytes = textBytes + binaryBytes;

      if (spinner) {
        spinner.text = opts.dryRun
          ? `Checking ${totalFiles} files (${formatBytes(totalBytes)})...`
          : `Deploying ${totalFiles} files (${formatBytes(totalBytes)})...`;
      }

      try {
        const body: Record<string, unknown> = {
          project_id: projectId,
          // --scope functions deploys ONLY the backend: send no static at all
          // (an empty object, NOT omitted — the worker requires a files map).
          // Sending the on-disk static under scope:functions is what bricked
          // compiled SPAs (tsk_08cff5f4); the worker now ignores it too, but
          // the CLI shouldn't send it in the first place. --scope static is the
          // inverse: no functions.
          files: scope === 'functions' ? {} : files,
        };
        if (scope !== 'functions' && Object.keys(binaryFiles).length > 0) {
          body.binary_files = binaryFiles;
        }
        if (scope !== 'static' && Object.keys(functions).length > 0) {
          body.functions = functions;
        }
        if (scope) body.scope = scope;
        if (opts.replaceFunctions) body.replace_functions = true;
        if (opts.dryRun) body.dry_run = true;
        // --prebuilt (alias --allow-bundled) opts out of the raw-source
        // contract: the deploy keeps pre-built / bundled output as-is instead
        // of being rejected by the bundled-deploy guard. Omitted entirely when
        // not set so a normal deploy stays the raw-source default.
        const prebuilt = prebuiltOptIn(opts);
        if (prebuilt) body.allow_bundled = true;
        const deployState =
          !tempSession && !opts.dryRun && deployStateEntry
            ? readProjectDeployState(deployStateEntry.config, deployStateEntry.config.project_id)
            : null;
        if (deployState) {
          body.base_version = deployState.last_deployed_version;
          body.source = 'cli';
          // The release-native path enforces staleness via base_release_id
          // (STALE_RELEASE_BASE), not base_version — so anchor on the release we
          // last put live. Omitted under --force: the server also refuses a
          // stale base_release_id when force is set, so the only way to
          // intentionally overwrite is to NOT declare a base (the server then
          // auto-adopts the current active release).
          if (!opts.force && typeof deployState.release_id === 'string' && deployState.release_id) {
            body.base_release_id = deployState.release_id;
          }
        }
        if (opts.force) {
          body.force = true;
          if (!tempSession) body.source = 'cli';
        }

        if (opts.dryRun) {
          const plan = await callDeployWithRetry<DryRunResult>(client, body, {
            spinner,
            json: Boolean(opts.json),
            dryRun: true,
            baseText: spinner?.text ?? 'Checking deploy...',
          });
          spinner?.stop();
          if (opts.json) {
            printJson(plan);
          } else {
            printDryRun(plan, scope);
          }
          return;
        }

        const result = await callDeployWithRetry<DeployResult>(client, body, {
          spinner,
          json: Boolean(opts.json),
          dryRun: false,
          baseText: spinner?.text ?? 'Deploying...',
        });

        spinner?.stop();
        const functionErrors = result.function_errors ?? [];
        const hasFunctionErrors = functionErrors.length > 0;
        const formatted = formatDeploySuccess(result, {
          scope,
          functionCount: Object.keys(functions).length,
          totalBytes,
          linkedProject: targetProjectConfig,
        });
        if (opts.json) {
          if (tempSession) {
            printJson({
              url: formatted.liveUrl,
              claim_url: tempSession.claimUrl,
              expires_at: tempSession.expiresAt ?? null,
            });
          } else {
            printJson(result);
          }
          if (hasFunctionErrors) {
            process.exit(1);
          }
          if (!tempSession && typeof result.version === 'number' && deployStateEntry) {
            saveProjectDeployState(
              deployStateEntry.dir,
              deployStateEntry.config.project_id,
              result.version,
              result.active_release_id ?? result.release_id,
            );
          }
          return;
        }

        // ONE scope-consistent headline — report only the layer this deploy
        // actually touched, so it never claims "Functions deployed" on a
        // static-only deploy or counts static files on a backend-only deploy
        // (audit #3: the old output printed "Functions deployed" + a static
        // count + "the other layer was left untouched" all at once).
        success(formatted.headline);

        // Build log: entry chunk, chunks + sizes, functions + sizes (returned
        // by the worker since tsk_8af76ef9). Surface it instead of a bare
        // "deployed." so the dev can see what the compiler actually produced.
        if (Array.isArray(result.build_log) && result.build_log.length > 0) {
          console.log(`\n${dim('Build')}`);
          for (const line of result.build_log) info(dim(line));
          console.log('');
        }

        // Functions that were preserved because this payload omitted them.
        // Loud, not buried — the dev should know files weren't dropped.
        if (result.preserved_functions && result.preserved_functions.length > 0) {
          warn(
            `Kept ${result.preserved_functions.length} function(s) not in this directory: ${result.preserved_functions.slice(0, 5).join(', ')}${result.preserved_functions.length > 5 ? ', …' : ''} (pass --replace-functions to drop them).`,
          );
        }

        // Warnings + function errors must be loud — never let a "success"
        // line hide a partial failure (fail-loudly principle).
        if (hasFunctionErrors) {
          for (const fe of functionErrors) {
            const label = typeof fe === 'string' ? fe : (fe.route ?? JSON.stringify(fe));
            const detail = typeof fe === 'string' ? '' : fe.error ? ` — ${fe.error}` : '';
            error(`Function failed: ${label}${detail}`);
          }
        }
        if (result.warnings && result.warnings.length > 0) {
          const buildWarnings = warningsInBuildLog(result.build_log);
          for (const w of result.warnings) {
            if (!buildWarnings.has(normalizeWarning(w))) warn(w);
          }
        }
        if (result.runtime_fixes && result.runtime_fixes.length > 0) {
          for (const fix of result.runtime_fixes) success(fix.message);
        }

        if (tempSession) {
          // Every anonymous deploy ends with stable, machine-scannable labels.
          // The absolute server expiry avoids making a reused credential look
          // like it received a fresh three-hour window.
          const remaining = tempSession.reused && tempSession.expiresAt
            ? formatRemainingTempTime(tempSession.expiresAt)
            : null;
          if (formatted.liveUrl) {
            success(`Live URL: ${teal(formatted.liveUrl)}`);
          } else {
            info('Live URL unavailable — check the dashboard.');
          }
          info(`Claim URL: ${teal(tempSession.claimUrl)}`);
          if (tempSession.expiresAt) {
            info(`Expires at: ${tempSession.expiresAt}${remaining ? ` (${remaining} remaining)` : ''}`);
          } else {
            const hours = formatTtlHours(tempSession.ttlSeconds);
            info(`Expires: about ${hours} hour${hours === 1 ? '' : 's'} after the temporary session was created`);
          }
          info(`Next step: ${teal('somewhere login')} to keep it.`);
        } else {
          if (formatted.liveUrl) {
            success(`Live at ${teal(formatted.liveUrl)}`);
          } else {
            success(formatted.liveMessage);
          }
        }

        // Remind the dev of the round-trip trade-off they opted into. Raw
        // source stays editable end-to-end; bundled files do not — pull/export
        // round-trips, find/replace patches, and visual editing are disabled
        // for them.
        if (prebuilt) {
          warn(
            'Prebuilt deploy — source round-trip (pull / export / patch / visual edit) is disabled for the bundled files.',
          );
        }

        // Exit non-zero if any function failed to deploy — a CI step that
        // shells out to `somewhere deploy` should fail, not pass green.
        if (hasFunctionErrors) {
          process.exit(1);
        }
        if (!tempSession && typeof result.version === 'number' && deployStateEntry) {
          saveProjectDeployState(
            deployStateEntry.dir,
            deployStateEntry.config.project_id,
            result.version,
            result.active_release_id ?? result.release_id,
          );
        }
      } catch (err) {
        if (
          err instanceof CliApiError &&
          (err.code === 'STALE_BASE' || err.code === 'STALE_RELEASE_BASE')
        ) {
          spinner?.stop();
          const message =
            err.code === 'STALE_RELEASE_BASE'
              ? formatStaleReleaseBaseExplanation()
              : formatStaleBaseExplanation(readStaleBaseDetails(err.data));
          if (opts.json) {
            printJson({ ok: false, error: err.code, message, ...(err.data ?? {}) });
          } else {
            console.error(message);
          }
          process.exit(1);
        }
        spinner?.fail(opts.dryRun ? 'Dry run failed' : 'Deploy failed');
        // Structured build failures get the full treatment: file:line
        // heading + a code frame rebuilt from the local source (we have the
        // files the server compiled — this is where the CLI beats a remote
        // log dump).
        if (!opts.json && isBuildError(err) && renderBuildError(err, targetDir)) {
          process.exit(1);
        }
        // Always show the error code + HTTP status — "Project not found"
        // with no code/status left a customer unable to tell auth from
        // routing from payload failures (pfb_70e9d140c5a0).
        if (err instanceof CliApiError) {
          if (opts.json) {
            printJsonError(err.code, err.message);
          } else {
            error(
              `${err.message} ${dim(err.statusCode ? `[${err.code}, HTTP ${err.statusCode}]` : `[${err.code}]`)}`,
            );
          }
        } else {
          error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }
    });
}

export interface DeployResult {
  project_id?: string;
  version?: number;
  release_id?: string;
  active_release_id?: string;
  base_release_id?: string | null;
  files_deployed?: number;
  files?: string[] | number;
  url?: string;
  has_functions: boolean;
  build_log?: string[];
  warnings?: string[];
  preserved_functions?: string[];
  function_errors?: Array<{ route?: string; error?: string } | string>;
  runtime_fixes?: Array<{ notice_id: string; title: string; message: string }>;
  status?: string;
  release_publish?: boolean;
}

interface DeploySuccessFormatOptions {
  scope?: 'functions' | 'static';
  functionCount: number;
  totalBytes: number;
  linkedProject?: Pick<ProjectConfig, 'project_id' | 'subdomain'>;
}

export interface FormattedDeploySuccess {
  staticFileCount: number | null;
  headline: string;
  liveUrl: string | null;
  liveMessage: string;
}

const PROJECT_SITE_DOMAIN = 'somewhere.site';

export function formatDeploySuccess(
  result: DeployResult,
  options: DeploySuccessFormatOptions,
): FormattedDeploySuccess {
  const staticFileCount =
    typeof result.files_deployed === 'number' && Number.isFinite(result.files_deployed)
      ? result.files_deployed
      : typeof result.files === 'number' && Number.isFinite(result.files)
        ? result.files
        : Array.isArray(result.files)
          ? result.files.length
          : null;
  const staticLabel =
    staticFileCount === null ? 'Static files' : `${staticFileCount} static file(s)`;

  let headline: string;
  if (options.scope === 'functions') {
    headline = `${options.functionCount} function(s) deployed — site left untouched`;
  } else if (options.scope === 'static') {
    headline =
      `${staticLabel} deployed (${formatBytes(options.totalBytes)}) — functions left untouched`;
  } else {
    const functionLabel =
      options.functionCount > 0 ? ` + ${options.functionCount} function(s)` : '';
    headline =
      `${staticLabel}${functionLabel} deployed (${formatBytes(options.totalBytes)})`;
  }

  const responseUrl =
    typeof result.url === 'string' && result.url.trim() ? result.url.trim() : null;
  const subdomain =
    result.project_id &&
      result.project_id === options.linkedProject?.project_id
      ? options.linkedProject.subdomain.trim()
      : null;
  const liveUrl = responseUrl ??
    (subdomain && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(subdomain)
      ? `https://${subdomain}.${PROJECT_SITE_DOMAIN}`
      : null);

  return {
    staticFileCount,
    headline,
    liveUrl,
    liveMessage: liveUrl
      ? `Live at ${liveUrl}`
      : 'Deployed — check the dashboard for the live URL.',
  };
}

function normalizeWarning(value: string): string {
  return value.replace(/^warning:\s*/i, '').trim();
}

function warningsInBuildLog(buildLog: string[] | undefined): Set<string> {
  const warnings = new Set<string>();
  for (const line of buildLog ?? []) {
    if (/^warning:\s*/i.test(line.trim())) warnings.add(normalizeWarning(line));
  }
  return warnings;
}

interface DryRunResult {
  current_version: number | null;
  static_files: {
    added: string[];
    modified: string[];
    removed: string[];
    added_count: number;
    modified_count: number;
    removed_count: number;
  };
  functions: {
    added: string[];
    removed: string[];
    modified: string[];
  } | null;
  warnings?: string[];
}

interface DeployRetryOptions {
  spinner: Ora | null;
  json: boolean;
  dryRun: boolean;
  baseText: string;
}

async function callDeployWithRetry<T>(
  client: ApiClient,
  body: Record<string, unknown>,
  opts: DeployRetryOptions,
): Promise<T> {
  for (let attempt = 1; attempt <= DEPLOY_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    const stopHeartbeat = startDeployHeartbeat(opts, attempt, startedAt);
    try {
      return await client.call<T>('POST', '/deploy', body, undefined, {
        timeoutMs: deployTimeoutMs(),
      });
    } catch (err) {
      if (attempt >= DEPLOY_MAX_ATTEMPTS) throw err;

      if (!isRetryableDeployError(err)) throw err;
      if (!opts.json) {
        opts.spinner?.stop();
        warn(
          `${opts.dryRun ? 'Deploy check' : 'Deploy'} ${retryReason(err)} after ${formatDeployElapsed(Date.now() - startedAt)}; retrying once.`,
        );
        opts.spinner?.start(`${opts.baseText} (retry 2/2)`);
      }
    } finally {
      stopHeartbeat();
    }
  }

  throw new CliApiError('DEPLOY_RETRY_EXHAUSTED', 'Deploy retry exhausted.', 0);
}

function deployTimeoutMs(): number {
  const raw = process.env.SOMEWHERE_DEPLOY_TIMEOUT_MS;
  if (!raw) return LONG_CALL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : LONG_CALL_TIMEOUT_MS;
}

function isRetryableDeployError(err: unknown): boolean {
  return err instanceof CliApiError && RETRYABLE_DEPLOY_CODES.has(err.code);
}

function retryReason(err: unknown): string {
  if (!(err instanceof CliApiError)) return 'failed';
  if (err.code === 'TIMEOUT') return 'timed out';
  if (err.code === 'SERVER_SLOW') return 'stalled waiting for the server';
  if (err.code === 'NETWORK_ERROR') return 'lost the connection';
  return 'failed';
}

function startDeployHeartbeat(
  opts: DeployRetryOptions,
  attempt: number,
  startedAt: number,
): () => void {
  if (opts.json) return () => {};

  const timer = setInterval(() => {
    const elapsed = formatDeployElapsed(Date.now() - startedAt);
    const retry = attempt > 1 ? ' (retry 2/2)' : '';
    if (process.stderr.isTTY && opts.spinner) {
      opts.spinner.text = `${opts.baseText}${retry} — still running after ${elapsed}`;
    } else {
      console.error(`${opts.dryRun ? 'Deploy check' : 'Deploy'} still running after ${elapsed}${retry}...`);
    }
  }, deployHeartbeatMs());

  return () => clearInterval(timer);
}

function deployHeartbeatMs(): number {
  const raw = process.env.SOMEWHERE_DEPLOY_HEARTBEAT_MS;
  if (!raw) return DEPLOY_HEARTBEAT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEPLOY_HEARTBEAT_MS;
}

function formatDeployElapsed(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

// Platform-generated slot artifacts. They live in the deployed slot but are
// never part of a user's source dir (the CLI collector never emits them and
// `somewhere pull` returns clean source), so the server's raw-vs-slot diff
// always reports them as "removed". Filtering them keeps the dry-run signal
// about the user's actual files — not platform internals it regenerates.
const INTERNAL_PREFIXES = ['_compiled/', '_internal/', '_source/'];
const isInternalPath = (p: string) =>
  INTERNAL_PREFIXES.some((prefix) => p.startsWith(prefix));

function printDryRun(plan: DryRunResult, scope?: 'functions' | 'static') {
  const scopeNote =
    scope === 'functions'
      ? ' (scope: functions — static unchanged)'
      : scope === 'static'
        ? ' (scope: static — functions unchanged)'
        : '';
  console.log(`\n${teal('Dry run')}${dim(scopeNote)} — nothing was deployed.\n`);

  const sf = {
    added: plan.static_files.added.filter((p) => !isInternalPath(p)),
    modified: plan.static_files.modified.filter((p) => !isInternalPath(p)),
    removed: plan.static_files.removed.filter((p) => !isInternalPath(p)),
  };
  const section = (label: string, items: string[], mark: string) => {
    if (items.length === 0) return;
    console.log(`  ${label} (${items.length})`);
    for (const p of items.slice(0, 50)) info(`${mark} ${p}`);
    if (items.length > 50) info(dim(`  …and ${items.length - 50} more`));
  };

  section(green('Added'), sf.added, green('+'));
  section(yellow('Modified'), sf.modified, yellow('~'));
  section(red('Removed'), sf.removed, red('-'));

  if (plan.functions) {
    const fn = plan.functions;
    section(green('Functions added'), fn.added, green('+'));
    section(yellow('Functions modified'), fn.modified, yellow('~'));
    section(red('Functions removed'), fn.removed, red('-'));
  }

  if (
    sf.added.length === 0 &&
    sf.modified.length === 0 &&
    sf.removed.length === 0 &&
    (!plan.functions ||
      (plan.functions.added.length === 0 &&
        plan.functions.modified.length === 0 &&
        plan.functions.removed.length === 0))
  ) {
    info(dim('No changes — local files match the deployed version.'));
  }

  // Re-derive the removal warning from the user-facing (filtered) diff so we
  // don't fire a scary "will REMOVE" line about platform internals, and don't
  // suppress a genuine removal of the user's own files.
  if (sf.removed.length > 0) {
    warn(
      `This deploy will REMOVE ${sf.removed.length} file(s): ${sf.removed.slice(0, 5).join(', ')}${sf.removed.length > 5 ? ', …' : ''}`,
    );
  }
  if (plan.functions && plan.functions.removed.length > 0) {
    warn(
      `This deploy will REMOVE ${plan.functions.removed.length} function(s): ${plan.functions.removed.slice(0, 5).join(', ')}${plan.functions.removed.length > 5 ? ', …' : ''}`,
    );
  }
  // Pass through any non-removal warnings the server flagged (e.g. version
  // conflict) — but skip the server's removal warnings, which we've already
  // re-derived above from the filtered diff.
  if (plan.warnings && plan.warnings.length > 0) {
    for (const w of plan.warnings) {
      if (/will REMOVE/i.test(w)) continue;
      warn(w);
    }
  }
  console.log('');
}
