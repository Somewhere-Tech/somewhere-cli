import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { reportTypecheck } from './typecheck.js';
import { runTypecheck } from '../lib/typecheck.js';
import chokidar from 'chokidar';
import prompts from 'prompts';
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
import { startDevServer } from '../local/dev-server.js';
import { ACCEPTED_ENTRY_FORMS, LocalCompiler, resolveDevEntry } from '../local/compiler.js';
import { readCompileCore } from '../local/compiler-core.js';
import { loadLocalEnv } from '../local/envfile.js';
import { showProjectNotices } from '../lib/project-notices.js';
import { getProjectServingUrl } from '../lib/project-urls.js';
import { callPlatformTool } from '../lib/platform-tools.js';
import { isRecord, unwrapPlatformData } from '../lib/platform-command.js';

const WATCH_EXTS = /\.(ts|tsx|js|jsx|mjs|html|css|json|svg|md|txt|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
const DEBOUNCE_MS = 500;
const RETRYABLE_DRAFT_CODES = new Set(['TIMEOUT', 'SERVER_SLOW', 'NETWORK_ERROR']);

/**
 * The preview this loop was watching has finished — it was promoted, or closed.
 *
 * A promote ends the preview session, but the watcher used to keep running and
 * keep failing, once per save, with the platform's API-client wording
 * (tsk_74375b3c). The loop knows perfectly well what happened; it should stop
 * and say so, not relay a refusal written for a machine.
 */
class PreviewFinishedError extends Error {
  constructor(readonly reason: 'promoted' | 'closed') {
    super(reason);
    this.name = 'PreviewFinishedError';
  }
}

/** Did the platform just tell us this preview is over? */
function previewFinishedReason(err: unknown): 'promoted' | 'closed' | null {
  if (!(err instanceof CliApiError) || err.code !== 'DRAFT_SESSION_TERMINAL') return null;
  const status = (err.data as { terminal_status?: unknown } | undefined)?.terminal_status;
  return status === 'promoted' ? 'promoted' : 'closed';
}

interface DeployResult {
  files?: string[] | number;
  files_deployed?: number;
  preview_url?: string;
  has_functions?: boolean;
  build_log?: string[];
  warnings?: string[];
  preview_session_id?: string;
  preview_id?: string;
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
  preview_session_id?: string;
  preview_id?: string;
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
  console.log(dim(`   preview_session_id: ${handoff.draftId}`));
  console.log(dim(`   preview_id: ${handoff.candidateReleaseId}`));
  console.log(dim(`   promote command: \`${handoff.promoteCommand}\``));
}

function printPreviewIdentity(draftId: string, candidateReleaseId: string): void {
  console.log(dim(`   preview_session_id: ${draftId}`));
  console.log(dim(`   preview_id: ${candidateReleaseId}`));
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

export function registerPreview(program: Command) {
  program
    .command('preview')
    .description(
      'Run your app on the platform instead of your machine. Every save goes to a private URL, '
        + 'reachable only by you until you share the link. The build is the one production would get; '
        + 'the database is a separate copy of your schema, so nothing you try here can touch production '
        + 'rows. Nothing your users see changes — production keeps serving what you last promoted, until '
        + 'you run `somewhere promote`. Reach for this when you want the real hosted app in front of you, '
        + 'or when your agent reaches the platform over MCP and cannot serve on localhost. '
        + 'Available on the Pro and Scale plans; `somewhere dev` runs the app on your machine on every plan.',
    )
    .option('--project <id>', 'Override project ID')
    .option(
      '--publish-first',
      'For a project that has never been published: publish this directory to production first, so the preview has a live version to build on. Without it you are asked, and a script that cannot be asked is refused.',
    )
    .action(async (opts: { project?: string; publishFirst?: boolean }) => {
      await runHotDeploy(opts);
    });
}

export function registerDev(program: Command) {
  program
    .command('dev [cmd...]')
    .description(
      'Your app on localhost, compiled by the platform\'s own compiler — so what you see is what deploy ' +
        'produces, not a lookalike built by a second toolchain. Save a file and the page updates in ' +
        'milliseconds; api/ functions run in local Node with sw.* calling your ' +
        'real project. There is no dev version of your app: from the first file you are building the ' +
        'production app, and this is a faster window onto it. Same app, same build. ' +
        'Reaching the project DATABASE from the local loop is a plan feature and the command says so ' +
        'once at startup when your plan does not include it; deploying is unaffected on every plan. ' +
        'To see the same app running on the platform instead of your machine, use `somewhere preview`. ' +
        'Pass a command (e.g. `somewhere dev npm run dev`) to run it locally with platform env vars.',
    )
    .option('--project <id>', 'Override project ID')
    .option('--cloud', 'Alias for `somewhere preview`')
    .option('--publish-first', 'Only with `--cloud`: see `somewhere preview --help`')
    .option('--port <port>', 'Port to serve on (default 8787)')
    .option('--open', 'Open the app in your browser once it is serving')
    .option(
      '--check',
      'Typecheck (tsc --noEmit) before starting and EXIT on type errors instead of warning. Needs `npm install` in this directory — tsc reads package types out of node_modules, which the CLI\'s own dependency cache does not stand in for.',
    )
    .option('--local', 'Accepted for compatibility — serving locally is what bare `somewhere dev` already does')
    .action(
      async (
        cmdParts: string[] | undefined,
        opts: {
          project?: string;
          cloud?: boolean;
          publishFirst?: boolean;
          local?: boolean;
          port?: string;
          check?: boolean;
          open?: boolean;
        },
      ) => {
        // A passed command keeps the legacy local-exec behavior: run YOUR
        // server with platform context injected.
        if (cmdParts && cmdParts.length > 0) {
          return runLegacyExec(cmdParts);
        }
        if (opts.cloud) {
          // Pre-launch alias. One line, then the identical loop — no ceremony,
          // no grandfathering. `preview` is the name.
          info('This is `somewhere preview`. Use that name — `--cloud` still works for now.');
          return runHotDeploy(opts);
        }
        return runLocalDev(opts);
      },
    );
}

/**
 * The local loop. Compiles the project with the PLATFORM'S compiler (vendored,
 * drift-guarded — see src/local/compiler.ts), serves it on localhost, and runs
 * api/ functions in local Node against the real project.
 *
 * There is no dev version of your app. From the first file you are building
 * the production app; this is a faster window onto it.
 *
 * Reaching the project DATABASE from here is a plan entitlement the platform
 * reports on the project (`local_dev_db_allowed`). When it is refused, the loop
 * still runs — it just says so once, up front, instead of at the first request.
 */
async function runLocalDev(opts: { project?: string; port?: string; check?: boolean; open?: boolean }) {
  try {
    assertNodeSupport();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const cwd = process.cwd();
  const port = opts.port ? Number(opts.port) : 8787;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    error(`Invalid --port: ${opts.port}`);
    process.exit(1);
  }

  const sources = collectFiles(cwd);
  // The loop refuses only what it genuinely cannot serve. It used to refuse
  // anything without a COMPILABLE entry, which locked out plain-JavaScript
  // projects that deploy and serve perfectly (pfb_e32a4e630c45); the rule now
  // matches deploy's — compile a compilable entry, serve everything else as
  // written, and stop only when index.html asks for a file that is not here or
  // when there is nothing to serve at all.
  const devEntry = resolveDevEntry(sources.files);
  const hasFunctions = Object.keys(sources.functions ?? {}).length > 0;
  if (devEntry.kind === 'none') {
    error(
      `No app entry found. index.html points at ${devEntry.declared.join(', ')}, which is not in this directory. ` +
        `An entry is a <script type="module" src="…"> naming a file that exists — ${ACCEPTED_ENTRY_FORMS}. ` +
        'That tag is what the platform reads, here and on deploy.',
    );
    process.exit(1);
  }
  if (devEntry.kind === 'raw' && !devEntry.entry && sources.files['index.html'] === undefined && !hasFunctions) {
    error(
      'Nothing to serve here. `somewhere dev` runs this directory as your app: add an index.html with a ' +
        `<script type="module" src="…"> entry (${ACCEPTED_ENTRY_FORMS}), or an api/ function.`,
    );
    process.exit(1);
  }

  let projectId = opts.project;
  let config = loadProjectConfig();
  if (!projectId) {
    if (!config) {
      error('No project linked. Run `somewhere init` or pass --project <id>.');
      process.exit(1);
    }
    projectId = config.project_id;
  }

  // Node's type STRIPPING runs the functions, so a dropped import sails through
  // and only crashes at request time. Surface it in the terminal first.
  //
  // Not when node_modules is absent, though. tsc then cannot resolve ANY
  // package types and reports every JSX element as TS7026 — 47 red lines on
  // the untouched init scaffold, none of them real, burying the two lines that
  // matter and teaching a first-time developer that this command's type errors
  // are noise (tsk_8796c588). The local loop's whole promise is that no
  // install is needed to run; the typecheck simply needs one to be meaningful.
  const hasModules = existsSync(join(cwd, 'node_modules'));
  if (existsSync(join(cwd, 'tsconfig.json')) && hasModules) {
    const spinner = ora('Typechecking (tsc --noEmit)...').start();
    const result = await runTypecheck(cwd);
    spinner.stop();
    reportTypecheck(result);
    if (!result.ok && opts.check) {
      error('Type errors found and --check is set — not starting.');
      process.exit(1);
    }
  } else if (opts.check) {
    error(
      hasModules
        ? '--check needs a tsconfig.json. Run `somewhere pull` here first (it scaffolds one).'
        : '--check needs your dependencies installed — without node_modules tsc cannot resolve any package types. Run `npm install` here first.',
    );
    process.exit(1);
  } else if (!hasModules) {
    info(dim('Typecheck skipped — no node_modules here, so tsc could not resolve your package types. `npm install` enables it.'));
  }

  const token = getToken();
  const client = new ApiClient(token);
  await showProjectNotices(client, projectId);

  let pkg: { dependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(sources.files['package.json'] ?? '{}') as { dependencies?: Record<string, string> };
  } catch {
    warn('package.json is not valid JSON — compiling with no declared dependencies.');
  }

  // VITE_*/REACT_APP_* values are compiled INTO the browser bundle, both here
  // and on deploy. Read them from the same .env the local function runtime
  // reads, so the bundle sees what a deploy of the same tree would see.
  const localEnv = loadLocalEnv(cwd);

  const spinner = ora('Preparing the compiler...').start();
  let prepared = false;
  const compiler = new LocalCompiler({
    cwd,
    viteEnv: localEnv,
    onPrepare: (what) => {
      prepared = true;
      spinner.text = `Resolving ${what}...`;
    },
  });
  let state = null;
  try {
    const { detectTailwind } = readCompileCore();
    await compiler.prepare(pkg, detectTailwind(sources.files));
    // Functions resolve packages from the SAME search path the compiler used,
    // so `import { createClient } from '@somewhere-tech/sdk'` works in api/
    // without a project npm install — the frontend already needed none, and a
    // loop where only half the app can find its dependencies is worse than one
    // where neither can (tsk_3269026d).
    // Functions are optional: a static React app with no api/ still runs.
    installLoader(cwd, compiler.moduleSearchPath);
    await loadVendoredRuntime();
    state = await prepareLocalProject(client, token, projectId, cwd, {
      localOrigin: `http://localhost:${port}`,
    });
    spinner.stop();
    if (prepared) success('Compiler ready — cached, so this only happens once.');
    if (!state.routes.length) state = { ...state, routes: [] };
  } catch (err) {
    spinner.fail('Could not start');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Said ONCE, after the loop is known to be startable and before the first
  // request — never on every save, and never a reason not to serve. Placed
  // after the start-failure handler above precisely so it cannot become one.
  const dbNotice = localDevDbNotice(state.localDevDbAllowed, state.localDevDbPlans);
  if (dbNotice) {
    warn(dbNotice[0]);
    for (const line of dbNotice.slice(1)) info(dim(line));
  }

  const latencies: number[] = [];
  await startDevServer({
    port,
    cwd,
    compiler,
    state,
    onRebuild: (ms) => {
      latencies.push(ms);
      if (latencies.length >= 5 && latencies.length % 5 === 0) {
        const sorted = [...latencies].sort((a, b) => a - b);
        console.log(
          dim(`   save → served: median ${sorted[Math.floor(sorted.length / 2)]}ms over ${latencies.length} edits`),
        );
      }
    },
    onListening: (url) => {
      if (opts.open) open(url).catch(() => {});
    },
  });
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
    const state = await prepareLocalProject(client, token, projectId, cwd, {
      localOrigin: `http://localhost:${port}`,
    });
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

/**
 * The one line `somewhere dev` prints at startup when this plan cannot reach
 * the project database from the local loop — and `null`, meaning print nothing,
 * in every other case.
 *
 * Why it exists: a blind test on a fresh Free account (2026-09-02) wrote a whole
 * database-backed app locally before discovering, at the first request, that
 * every `sw.db` call was refused — and the refusal it eventually saw told it to
 * redeploy, which never helped. Saying it once, up front, is the difference
 * between choosing a workflow and debugging a phantom.
 *
 * THREE RULES, all deliberate:
 *   - Only an explicit `false` prints. `null` — an older platform, or a read
 *     that did not answer — must never print a refusal, because being wrong in
 *     that direction tells a working account its loop is broken.
 *   - It NEVER stops the loop. The frontend still compiles and serves, hot
 *     reload still works, `sw.fs` / `sw.ai` / `sw.auth` still call the real
 *     project, and every function that does not touch the database still runs.
 *     A dead loop would be a worse outcome than the silence it replaces.
 *   - The plan names come from the platform (`local_dev_db_required_plans`),
 *     never from a list typed here — so the day the entitlement changes, this
 *     line changes with it and no CLI release is required.
 */
export function localDevDbNotice(
  allowed: boolean | null,
  plans: readonly string[] = [],
): string[] | null {
  if (allowed !== false) return null;
  const named = plans.length > 0
    ? ` It is included on the ${plans
        .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
        .reduce((acc, name, i, all) => (i === 0
          ? name
          : `${acc}${i === all.length - 1 ? ' and ' : ', '}${name}`), '')} plan${plans.length === 1 ? '' : 's'}.`
    : '';
  return [
    `This plan does not include reaching the project database from \`somewhere dev\`.${named}`,
    'Serving, hot reload and every function that does not touch the database work normally here.',
    'Deploying is unaffected on every plan: `somewhere deploy` publishes to production and the deployed app reads and writes the database normally.',
  ];
}

export const CLOUD_DEV_UNAVAILABLE_MESSAGE =
  '`somewhere preview` is available on the Pro and Scale plans. '
  + 'This account is on a plan that does not include it.';

/**
 * Does this account have private previews?
 *
 * Returns `true`/`false` when the platform states it, and `null` when it does
 * not — a read that fails, or a platform that stopped reporting the field.
 * `null` must NEVER refuse: an unknown answer is not a denial, and telling
 * someone whose account works today to upgrade would be a worse bug than the
 * one this check exists to fix. Only an explicit `false` stops the command.
 *
 * That is safe HERE, and only here, because of where the answer is used: an
 * unknown entitlement is read on the path that already requires explicit
 * consent to publish (see resolveBaseRelease), so it can no longer wave through
 * a production release nobody asked for. It is the RELEASE read, not this one,
 * that must refuse when it cannot answer.
 *
 * On a never-published project the platform answers this with the plain plan
 * entitlement (there is no release to bind a preview to yet), which is exactly
 * the case the caller needs.
 */
export async function readCloudDevAllowed(
  projectId: string,
  call: typeof callPlatformTool = callPlatformTool,
): Promise<boolean | null> {
  try {
    const project = unwrapPlatformData(
      await call('project_get', { project_id: projectId }, { allTools: true }),
    );
    if (isRecord(project) && typeof project.cloud_dev_allowed === 'boolean') {
      return project.cloud_dev_allowed;
    }
    return null;
  } catch {
    return null;
  }
}

export class CloudDevUnavailableError extends Error {
  readonly code = 'CLOUD_DEV_NOT_ENABLED';

  constructor() {
    super(CLOUD_DEV_UNAVAILABLE_MESSAGE);
    this.name = 'CloudDevUnavailableError';
  }
}

/**
 * What the platform says about this project's live version.
 *
 * `known: false` is the entire point of this type. The previous shape was
 * `string | null`, and `null` carried two opposite meanings at once: "there is
 * positively nothing live" and "I could not find out". The caller acts on that
 * answer by PUBLISHING THE WORKING DIRECTORY TO PRODUCTION, so collapsing the
 * two costs a customer a production release on a project that was already live
 * — which is exactly what happened, because a Free account's own production
 * deploy status answers 403 today (tsk_f4236589) and the 403 became `null`.
 *
 * A read that cannot answer is `unknown`, and unknown never publishes.
 */
export type BaseReleaseState =
  | { known: true; activeReleaseId: string | null }
  | { known: false; reason: string };

/**
 * Read the project's live version, distinguishing "nothing is live" from
 * "could not tell". Every failure mode — a refusal, a server error, a dropped
 * connection, a 200 whose shape this CLI does not recognise — is `unknown`.
 *
 * `call` is injected so a fixture can drive each of those answers.
 */
export async function readBaseReleaseState(
  projectId: string,
  call: typeof callPlatformTool = callPlatformTool,
): Promise<BaseReleaseState> {
  let status: unknown;
  try {
    status = unwrapPlatformData(
      await call('deploy_status', { project_id: projectId }, { allTools: true }),
    );
  } catch (err) {
    return { known: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(status)) {
    return { known: false, reason: 'the platform did not describe this project.' };
  }
  if (typeof status.active_release_id === 'string') {
    return { known: true, activeReleaseId: status.active_release_id };
  }
  // The ONLY answer that may lead to a publish: the platform states this
  // project is not published. Note the deliberate asymmetry — a project that IS
  // published but does not name a version behind it falls through to unknown
  // below rather than being treated as never-published, because the cost of
  // being wrong in that direction is publishing over a live app.
  if (status.published === false) return { known: true, activeReleaseId: null };
  return {
    known: false,
    reason: 'the platform did not say which version of this project is live.',
  };
}

/** The live version could not be read, so nothing may be published over it. */
export class BaseReleaseUnknownError extends Error {
  readonly code = 'BASE_RELEASE_UNKNOWN';

  constructor(readonly reason: string) {
    super(
      'Could not tell whether this project already has a live version, so nothing was published. '
      + `The platform said: ${reason}`,
    );
    this.name = 'BaseReleaseUnknownError';
  }
}

/**
 * Publishing this directory to production was never agreed to.
 *
 * `declined` — asked, and the answer was no.
 * `not-asked` — nothing here could ask (a script, an agent, a piped shell), so
 * the answer is no by default. Consent that cannot be given is not consent.
 */
export class PublishConsentRequiredError extends Error {
  readonly code = 'PUBLISH_CONSENT_REQUIRED';

  constructor(readonly why: 'declined' | 'not-asked') {
    super('Nothing was published.');
    this.name = 'PublishConsentRequiredError';
  }
}

export type PublishConsent = 'granted' | 'declined' | 'not-asked';

/**
 * Find the live version a private preview will build on — and, on a project
 * that has none, publish one ONLY after the person running the command says so.
 *
 * THE ORDER IS THE CONTRACT (tsk_cf48f4ab, tsk_5504e045). Every step below is
 * placed so that the customer's live site cannot change as a side effect of
 * asking for a preview:
 *
 *   1. The plan entitlement is read FIRST, before any write and before any
 *      question. An account without private previews is refused having created
 *      nothing, rather than handed a production release and then told the
 *      command is unavailable.
 *   2. The live version is read, and an unreadable answer STOPS the command.
 *      This is the reversal: `null` used to mean both "nothing is live" and
 *      "I could not tell", and the second one published over live projects.
 *   3. A project that already has a live version returns it and publishes
 *      NOTHING. This is the overwhelmingly common path.
 *   4. Only a positively-confirmed "never published" reaches the publish, and
 *      only after explicit consent — a confirmation, or `--publish-first`.
 *
 * Why an unknown ENTITLEMENT does not refuse here, when an unknown RELEASE
 * does: the entitlement question is only ever asked on the path that already
 * requires the customer's explicit consent to publish, and consent settles it.
 * A working account is never blocked by a read that failed; it is only ever
 * asked. Only a stated `false` refuses, so nobody is told to upgrade on the
 * strength of a read that did not answer.
 *
 * `publish` and `confirmPublish` are injected so a fixture can prove `publish`
 * was never called on each refusal path — the ordering is the behaviour under
 * test, not the call shape.
 */
export async function resolveBaseRelease(args: {
  cloudDevAllowed: () => Promise<boolean | null>;
  readBaseReleaseState: () => Promise<BaseReleaseState>;
  confirmPublish: () => Promise<PublishConsent>;
  publish: () => Promise<void>;
  announce?: (message: string) => void;
}): Promise<{ baseReleaseId: string; published: boolean }> {
  if ((await args.cloudDevAllowed()) === false) throw new CloudDevUnavailableError();

  const state = await args.readBaseReleaseState();
  if (!state.known) throw new BaseReleaseUnknownError(state.reason);
  if (state.activeReleaseId) return { baseReleaseId: state.activeReleaseId, published: false };

  args.announce?.(
    'This project has never been published, so there is no live version for a private preview to build on.',
  );
  args.announce?.(
    'Publishing it once now would put the files in this directory in front of your users. '
    + 'After that, every preview stays private to you and production only changes when you promote.',
  );
  const consent = await args.confirmPublish();
  if (consent !== 'granted') throw new PublishConsentRequiredError(consent);

  await args.publish();
  const after = await args.readBaseReleaseState();
  if (!after.known || !after.activeReleaseId) {
    throw new BaseReleaseUnknownError(
      'the first version was published, but the live version could not be read back. '
      + 'Run `somewhere preview` again.',
    );
  }
  return { baseReleaseId: after.activeReleaseId, published: true };
}

/**
 * Ask, once, before the one thing `somewhere preview` can do to a live site.
 *
 * A prompt is the primary mechanism rather than a bare flag because the publish
 * happens on a FIRST run, when nobody knows a flag is needed — a flag-only
 * design would either block every interactive first run or, worse, be added
 * blindly and re-open the hole. A prompt nobody can answer is not consent
 * either, so a non-interactive shell (a script, an agent, a piped terminal)
 * gets `not-asked` and the refusal names `--publish-first`, which is the same
 * consent given up front.
 */
export async function readPublishConsent(publishFirst: boolean): Promise<PublishConsent> {
  if (publishFirst) return 'granted';
  if (!process.stdin.isTTY) return 'not-asked';
  const { ok } = await prompts({
    type: 'confirm',
    name: 'ok',
    message: 'Publish this directory to production now, so the preview has a live version to build on?',
    initial: false,
  });
  return ok === true ? 'granted' : 'declined';
}

async function runHotDeploy(opts: { project?: string; publishFirst?: boolean }) {
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

  const { files, binaryFiles, functions } = collectFiles(cwd);
  const draftId = `draft_${randomUUID()}`;
  const firstOperationId = `previewop_${randomUUID()}`;

  // The first preview snapshot must name the production release it was read
  // from (base_release_id) — the platform binds the preview to that exact
  // production release. Everything about how that id is obtained, including
  // the refusal to invent one, lives in resolveBaseRelease.
  let baseReleaseId: string;
  try {
    const resolved = await resolveBaseRelease({
      cloudDevAllowed: () => readCloudDevAllowed(projectId),
      readBaseReleaseState: () => readBaseReleaseState(projectId),
      confirmPublish: () => readPublishConsent(opts.publishFirst === true),
      announce: info,
      publish: async () => {
        await callDraftCandidate<DeployResult>(client, '/deploy', {
          project_id: projectId,
          scope: 'all',
          files,
          binary_files: binaryFiles,
          functions,
          replace_functions: true,
        });
      },
    });
    baseReleaseId = resolved.baseReleaseId;
    if (resolved.published) success('Published — this project now has a live version.');
  } catch (err) {
    // Every branch here says the same thing in different words: your live site
    // is exactly as you left it. Nothing below may claim anything about whether
    // this project is published — that is precisely the read that failed.
    if (err instanceof CloudDevUnavailableError) {
      error(err.message);
      info('Nothing was created or changed — whatever is live stays live.');
      info('`somewhere deploy` publishes to production on any plan, and `somewhere dev` runs the same app on your machine.');
      process.exit(1);
    }
    if (err instanceof BaseReleaseUnknownError) {
      error(err.message);
      info('Nothing was created or changed — whatever is live stays live.');
      info('Try `somewhere preview` again. To publish this directory to production deliberately, run `somewhere deploy`.');
      process.exit(1);
    }
    if (err instanceof PublishConsentRequiredError) {
      if (err.why === 'declined') {
        warn('Nothing was published — whatever is live stays live.');
      } else {
        error('This project has never been published, so a preview has no live version to build on.');
        info('Re-run as `somewhere preview --publish-first` to publish this directory to production first, or run `somewhere deploy` yourself.');
        info('Nothing was created or changed — whatever is live stays live.');
      }
      process.exit(1);
    }
    if (!(isBuildError(err) && renderBuildError(err, cwd))) {
      error(err instanceof Error ? err.message : String(err));
    }
    error('Could not publish the first version, so the private preview has nothing to build on.');
    process.exit(1);
  }

  // Initial full sync to the PREVIEW slot (preview: true). Writes only the
  // owner-gated dev slot — never prod, never a version bump or history entry.
  // /deploy/patch rejects projects with no prior deploy, so a full (preview)
  // deploy first establishes the sandbox AND returns the {slug}-dev URL.
  const spinner = ora('Syncing to preview...').start();

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
      preview_session_id: draftId,
      preview_operation_id: firstOperationId,
      expected_preview_id: null,
      base_release_id: baseReleaseId,
    };
    const res = await callDraftCandidate<DeployResult>(client, '/deploy', body);
    const returnedPreviewSessionId = res.preview_session_id ?? res.draft_id;
    const returnedPreviewId = res.preview_id ?? res.candidate_release_id;
    if (returnedPreviewSessionId !== draftId
        || typeof returnedPreviewId !== 'string'
        || typeof res.preview_url !== 'string') {
      throw new Error('The platform did not return the exact preview created by this session.');
    }
    // The validated value, not the legacy field it may have fallen back FROM:
    // reading res.candidate_release_id here would discard the alias resolution
    // two lines above and break the moment the platform returns only the
    // canonical preview_id.
    candidateReleaseId = returnedPreviewId;
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
    } catch (err) {
      if (!(err instanceof PreviewFinishedError)) throw err;
      // One line, in the two words the product uses, naming the next command.
      // Nothing about how a preview is built reaches this terminal.
      console.log('');
      if (err.reason === 'promoted') {
        success('Promoted — this preview is now your live app, and the preview has finished.');
      } else {
        info('This preview has finished.');
      }
      info(`Run ${teal('somewhere preview')} to keep previewing.`);
      if (timer) clearTimeout(timer);
      await watcher.close().catch(() => {});
      process.exit(0);
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

  const operationId = `previewop_${randomUUID()}`;
  const body: Record<string, unknown> = {
    project_id: projectId,
    preview: true,
    preview_session_id: draftId,
    preview_operation_id: operationId,
    expected_preview_id: expectedCandidateReleaseId,
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
    const returnedPreviewSessionId = r.preview_session_id ?? r.draft_id;
    const returnedPreviewId = r.preview_id ?? r.candidate_release_id;
    if (returnedPreviewSessionId !== draftId || typeof returnedPreviewId !== 'string') {
      throw new Error('The platform did not return the exact updated preview.');
    }
    const nextCandidate = returnedPreviewId;
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
    const finished = previewFinishedReason(err);
    if (finished) {
      // Not a failed save — the preview itself is over. The loop stops on it.
      throw new PreviewFinishedError(finished);
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
