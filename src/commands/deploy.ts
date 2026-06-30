import { Command } from 'commander';
import { resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { isBuildError, renderBuildError } from '../lib/build-errors.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { collectFiles, formatBytes } from '../lib/files.js';
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
    .action(async (dir: string | undefined, opts) => {
      const token = getToken();
      const client = new ApiClient(token);
      const targetDir = resolveTargetDir(dir);

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
        const config = loadProjectConfig(targetDir) ?? loadProjectConfig();
        if (!config) {
          error(
            'No project linked. Run `somewhere init` or pass --project <id>',
          );
          process.exit(1);
        }
        projectId = config.project_id;
      }

      const spinner = ora('Collecting files...').start();

      const { files, binaryFiles, functions } = collectFiles(targetDir);

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
        const fileCount =
          typeof result.files === 'number'
            ? result.files
            : (result.files ?? []).length;
        success(`${fileCount} files uploaded (${formatBytes(totalBytes)})`);

        if (result.has_functions) {
          success('Functions deployed');
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

        if (scope === 'functions') {
          success(`Functions live at ${teal(result.url)} (site left untouched)`);
        } else if (scope === 'static') {
          success(`Site live at ${teal(result.url)} (functions left untouched)`);
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
