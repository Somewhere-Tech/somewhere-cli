import { Command } from 'commander';
import { basename, resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { isBuildError, renderBuildError } from '../lib/build-errors.js';
import { getToken, loadConfig, loadProjectConfig, saveConfig, saveProjectConfig } from '../lib/config.js';
import { collectFiles, formatBytes } from '../lib/files.js';
import { mintTempAccount } from '../lib/temp-auth.js';
import { dim, error, green, info, red, success, teal, warn, yellow } from '../lib/output.js';

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
export function detectNodeServerShape(
  files: Record<string, string>,
  functions: Record<string, string>,
): string | null {
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

// The claim-relay block derives its "N hours" from the server's ttl_seconds
// (10800 → 3). Falls back to 3 when ttl_seconds is missing/non-finite — e.g.
// a silently-reused cached credential, where we only persisted temp_expires_at
// (an absolute timestamp), not the original ttl_seconds.
export function formatTtlHours(ttlSeconds?: number): number {
  if (!ttlSeconds || !Number.isFinite(ttlSeconds)) return 3;
  return Math.round(ttlSeconds / 3600) || 3;
}

export function registerDeploy(program: Command) {
  program
    .command('deploy [dir]')
    .description('Deploy the current directory to the linked project')
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
      'Deploy without an account — creates a temporary 3-hour workspace you can claim later',
    )
    .action(async (dir: string | undefined, opts) => {
      const targetDir = resolveTargetDir(dir);
      const storedConfig = loadConfig();

      // Discovery hint (tsk_35674c33): an agent/dev with no stored credential
      // and no --temporary gets pointed at the no-login path instead of the
      // old bare "Not logged in" exit. Plain console.log (no error styling,
      // no spinner) and exit 0 are BOTH deliberate — this isn't a failure,
      // it's how a first-time caller discovers --temporary exists. A non-zero
      // exit here would make CI/agent tooling treat "you could deploy without
      // an account" as a broken command.
      if (!storedConfig?.token && !opts.temporary) {
        console.log('No account found. To deploy without logging in, rerun with --temporary.');
        console.log('Everything you can run without an account: somewhere docs start');
        process.exit(0);
      }

      // Resolved below: present only for a temp (minted or reused) session,
      // never for a normal login — gates both project auto-create and the
      // claim-relay success block.
      let tempSession: { claimUrl: string; ttlSeconds?: number } | undefined;

      let token: string;
      if (opts.temporary) {
        if (storedConfig?.token && !storedConfig.temporary) {
          // Already have a real account — --temporary would be a downgrade,
          // so ignore it rather than silently minting a throwaway workspace
          // next to the dev's own projects.
          info('Already logged in — deploying to your account.');
          token = getToken();
        } else if (
          storedConfig?.token &&
          storedConfig.temporary &&
          storedConfig.temp_expires_at &&
          new Date(storedConfig.temp_expires_at).getTime() > Date.now()
        ) {
          // Reuse silently — this is the "one credential across shells"
          // requirement: a second `--temporary` deploy in the same 3h window
          // (a different terminal, a re-run) must not mint a second project.
          token = storedConfig.token;
          tempSession = { claimUrl: storedConfig.claim_url ?? '' };
        } else {
          const powSpinner = ora('Solving proof-of-work…').start();
          try {
            const account = await mintTempAccount();
            powSpinner.stop();
            saveConfig({
              token: account.key,
              temporary: true,
              temp_expires_at: account.expires_at,
              claim_url: account.claim_url,
              user: { email: '', username: '' },
            });
            token = account.key;
            tempSession = { claimUrl: account.claim_url, ttlSeconds: account.ttl_seconds };
          } catch (err) {
            powSpinner.fail('Could not create a temporary session');
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

      let projectId = opts.project;
      if (!projectId) {
        const projConfig = loadProjectConfig(targetDir) ?? loadProjectConfig();
        if (projConfig) {
          projectId = projConfig.project_id;
        } else if (tempSession) {
          // No `.somewhere.json` and no account to run `somewhere init` —
          // auto-create the project so a temp deploy is a single command.
          const createSpinner = ora('Creating a temporary project...').start();
          try {
            const name = deriveTempProjectName(targetDir);
            const created = await client.call<{ id: string; name: string; subdomain: string }>(
              'POST',
              '/projects',
              { name, subdomain: name },
            );
            createSpinner.stop();
            saveProjectConfig(targetDir, {
              project_id: created.id,
              name: created.name,
              subdomain: created.subdomain ?? name,
            });
            projectId = created.id;
          } catch (err) {
            createSpinner.fail('Could not create a temporary project');
            error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
        } else {
          error(
            'No project linked. Run `somewhere init` or pass --project <id>',
          );
          process.exit(1);
        }
      }

      const spinner = ora('Collecting files...').start();

      const { files, binaryFiles, functions, skipped } = collectFiles(targetDir);

      // A deploy replaces the whole project, so a file we skip is DELETED from
      // production if it was there before. Never silent — surface every skip.
      if (skipped.length) {
        spinner.stop();
        warn(
          `${skipped.length} file(s) will NOT be uploaded — a deploy is a full ` +
            `replacement, so any already deployed will be REMOVED from production:`,
        );
        for (const s of skipped) warn(`  ${dim('•')} ${s.path} — ${s.reason}`);
        spinner.start();
      }

      // Node-server pre-flight (tsk_8e8c6bc8) — see detectNodeServerShape.
      const serverSignal = detectNodeServerShape(files, functions);
      if (serverSignal) {
        spinner.stop();
        warn(`This looks like a Node server app (${serverSignal}) — somewhere.tech does not run server processes.`);
        warn('It will deploy as static files only: your routes will NOT run, and the');
        warn('server source will be publicly readable at its file path.');
        warn('The platform shape: static files at the root + API handlers under functions/');
        warn('(each default-exports async (req, sw) and becomes a route).');
        warn('Full quickstart: somewhere docs start');
        spinner.start();
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

      spinner.text = opts.dryRun
        ? `Checking ${totalFiles} files (${formatBytes(totalBytes)})...`
        : `Deploying ${totalFiles} files (${formatBytes(totalBytes)})...`;

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

        if (opts.dryRun) {
          const plan = await client.call<DryRunResult>('POST', '/deploy', body, undefined, {
            timeoutMs: LONG_CALL_TIMEOUT_MS,
          });
          spinner.stop();
          printDryRun(plan, scope);
          return;
        }

        const result = await client.call<DeployResult>('POST', '/deploy', body, undefined, {
          timeoutMs: LONG_CALL_TIMEOUT_MS,
        });

        spinner.stop();
        const staticCount =
          typeof result.files === 'number'
            ? result.files
            : (result.files ?? []).length;
        const fnCount = Object.keys(functions).length;
        // ONE scope-consistent headline — report only the layer this deploy
        // actually touched, so it never claims "Functions deployed" on a
        // static-only deploy or counts static files on a backend-only deploy
        // (audit #3: the old output printed "Functions deployed" + a static
        // count + "the other layer was left untouched" all at once).
        if (scope === 'functions') {
          success(`${fnCount} function(s) deployed — site left untouched`);
        } else if (scope === 'static') {
          success(`${staticCount} static file(s) deployed (${formatBytes(totalBytes)}) — functions left untouched`);
        } else {
          success(`${staticCount} static file(s)${fnCount > 0 ? ` + ${fnCount} function(s)` : ''} deployed (${formatBytes(totalBytes)})`);
        }

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
        if (result.function_errors && result.function_errors.length > 0) {
          for (const fe of result.function_errors) {
            const label = typeof fe === 'string' ? fe : (fe.route ?? JSON.stringify(fe));
            const detail = typeof fe === 'string' ? '' : fe.error ? ` — ${fe.error}` : '';
            error(`Function failed: ${label}${detail}`);
          }
        }
        if (result.warnings && result.warnings.length > 0) {
          for (const w of result.warnings) warn(w);
        }

        if (tempSession) {
          // Agent-relay success message (tsk_35674c33, verbatim copy — don't
          // "improve" it): every temp deploy, minted or silently reused, ends
          // with this block so the claim path is never missed.
          const hours = formatTtlHours(tempSession.ttlSeconds);
          success(`Live at ${teal(result.url)} — yours for ${hours} hour${hours === 1 ? '' : 's'}.`);
          info(`To keep it: ${teal(tempSession.claimUrl)}`);
          info("Claiming connects the Somewhere MCP so your agent can manage this project's");
          info('database, email, and cron directly next time.');
          // Additive pointer (tsk_497b7eeb) — the claim block above is verbatim
          // epic copy; this line is separate. Next thing a fresh agent needs is
          // the anonymous capability map (tables via `somewhere db query`, logs,
          // redeploys) — `docs start` is that map, no account required.
          info('What else works without an account: somewhere docs start');
        } else {
          success(`Live at ${teal(result.url)}`);
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
        if (result.function_errors && result.function_errors.length > 0) {
          process.exit(1);
        }
      } catch (err) {
        spinner.fail(opts.dryRun ? 'Dry run failed' : 'Deploy failed');
        // Structured build failures get the full treatment: file:line
        // heading + a code frame rebuilt from the local source (we have the
        // files the server compiled — this is where the CLI beats a remote
        // log dump).
        if (isBuildError(err) && renderBuildError(err, targetDir)) {
          process.exit(1);
        }
        // Always show the error code + HTTP status — "Project not found"
        // with no code/status left a customer unable to tell auth from
        // routing from payload failures (pfb_70e9d140c5a0).
        if (err instanceof CliApiError) {
          error(
            `${err.message} ${dim(err.statusCode ? `[${err.code}, HTTP ${err.statusCode}]` : `[${err.code}]`)}`,
          );
        } else {
          error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }
    });
}

interface DeployResult {
  files: string[] | number;
  url: string;
  has_functions: boolean;
  build_log?: string[];
  warnings?: string[];
  preserved_functions?: string[];
  function_errors?: Array<{ route?: string; error?: string } | string>;
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
