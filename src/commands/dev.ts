import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { reportTypecheck } from './typecheck.js';
import { runTypecheck } from '../lib/typecheck.js';
import chokidar from 'chokidar';
import open from '../lib/open.js';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { buildErrorSummary, isBuildError, renderBuildError } from '../lib/build-errors.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { IGNORE, classifyKey, collectFiles } from '../lib/files.js';
import { bold, dim, error, green, info, red, success, teal, warn, yellow } from '../lib/output.js';
import { assertNodeSupport, installLoader } from '../local/loader.js';
import { loadVendoredRuntime, prepareLocalProject } from '../local/runtime.js';
import { startLocalServer } from '../local/server.js';
import { showProjectNotices } from '../lib/project-notices.js';
import { getProjectServingUrl } from '../lib/project-urls.js';
import { callPlatformTool } from '../lib/platform-tools.js';
import { isRecord, unwrapPlatformData } from '../lib/platform-command.js';

const WATCH_EXTS = /\.(ts|tsx|js|jsx|mjs|html|css|json|svg|md|txt|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
const DEBOUNCE_MS = 500;
const RETRYABLE_DRAFT_CODES = new Set(['TIMEOUT', 'SERVER_SLOW', 'NETWORK_ERROR']);

interface DeployResult {
  files?: string[] | number;
  files_deployed?: number;
  preview_url?: string;
  has_functions?: boolean;
  build_log?: string[];
  warnings?: string[];
  draft_id?: string;
  candidate_release_id?: string;
}

interface PatchResult {
  preview_url?: string;
  version: number;
  warnings?: string[];
  function_errors?: Array<{ route?: string; error?: string } | string>;
  bundle_error?: string;
  status?: 'success' | 'partial' | 'compile_degraded' | 'functions_degraded';
  draft_id?: string;
  candidate_release_id?: string;
}

export interface PreviewCandidateHandoff {
  draftId: string;
  candidateReleaseId: string;
  capabilityUrl: string;
  promoteCommand: string;
}

export async function mintPreviewHandoff(
  client: ApiClient,
  projectId: string,
  draftId: string,
  candidateReleaseId: string,
): Promise<PreviewCandidateHandoff> {
  const cap = await client.call<{ preview_url?: string }>(
    'POST',
    `/projects/${encodeURIComponent(projectId)}/preview/mint`,
    { draft_id: draftId, candidate_release_id: candidateReleaseId },
  );
  if (!cap || typeof cap.preview_url !== 'string' || !cap.preview_url.includes('/__sw_cap?t=')) {
    throw new Error('The platform created the candidate but did not return its preview capability URL.');
  }
  return {
    draftId,
    candidateReleaseId,
    capabilityUrl: cap.preview_url,
    promoteCommand: `somewhere promote ${draftId} ${candidateReleaseId}`,
  };
}

function printPreviewHandoff(handoff: PreviewCandidateHandoff): void {
  console.log(`${teal('🌐')} ${bold('Preview capability:')} ${teal(handoff.capabilityUrl)}`);
  console.log(dim(`   draft_id: ${handoff.draftId}`));
  console.log(dim(`   candidate_release_id: ${handoff.candidateReleaseId}`));
  console.log(dim(`   promote command: \`${handoff.promoteCommand}\``));
}

function printPreviewIdentity(draftId: string, candidateReleaseId: string): void {
  console.log(dim(`   draft_id: ${draftId}`));
  console.log(dim(`   candidate_release_id: ${candidateReleaseId}`));
  console.log(dim(`   promote command: \`somewhere promote ${draftId} ${candidateReleaseId}\``));
}

export async function callDraftCandidate<T>(
  client: ApiClient,
  path: '/deploy' | '/deploy/patch',
  body: Record<string, unknown>,
): Promise<T> {
  try {
    return await client.call<T>('POST', path, body, undefined, {
      timeoutMs: LONG_CALL_TIMEOUT_MS,
    });
  } catch (err) {
    if (!(err instanceof CliApiError) || !RETRYABLE_DRAFT_CODES.has(err.code)) throw err;
    // The exact same draft_operation_id makes this a read/replay of one
    // immutable build result, never a hidden rebase onto whatever is live now.
    return client.call<T>('POST', path, body, undefined, {
      timeoutMs: LONG_CALL_TIMEOUT_MS,
    });
  }
}

export function registerDev(program: Command) {
  program
    .command('dev [cmd...]')
    .description(
      'Private preview watcher: save a file → your owner-only preview updates in seconds (nothing to prod, no version bump). ' +
        '--local runs your functions in local Node with sw.* talking to the real project (no deploy in the loop); ' +
        'it typechecks before starting and on every reload so a dropped import surfaces in the terminal, not as a 500 ' +
        '(add --check to EXIT on type errors). ' +
        'Pass a command (e.g. `somewhere dev npm run dev`) to run it locally with platform env vars instead.',
    )
    .option('--project <id>', 'Override project ID')
    .option('--local', 'Run functions locally; sw.db/sw.fs/sw.ai/sw.auth proxy to the live platform')
    .option('--port <port>', 'Port for --local (default 8787)')
    .option(
      '--check',
      'With --local: typecheck (tsc --noEmit) before starting and EXIT on type errors instead of warning',
    )
    .action(
      async (
        cmdParts: string[] | undefined,
        opts: { project?: string; local?: boolean; port?: string; check?: boolean },
      ) => {
        if (opts.local) {
          return runLocalRuntime(opts);
        }
        // A passed command keeps the legacy local-exec behavior (Option B —
        // run your own server with platform context injected). No command =
        // the hot-deploy watcher (Option A — the platform's no-localhost answer).
        if (cmdParts && cmdParts.length > 0) {
          return runLegacyExec(cmdParts);
        }
        return runHotDeploy(opts);
      },
    );
}

async function runLocalRuntime(opts: { project?: string; port?: string; check?: boolean }) {
  try {
    assertNodeSupport();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const cwd = process.cwd();

  // The local runtime runs functions through Node's TYPE STRIPPING, not a
  // typechecker — a dropped import sails through here and only crashes at
  // request time (the `sanitizeForSpeech is not defined` 500 class). Run an
  // explicit typecheck pass first so the type error surfaces in the terminal
  // BEFORE you hit the route. Needs the tsconfig `somewhere pull` scaffolds;
  // skipped (with a hint) when absent so a bare `dev --local` still starts.
  if (existsSync(join(cwd, 'tsconfig.json'))) {
    const spinner = ora('Typechecking before local runtime (tsc --noEmit)...').start();
    const result = await runTypecheck(cwd);
    spinner.stop();
    reportTypecheck(result);
    if (!result.ok && opts.check) {
      error('Type errors found and --check is set — not starting the local runtime.');
      process.exit(1);
    }
    if (!result.ok) {
      warn(
        'Starting anyway — local runtime STRIPS types, so the above will crash at request time. ' +
          'Fix them, or use `somewhere dev --local --check` to gate on a clean typecheck.',
      );
      console.log('');
    }
  } else if (opts.check) {
    error('--check needs a tsconfig.json. Run `somewhere pull` here first (it scaffolds one).');
    process.exit(1);
  } else {
    warn(
      'No tsconfig.json — skipping the pre-start typecheck. Run `somewhere pull` to scaffold one ' +
        'so type errors surface before runtime.',
    );
  }

  let projectId = opts.project;
  if (!projectId) {
    const config = loadProjectConfig();
    if (!config) {
      error('No project linked. Run `somewhere init` or pass --project <id>.');
      process.exit(1);
    }
    projectId = config.project_id;
  }
  const port = opts.port ? Number(opts.port) : 8787;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    error(`Invalid --port: ${opts.port}`);
    process.exit(1);
  }

  const token = getToken();
  const client = new ApiClient(token);
  await showProjectNotices(client, projectId);
  const spinner = ora('Loading project context (env keys, scopes, routes)...').start();
  try {
    installLoader(cwd);
    await loadVendoredRuntime();
    const state = await prepareLocalProject(client, token, projectId, cwd);
    spinner.stop();
    if (state.routes.length === 0) {
      error(
        'No routable functions found — put a file under api/ (e.g. api/hello.ts) or a root catch-all ([...path].ts).',
      );
      process.exit(1);
    }
    success(
      `${state.routes.length} function route${state.routes.length === 1 ? '' : 's'} · project ${state.subdomain} · env: ${state.localEnvKeys.length} local value${state.localEnvKeys.length === 1 ? '' : 's'}`,
    );
    // Re-typecheck on each save: the runtime strips types, so a dropped import
    // would otherwise reload "clean" and only crash on the next request.
    const hasTsconfig = existsSync(join(cwd, 'tsconfig.json'));
    startLocalServer(state, {
      port,
      onReloadTypecheck: hasTsconfig
        ? async () => {
            const r = await runTypecheck(cwd);
            reportTypecheck(r);
          }
        : undefined,
    });
  } catch (err) {
    spinner.fail('Failed to start local runtime');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
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
  await showProjectNotices(client, projectId);

  // Initial full sync to the PREVIEW slot (preview: true). Writes only the
  // owner-gated dev slot — never prod, never a version bump or history entry.
  // /deploy/patch rejects projects with no prior deploy, so a full (preview)
  // deploy first establishes the sandbox AND returns the {slug}-dev URL.
  const spinner = ora('Syncing to preview...').start();
  const { files, binaryFiles, functions } = collectFiles(cwd);
  const draftId = `draft_${randomUUID()}`;
  const firstOperationId = `draftop_${randomUUID()}`;
  // The first draft snapshot must name the live release it was read from
  // (base_release_id) — the platform binds the draft to that exact production
  // release. Read it from deploy_status; a project that has never published to
  // production has no base and starts the draft from empty.
  let baseReleaseId: string | null = null;
  try {
    const status = unwrapPlatformData(
      await callPlatformTool('deploy_status', { project_id: projectId }, { allTools: true }),
    );
    if (isRecord(status) && typeof status.active_release_id === 'string') {
      baseReleaseId = status.active_release_id;
    }
  } catch {
    // Non-fatal: fall through with no base. The deploy below still validates.
  }
  let candidateReleaseId: string | null = null;
  let initialHandoff: PreviewCandidateHandoff;
  let initialAutoOpenUrl: string;
  try {
    // Exact-draft complete-snapshot contract (DRAFT_COMPLETE_SNAPSHOT_REQUIRED):
    // scope:"all", the complete files/binary_files/functions maps (empty maps
    // when there are none), and replace_functions:true. All bytes inline.
    const body: Record<string, unknown> = {
      project_id: projectId,
      scope: 'all',
      files,
      binary_files: binaryFiles,
      functions,
      replace_functions: true,
      preview: true,
      draft_id: draftId,
      draft_operation_id: firstOperationId,
      expected_candidate_release_id: null,
      base_release_id: baseReleaseId,
    };
    const res = await callDraftCandidate<DeployResult>(client, '/deploy', body);
    if (res.draft_id !== draftId
        || typeof res.candidate_release_id !== 'string'
        || typeof res.preview_url !== 'string') {
      throw new Error('The platform did not return the exact draft candidate created by this session.');
    }
    candidateReleaseId = res.candidate_release_id;
    // Keep the printed capability usable: auto-open consumes a one-time token,
    // so mint a separate token for the browser before minting the handoff shown
    // in the terminal.
    initialAutoOpenUrl = (await mintPreviewHandoff(
      client,
      projectId,
      draftId,
      candidateReleaseId,
    )).capabilityUrl;
    initialHandoff = await mintPreviewHandoff(client, projectId, draftId, candidateReleaseId);
    spinner.stop();
    const n = typeof res.files_deployed === 'number'
      ? res.files_deployed
      : typeof res.files === 'number'
        ? res.files
        : (res.files ?? []).length;
    success(`Synced ${n} files to preview`);
    if (res.warnings?.length) for (const w of res.warnings) warn(w);
  } catch (err) {
    spinner.fail('Initial sync failed');
    if (!(isBuildError(err) && renderBuildError(err, cwd))) {
      error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }

  console.log('');
  console.log(`${green('👀')} ${bold('Watching')} ${dim(cwd)} ${dim('for changes')}`);
  printPreviewHandoff(initialHandoff);
  console.log(dim('   private to you — save a file and the preview updates. Not live to users.'));
  console.log(dim('   Ctrl-C to stop.\n'));
  open(initialAutoOpenUrl).catch(() => {});

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
      const nextCandidate = await deployBatch(
        client,
        projectId!,
        cwd,
        changed,
        deleted,
        draftId,
        candidateReleaseId!,
      );
      if (nextCandidate) candidateReleaseId = nextCandidate;
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
  draftId: string,
  expectedCandidateReleaseId: string,
): Promise<string | null> {
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

  const operationId = `draftop_${randomUUID()}`;
  const body: Record<string, unknown> = {
    project_id: projectId,
    preview: true,
    draft_id: draftId,
    draft_operation_id: operationId,
    expected_candidate_release_id: expectedCandidateReleaseId,
  };
  if (Object.keys(updateFiles).length) body.update_files = updateFiles;
  if (Object.keys(updateFunctions).length) body.update_functions = updateFunctions;
  if (Object.keys(updateBinary).length) body.update_binary_files = updateBinary;
  if (deleteKeys.length) body.delete_files = deleteKeys;

  // Nothing real to ship (e.g. every changed file vanished) — skip quietly.
  if (!Object.keys(updateFiles).length
      && !Object.keys(updateFunctions).length
      && !Object.keys(updateBinary).length
      && !deleteKeys.length) return null;

  const label = describeBatch(changed, deleted);
  const t0 = Date.now();
  process.stdout.write(`${dim(stamp())} ${label} ${dim('→ updating preview...')}`);

  try {
    const r = await callDraftCandidate<PatchResult>(client, '/deploy/patch', body);
    if (r.draft_id !== draftId || typeof r.candidate_release_id !== 'string') {
      throw new Error('The platform did not return the exact updated draft candidate.');
    }
    const nextCandidate = r.candidate_release_id;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // Carriage-return overwrites the "updating..." line with the verdict.
    process.stdout.write('\r\x1b[K');

    if (r.bundle_error) {
      console.log(`${dim(stamp())} ${label} ${red('✗ compile failed')} ${dim(`(${secs}s)`)}`);
      error(r.bundle_error);
      info(dim('Your last working preview is still up. Fix and save again.'));
      return null;
    }
    if (r.function_errors?.length) {
      console.log(`${dim(stamp())} ${label} ${yellow('⚠ functions degraded')} ${dim(`(${secs}s)`)}`);
      for (const fe of r.function_errors) {
        const route = typeof fe === 'string' ? fe : fe.route ?? '';
        const detail = typeof fe === 'string' ? '' : fe.error ? ` — ${fe.error}` : '';
        warn(`${route}${detail}`);
      }
      return null;
    }
    if (r.warnings?.length) {
      console.log(`${dim(stamp())} ${label} ${yellow('⚠ preview')} ${dim(`(${secs}s)`)}`);
      for (const w of r.warnings) warn(w);
    } else {
      console.log(`${dim(stamp())} ${label} ${green('✓ preview')} ${dim(`(${secs}s)`)}`);
    }
    try {
      const handoff = await mintPreviewHandoff(client, projectId, draftId, nextCandidate);
      printPreviewHandoff(handoff);
    } catch (err) {
      error(`Preview updated, but its capability URL could not be created: ${err instanceof Error ? err.message : String(err)}`);
      printPreviewIdentity(draftId, nextCandidate);
    }
    return nextCandidate;
  } catch (err) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write('\r\x1b[K');
    if (isBuildError(err)) {
      console.log(`${dim(stamp())} ${label} ${red('✗ compile failed')} ${dim(`(${secs}s)`)} ${yellow(buildErrorSummary(err))}`);
      renderBuildError(err, cwd);
      info(dim('Your last working preview is still up. Fix and save again.'));
      return null;
    }
    console.log(`${dim(stamp())} ${label} ${red('✗ failed')} ${dim(`(${secs}s)`)}`);
    error(err instanceof Error ? err.message : String(err));
    return null;
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

  await showProjectNotices(client, config.project_id);
  const spinner = ora('Loading project context from somewhere.tech...').start();
  try {
    const [result, servingUrl] = await Promise.all([
      client.call<{ keys?: Array<{ key: string }>; vars?: Array<{ key: string }> }>(
        'GET',
        '/env',
        undefined,
        { project_id: config.project_id },
      ),
      getProjectServingUrl(client, config.project_id),
    ]);
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
        ...(servingUrl ? { SOMEWHERE_URL: servingUrl } : {}),
      },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } catch (err) {
    spinner.fail('Failed to load project context');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
