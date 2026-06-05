import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import chokidar from 'chokidar';
import open from 'open';
import ora from 'ora';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { IGNORE, classifyKey, collectFiles } from '../lib/files.js';
import { bold, dim, error, green, info, red, success, teal, warn, yellow } from '../lib/output.js';

const WATCH_EXTS = /\.(ts|tsx|js|jsx|mjs|html|css|json|svg|md|txt|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
const DEBOUNCE_MS = 500;

interface DeployResult {
  files?: string[] | number;
  url: string;
  has_functions?: boolean;
  build_log?: string[];
  warnings?: string[];
}

interface PatchResult {
  url: string;
  version: number;
  warnings?: string[];
  function_errors?: Array<{ route?: string; error?: string } | string>;
  bundle_error?: string;
  status?: 'success' | 'partial' | 'compile_degraded' | 'functions_degraded';
}

export function registerDev(program: Command) {
  program
    .command('dev [cmd...]')
    .description(
      'Private preview watcher: save a file → your owner-only preview updates in seconds (nothing to prod, no version bump). ' +
        'Pass a command (e.g. `somewhere dev npm run dev`) to run it locally with platform env vars instead.',
    )
    .option('--project <id>', 'Override project ID')
    .action(async (cmdParts: string[] | undefined, opts: { project?: string }) => {
      // A passed command keeps the legacy local-exec behavior (Option B —
      // run your own server with platform context injected). No command =
      // the hot-deploy watcher (Option A — the platform's no-localhost answer).
      if (cmdParts && cmdParts.length > 0) {
        return runLegacyExec(cmdParts);
      }
      return runHotDeploy(opts);
    });
}

async function runHotDeploy(opts: { project?: string }) {
  const token = getToken();
  const client = new ApiClient(token);
  const cwd = process.cwd();

  let projectId = opts.project;
  let subdomain: string | undefined;
  if (!projectId) {
    const config = loadProjectConfig();
    if (!config) {
      error('No project linked. Run `somewhere init` or pass --project <id>.');
      process.exit(1);
    }
    projectId = config.project_id;
    subdomain = config.subdomain;
  }

  // Initial full sync to the PREVIEW slot (preview: true). Writes only the
  // owner-gated dev slot — never prod, never a version bump or history entry.
  // /deploy/patch rejects projects with no prior deploy, so a full (preview)
  // deploy first establishes the sandbox AND returns the {slug}-dev URL.
  const spinner = ora('Syncing to preview...').start();
  const { files, binaryFiles, functions } = collectFiles(cwd);
  let url: string;
  try {
    const body: Record<string, unknown> = { project_id: projectId, files, preview: true };
    if (Object.keys(binaryFiles).length) body.binary_files = binaryFiles;
    if (Object.keys(functions).length) body.functions = functions;
    const res = await client.call<DeployResult>('POST', '/deploy', body);
    url = res.url;
    spinner.stop();
    const n = typeof res.files === 'number' ? res.files : (res.files ?? []).length;
    success(`Synced ${n} files to preview`);
    if (res.warnings?.length) for (const w of res.warnings) warn(w);
  } catch (err) {
    spinner.fail('Initial sync failed');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log('');
  console.log(`${green('👀')} ${bold('Watching')} ${dim(cwd)} ${dim('for changes')}`);
  console.log(`${teal('🌐')} ${bold('Preview:')} ${teal(url)}`);
  console.log(dim('   private to you — save a file and the preview updates. Not live to users.'));
  console.log(dim('   run `somewhere deploy` to ship to production. Ctrl-C to stop.\n'));
  open(url).catch(() => {});

  // Debounced batch of changes. Saving three files in quick succession ships
  // one patch, not three.
  const pendingChanged = new Set<string>();
  const pendingDeleted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deploying = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  const flush = async () => {
    if (deploying) {
      schedule(); // re-arm; a deploy is in flight
      return;
    }
    const changed = [...pendingChanged];
    const deleted = [...pendingDeleted];
    if (!changed.length && !deleted.length) return;
    pendingChanged.clear();
    pendingDeleted.clear();
    deploying = true;
    try {
      await deployBatch(client, projectId!, cwd, changed, deleted);
    } finally {
      deploying = false;
      if (pendingChanged.size || pendingDeleted.size) schedule();
    }
  };

  const watcher = chokidar.watch(cwd, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = relative(cwd, p);
      if (!rel || rel.startsWith('..')) return false;
      return rel.split(/[\\/]/).some(
        (seg) => IGNORE.has(seg) || (seg.startsWith('.') && seg !== '.' && seg !== ''),
      );
    },
  });

  const onChange = (abs: string) => {
    const rel = relative(cwd, abs);
    if (!WATCH_EXTS.test(rel)) return;
    pendingChanged.add(rel);
    pendingDeleted.delete(rel);
    schedule();
  };
  const onUnlink = (abs: string) => {
    const rel = relative(cwd, abs);
    if (!WATCH_EXTS.test(rel)) return;
    pendingDeleted.add(rel);
    pendingChanged.delete(rel);
    schedule();
  };

  watcher.on('add', onChange).on('change', onChange).on('unlink', onUnlink);

  process.on('SIGINT', () => {
    console.log(`\n${dim('Stopped watching.')}`);
    watcher.close().finally(() => process.exit(0));
  });
}

async function deployBatch(
  client: ApiClient,
  projectId: string,
  cwd: string,
  changed: string[],
  deleted: string[],
) {
  const updateFiles: Record<string, string> = {};
  const updateFunctions: Record<string, string> = {};
  const updateBinary: Record<string, string> = {};
  const deleteKeys: string[] = [];

  for (const rel of changed) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) continue; // changed-then-deleted within the window
    const { kind, key } = classifyKey(rel);
    if (kind === 'function') updateFunctions[key] = readFileSync(abs, 'utf-8');
    else if (kind === 'binary') updateBinary[key] = readFileSync(abs).toString('base64');
    else updateFiles[key] = readFileSync(abs, 'utf-8');
  }
  for (const rel of deleted) deleteKeys.push(classifyKey(rel).key);

  const body: Record<string, unknown> = { project_id: projectId, preview: true };
  if (Object.keys(updateFiles).length) body.update_files = updateFiles;
  if (Object.keys(updateFunctions).length) body.update_functions = updateFunctions;
  if (Object.keys(updateBinary).length) body.update_binary_files = updateBinary;
  if (deleteKeys.length) body.delete_files = deleteKeys;

  // Nothing real to ship (e.g. every changed file vanished) — skip quietly.
  if (Object.keys(body).length === 2) return;

  const label = describeBatch(changed, deleted);
  const t0 = Date.now();
  process.stdout.write(`${dim(stamp())} ${label} ${dim('→ updating preview...')}`);

  try {
    const r = await client.call<PatchResult>('POST', '/deploy/patch', body);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // Carriage-return overwrites the "updating..." line with the verdict.
    process.stdout.write('\r\x1b[K');

    if (r.bundle_error) {
      console.log(`${dim(stamp())} ${label} ${red('✗ compile failed')} ${dim(`(${secs}s)`)}`);
      error(r.bundle_error);
      info(dim('Your last working preview is still up. Fix and save again.'));
      return;
    }
    if (r.function_errors?.length) {
      console.log(`${dim(stamp())} ${label} ${yellow('⚠ functions degraded')} ${dim(`(${secs}s)`)}`);
      for (const fe of r.function_errors) {
        const route = typeof fe === 'string' ? fe : fe.route ?? '';
        const detail = typeof fe === 'string' ? '' : fe.error ? ` — ${fe.error}` : '';
        warn(`${route}${detail}`);
      }
      return;
    }
    if (r.warnings?.length) {
      console.log(`${dim(stamp())} ${label} ${yellow('⚠ preview')} ${dim(`(${secs}s)`)}`);
      for (const w of r.warnings) warn(w);
      return;
    }
    console.log(`${dim(stamp())} ${label} ${green('✓ preview')} ${dim(`(${secs}s)`)}`);
  } catch (err) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write('\r\x1b[K');
    console.log(`${dim(stamp())} ${label} ${red('✗ failed')} ${dim(`(${secs}s)`)}`);
    error(err instanceof Error ? err.message : String(err));
  }
}

function describeBatch(changed: string[], deleted: string[]): string {
  const parts: string[] = [];
  if (changed.length === 1 && !deleted.length) return teal(changed[0]);
  if (deleted.length === 1 && !changed.length) return `${teal(deleted[0])} ${dim('(deleted)')}`;
  if (changed.length) parts.push(`${changed.length} changed`);
  if (deleted.length) parts.push(`${deleted.length} deleted`);
  return teal(parts.join(', '));
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

// ─── Legacy: `somewhere dev <cmd>` runs a local command with platform context.
// Kept for anyone scripting against the old behavior; the no-arg form is the
// recommended hot-deploy watcher above.
async function runLegacyExec(cmdParts: string[]) {
  const token = getToken();
  const client = new ApiClient(token);
  const config = loadProjectConfig();
  if (!config) {
    error('No project linked. Run `somewhere init` first.');
    process.exit(1);
  }

  const spinner = ora('Loading project context from somewhere.tech...').start();
  try {
    const result = await client.call<{ keys?: Array<{ key: string }>; vars?: Array<{ key: string }> }>(
      'GET',
      '/env',
      undefined,
      { project_id: config.project_id },
    );
    const vars = result.keys ?? result.vars ?? [];
    spinner.stop();
    success(`${vars.length} env vars available (values stay server-side)`);

    const command = cmdParts.join(' ');
    info(`Starting: ${dim(command)}`);
    console.log('');

    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        SOMEWHERE_PROJECT_ID: config.project_id,
        SOMEWHERE_SUBDOMAIN: config.subdomain,
        SOMEWHERE_URL: `https://${config.subdomain}.somewhere.tech`,
      },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } catch (err) {
    spinner.fail('Failed to load project context');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
