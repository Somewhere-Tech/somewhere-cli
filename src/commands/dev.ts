import { Command } from 'commander';
import { startFrontendDev } from '../lib/frontend-dev.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import chokidar from 'chokidar';
import prompts from 'prompts';
import open from '../lib/open.js';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { buildErrorSummary, isBuildError, renderBuildError } from '../lib/build-errors.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { IGNORE, classifyKey, collectFiles } from '../lib/files.js';
import { bold, dim, error, green, info, printJsonError, red, success, teal, warn, yellow } from '../lib/output.js';
import { showProjectNotices } from '../lib/project-notices.js';
import { getDeployedProjectServingUrl } from '../lib/project-urls.js';
import { callPlatformTool } from '../lib/platform-tools.js';
import { isRecord, unwrapPlatformData } from '../lib/platform-command.js';
import { countPublishSurface, formatPublishSurface } from '../lib/surface-counts.js';
import { promoteCommandForShell, promoteCommandLines } from '../lib/promote-handoff.js';

const WATCH_EXTS = /\.(ts|tsx|js|jsx|mjs|html|css|json|svg|md|txt|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
const DEBOUNCE_MS = 500;
const RETRYABLE_DRAFT_CODES = new Set([
  'TIMEOUT',
  'SERVER_SLOW',
  'NETWORK_ERROR',
  'RELEASE_PREVERIFY_UNAVAILABLE',
]);

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

function typedErrorCode(err: unknown): string | undefined {
  if (err instanceof CliApiError) return err.code;
  if (!(err instanceof Error)) return undefined;
  const code = /^([A-Z][A-Z0-9_]{2,}):(?:\s|$)/.exec(err.message.trim())?.[1];
  // Older MCP envelopes used TOOL_ERROR around the real project lookup
  // refusal. Do not let that compatibility wrapper re-expose the account's
  // project inventory while the typed platform fix rolls out.
  if (code === 'TOOL_ERROR' && /\bProject\b[^\n]*\bnot found\b/i.test(err.message)) {
    return 'PROJECT_NOT_FOUND';
  }
  return code;
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
  projectRef: string;
  /** Runnable in THIS shell — carries `--yes` when nobody can answer a prompt. */
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
    projectRef: projectId,
    promoteCommand: promoteCommandForShell({
      previewSessionId: draftId,
      previewId: candidateReleaseId,
      projectRef: projectId,
      interactive: process.stdin.isTTY === true,
    }),
  };
}

function printPreviewHandoff(handoff: PreviewCandidateHandoff): void {
  console.log(`${teal('🌐')} ${bold('Preview capability:')} ${teal(handoff.capabilityUrl)}`);
  printPreviewIdentity(handoff.draftId, handoff.candidateReleaseId, handoff.projectRef);
}

function printPreviewIdentity(draftId: string, candidateReleaseId: string, projectRef: string): void {
  console.log(dim(`   preview_session_id: ${draftId}`));
  console.log(dim(`   preview_id: ${candidateReleaseId}`));
  // The printed command has to run in the shell that is reading it: an agent or
  // a script gets the `--yes` form, because a bare promote refuses when there
  // is no terminal to answer its confirmation.
  for (const line of promoteCommandLines({
    previewSessionId: draftId,
    previewId: candidateReleaseId,
    projectRef,
    interactive: process.stdin.isTTY === true,
  })) {
    console.log(dim(`   ${line}`));
  }
}

export async function callDraftCandidate<T>(
  client: ApiClient,
  path: '/deploy' | '/deploy/patch',
  body: Record<string, unknown>,
  onRetry?: (error: CliApiError) => void,
): Promise<T> {
  try {
    return await client.call<T>('POST', path, body, undefined, {
      timeoutMs: LONG_CALL_TIMEOUT_MS,
    });
  } catch (err) {
    if (!(err instanceof CliApiError) || !RETRYABLE_DRAFT_CODES.has(err.code)) throw err;
    onRetry?.(err);
    // The exact same draft_operation_id makes this a read/replay of one
    // immutable build result, never a hidden rebase onto whatever is live now.
    return client.call<T>('POST', path, body, undefined, {
      timeoutMs: LONG_CALL_TIMEOUT_MS,
    });
  }
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0.1, Math.round(ms / 100) / 10);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

function previewHeartbeatMs(): number {
  const raw = process.env.SOMEWHERE_PREVIEW_HEARTBEAT_MS
    ?? process.env.SOMEWHERE_DEPLOY_HEARTBEAT_MS;
  if (!raw) return 30_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30_000;
}

/** Preserve the platform's typed state without replacing it with a generic
 * "failed". This is deliberately compact enough for a progress line. */
export function previewPlatformState(value: unknown): string | null {
  if (value instanceof CliApiError) {
    const data = isRecord(value.data) ? value.data : {};
    const state = ['phase', 'state', 'status', 'terminal_status']
      .map((key) => typeof data[key] === 'string' ? `${key}=${data[key]}` : null)
      .filter((item): item is string => item !== null);
    return [`code=${value.code}`, ...state].join(', ');
  }
  if (!isRecord(value)) return null;
  const state: string[] = [];
  if (typeof value.status === 'string') state.push(`status=${value.status}`);
  if (typeof value.release_publish === 'boolean') {
    state.push(`release_publish=${value.release_publish}`);
  }
  return state.length ? state.join(', ') : null;
}

/** A long preview bootstrap phase must never look frozen. */
export async function runPreviewPhase<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  info(`${label}... ${dim('(0.0s)')}`);
  const heartbeat = setInterval(() => {
    console.error(`${label} still running after ${elapsedLabel(Date.now() - startedAt)}...`);
  }, previewHeartbeatMs());
  try {
    const result = await operation();
    const state = previewPlatformState(result);
    success(`${label} ${dim(`(${elapsedLabel(Date.now() - startedAt)})`)}${state ? ` — platform state: ${state}` : ''}`);
    return result;
  } catch (err) {
    const state = previewPlatformState(err);
    error(`${label} failed after ${elapsedLabel(Date.now() - startedAt)}${state ? ` — platform state: ${state}` : ''}`);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

export type PreviewSessionState = 'active' | 'promoted' | 'closed' | 'missing' | 'unknown';

/** Read the preview lifecycle fields returned by deploy_status. A missing row
 * is kept distinct so the monitor only treats it as terminal after it has
 * observed this exact session active. */
export function previewSessionStateFromDeployment(
  value: unknown,
  previewSessionId: string,
  previewId: string,
): PreviewSessionState {
  const deployment = unwrapPlatformData(value);
  if (!isRecord(deployment)) return 'unknown';
  if (deployment.active_release_id === previewId
      || deployment.promoted_from_candidate_id === previewId
      || deployment.promoted_from_preview_id === previewId) return 'promoted';

  const candidates = Array.isArray(deployment.preview_candidates)
    ? deployment.preview_candidates.filter(isRecord)
    : [];
  const candidate = candidates.find((item) =>
    item.preview_session_id === previewSessionId || item.draft_id === previewSessionId);
  if (!candidate) return 'missing';
  const typedState = typeof candidate.terminal_status === 'string'
    ? candidate.terminal_status
    : typeof candidate.status === 'string'
      ? candidate.status
      : 'active';
  if (typedState === 'promoted') return 'promoted';
  if (['closed', 'expired', 'cancelled', 'canceled', 'terminal'].includes(typedState)) return 'closed';
  return 'active';
}

async function readPreviewSessionState(
  projectId: string,
  previewSessionId: string,
  previewId: string,
): Promise<PreviewSessionState> {
  try {
    return previewSessionStateFromDeployment(
      await callPlatformTool('deploy_status', { project_id: projectId }, { allTools: true }),
      previewSessionId,
      previewId,
    );
  } catch {
    return 'unknown';
  }
}

function previewPollMs(): number {
  const parsed = Number(process.env.SOMEWHERE_PREVIEW_POLL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2_000;
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
        + 'Available on the Pro and Scale plans; `somewhere dev` provides frontend hot reload against the deployed backend.',
    )
    .option('--project <id>', 'Override project ID')
    .option(
      '--publish-first',
      'For a project that has never been published: publish this directory to production first, so the preview has a live version to build on. Without it you are asked, and a script that cannot be asked is refused.',
    )
    .option('--json', 'Print a typed JSON refusal when preview cannot start')
    .action(async (opts: { project?: string; publishFirst?: boolean; json?: boolean }) => {
      await runHotDeploy(opts);
    });
}

export function registerDev(program: Command) {
  program.command('dev')
    .description('Frontend hot reload with API requests proxied to your deployed project. Backend code runs only after deploy or preview.')
    .option('--project <id>', 'Override project ID')
    .option('--port <port>', 'Local frontend port', '8787')
    .option('--open', 'Open the local frontend in your browser')
    .action(async (opts: { project?: string; port: string; open?: boolean }) => {
      try {
        const projectId = opts.project ?? loadProjectConfig()?.project_id;
        if (!projectId) throw new Error('No project linked. Run somewhere init or pass --project <id>.');
        const client = new ApiClient(getToken());
        const target = await getDeployedProjectServingUrl(client, projectId);
        await startFrontendDev(process.cwd(), target, Number(opts.port), opts.open);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
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
  | { known: false; reason: string; code?: string };

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
    const code = typedErrorCode(err);
    return {
      known: false,
      reason: err instanceof Error ? err.message : String(err),
      ...(code ? { code } : {}),
    };
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
  readonly code: string;

  constructor(readonly reason: string, platformCode?: string) {
    super(platformCode === 'PROJECT_NOT_FOUND'
      ? 'Project not found or you do not have access to it. Nothing was created or changed.'
      : 'Could not tell whether this project already has a live version, so nothing was published. '
        + `The platform said: ${reason}`);
    this.code = platformCode === 'PROJECT_NOT_FOUND' ? platformCode : 'BASE_RELEASE_UNKNOWN';
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
  if (!state.known) throw new BaseReleaseUnknownError(state.reason, state.code);
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

async function runHotDeploy(opts: { project?: string; publishFirst?: boolean; json?: boolean }) {
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
  const showPublishProgress = opts.publishFirst === true && opts.json !== true;
  let baseReleaseReads = 0;
  const phase = <T>(label: string, operation: () => Promise<T>): Promise<T> =>
    showPublishProgress ? runPreviewPhase(label, operation) : operation();

  // The first preview snapshot must name the production release it was read
  // from (base_release_id) — the platform binds the preview to that exact
  // production release. Everything about how that id is obtained, including
  // the refusal to invent one, lives in resolveBaseRelease.
  let baseReleaseId: string;
  try {
    const resolved = await resolveBaseRelease({
      cloudDevAllowed: () => phase('Checking preview access', () => readCloudDevAllowed(projectId)),
      readBaseReleaseState: () => {
        const label = baseReleaseReads++ === 0
          ? 'Reading the production release'
          : 'Confirming the production release';
        return phase(label, () => readBaseReleaseState(projectId));
      },
      confirmPublish: () => readPublishConsent(opts.publishFirst === true),
      announce: opts.json ? () => {} : info,
      publish: async () => {
        await phase('Publishing the first production version', () =>
          callDraftCandidate<DeployResult>(client, '/deploy', {
            project_id: projectId,
            scope: 'all',
            files,
            binary_files: binaryFiles,
            functions,
            replace_functions: true,
          }, (retryError) => {
            info(`Publish attempt ended with ${previewPlatformState(retryError)}; retrying the same operation once.`);
          }));
      },
    });
    baseReleaseId = resolved.baseReleaseId;
    if (resolved.published) success('Published — this project now has a live version.');
  } catch (err) {
    // Every branch here says the same thing in different words: your live site
    // is exactly as you left it. Nothing below may claim anything about whether
    // this project is published — that is precisely the read that failed.
    if (err instanceof CloudDevUnavailableError) {
      if (opts.json) {
        printJsonError(err.code, err.message);
        process.exit(1);
      }
      error(err.message);
      info('Nothing was created or changed — whatever is live stays live.');
      info('`somewhere deploy` publishes to production on any plan, and `somewhere dev` runs the same app on your machine.');
      process.exit(1);
    }
    if (err instanceof BaseReleaseUnknownError) {
      if (err.code === 'PROJECT_NOT_FOUND') {
        if (opts.json) printJsonError(err.code, err.message);
        else error(`${err.code}: ${err.message}`);
        process.exit(1);
      }
      error(err.message);
      info('Nothing was created or changed — whatever is live stays live.');
      info('Try `somewhere preview` again. To publish this directory to production deliberately, run `somewhere deploy`.');
      process.exit(1);
    }
    if (err instanceof PublishConsentRequiredError) {
      if (opts.json) {
        printJsonError(
          err.code,
          err.why === 'declined'
            ? 'Publishing the first production version was declined. Nothing was created or changed.'
            : 'This project has never been published, so a preview has no live version to build on. Re-run with --publish-first to publish deliberately. Nothing was created or changed.',
        );
        process.exit(1);
      }
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
  const spinner = showPublishProgress ? null : ora('Syncing to preview...').start();

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
    const res = await phase('Syncing the first private preview', () =>
      callDraftCandidate<DeployResult>(client, '/deploy', body, (retryError) => {
        info(`Preview sync ended with ${previewPlatformState(retryError)}; retrying the same operation once.`);
      }));
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
    spinner?.stop();
    // The same two numbers, in the same shape, that `somewhere deploy` and
    // `somewhere promote` print. "Synced 3 files" hid the function inside one
    // number and then a later line counted it separately, so one project
    // reported three different sizes of itself.
    success(`Synced ${formatPublishSurface(countPublishSurface({ files, binaryFiles, functions }))} to preview`);
    if (res.warnings?.length) for (const w of res.warnings) warn(w);
  } catch (err) {
    spinner?.fail('Initial sync failed');
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
  let observedSessionActive = false;
  let previewEnded = false;
  let pollingSession = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

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

  const finishPreview = async (
    reason: 'promoted' | 'closed',
    savedChangeWaiting: boolean,
  ): Promise<void> => {
    if (previewEnded) return;
    previewEnded = true;
    console.log('');
    if (reason === 'promoted') {
      success('Promoted — this preview is now your live app, and the preview has finished.');
    } else {
      info('This preview has finished.');
    }
    if (savedChangeWaiting) {
      info('This preview had already finished, so your save was not applied. It is still in your local files.');
    }
    if (savedChangeWaiting) {
      info(`Run ${teal('somewhere preview')} again to preview that save.`);
    } else {
      info(`Run ${teal('somewhere preview')} to keep previewing.`);
    }
    if (timer) clearTimeout(timer);
    if (pollTimer) clearInterval(pollTimer);
    await watcher.close().catch(() => {});
    process.exit(0);
  };

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
    deploying = true;
    try {
      // Check before consuming the save. Promotion closes a preview; if that
      // happened between polls, the local edit remains queued and untouched.
      const state = await readPreviewSessionState(
        projectId!,
        draftId,
        candidateReleaseId!,
      );
      if (state === 'active') observedSessionActive = true;
      if (state === 'promoted' || state === 'closed'
          || (state === 'missing' && observedSessionActive)) {
        await finishPreview(state === 'promoted' ? 'promoted' : 'closed', true);
        return;
      }
      pendingChanged.clear();
      pendingDeleted.clear();
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
      await finishPreview(err.reason, true);
    } finally {
      deploying = false;
      if (!previewEnded && (pendingChanged.size || pendingDeleted.size)) schedule();
    }
  };

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

  const pollSession = async () => {
    if (previewEnded || deploying || pollingSession) return;
    pollingSession = true;
    try {
      const state = await readPreviewSessionState(projectId!, draftId, candidateReleaseId!);
      if (state === 'active') {
        observedSessionActive = true;
        return;
      }
      if (state === 'promoted' || state === 'closed'
          || (state === 'missing' && observedSessionActive)) {
        await finishPreview(state === 'promoted' ? 'promoted' : 'closed', false);
      }
    } finally {
      pollingSession = false;
    }
  };
  void pollSession();
  pollTimer = setInterval(() => void pollSession(), previewPollMs());

  process.on('SIGINT', () => {
    console.log(`\n${dim('Stopped watching.')}`);
    if (pollTimer) clearInterval(pollTimer);
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
      printPreviewIdentity(draftId, nextCandidate, projectId);
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
