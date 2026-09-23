import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { ApiClient, CliApiError } from '../lib/client.js';
import { isBuildError, renderBuildError } from '../lib/build-errors.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { collectFiles } from '../lib/files.js';
import { dim, error, info, printJson, printJsonError, success, teal, warn } from '../lib/output.js';
import { isRecord } from '../lib/platform-command.js';
import { promoteCommandForShell, shellArgument } from '../lib/promote-handoff.js';
import {
  canonicalDir,
  clearPendingRequest,
  clearPreviewState,
  loadPendingRequest,
  loadPreviewState,
  savePendingRequest,
  savePreviewState,
  snapshotDigest,
  withPreviewLock,
  type PendingPreviewOperation,
  type PreviewTrackingState,
} from '../lib/preview-state.js';
import {
  BaseReleaseUnknownError,
  CloudDevUnavailableError,
  PublishConsentRequiredError,
  callDraftCandidate,
  readBaseReleaseState,
  readPublishConsent,
  resolveBaseRelease,
} from './dev.js';

/**
 * `somewhere preview start|update|status|list|close` — the preview lifecycle
 * for agents and scripts. Each command does one thing and exits; nothing
 * watches, and a process that stops closes nothing.
 *
 * Every write names the exact preview it changes and the exact version it
 * expects to replace. The platform refuses a stale expectation, and these
 * commands never answer that by fetching the newest version and writing over
 * it. An operation whose response was lost stays pending until the platform's
 * own receipt settles it; until then nothing new is sent, and the only retry is
 * the exact original request under the same operation id.
 */

const TRANSPORT_CODES = new Set(['TIMEOUT', 'SERVER_SLOW', 'NETWORK_ERROR', 'RELEASE_PREVERIFY_UNAVAILABLE']);

interface LifecycleOptions {
  project?: string;
  json?: boolean;
  session?: string;
  expect?: string;
  publishFirst?: boolean;
}

type ReceiptState = 'current' | 'running' | 'succeeded_not_current' | 'failed' | 'not_recorded';

interface SessionView {
  preview_session_id: string;
  status: 'open' | 'promoting' | 'promoted' | 'closed' | 'expired';
  preview_id: string | null;
  base_release_id: string;
  production_release_id: string | null;
  base_is_production: boolean;
  last_operation_id: string | null;
  expires_at: string;
  absolute_expires_at: string;
  database_status: string;
  files_status: string;
  resumable: boolean;
  promotable: boolean;
  operation?: { operation_id: string; state: ReceiptState; release_id: string | null };
  [key: string]: unknown;
}

interface SnapshotResult {
  preview_session_id?: string;
  draft_id?: string;
  preview_id?: string;
  candidate_release_id?: string;
  expires_at?: number | string;
  db_status?: string;
  files_status?: string;
  files_deployed?: number;
  has_functions?: boolean;
  warnings?: string[];
}

/** A refusal this command decided on, or relayed from the platform. */
class PreviewRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PreviewRefusal';
  }
}

interface ProjectRef {
  projectId: string;
  ref: string;
  cloudDevAllowed: boolean | null;
}

interface Ctx {
  client: ApiClient;
  cwd: string;
  opts: LifecycleOptions;
  project: ProjectRef;
}

async function resolveProject(client: ApiClient, explicit: string | undefined): Promise<ProjectRef> {
  const ref = explicit ?? loadProjectConfig()?.project_id;
  if (!ref) {
    throw new PreviewRefusal('NO_PROJECT', 'No project linked and no --project given. Run `somewhere init` or pass --project <id>.');
  }
  const project = await client.call<{ id?: unknown; cloud_dev_allowed?: unknown }>(
    'GET',
    `/projects/${encodeURIComponent(ref)}`,
  );
  if (!isRecord(project) || typeof project.id !== 'string') {
    throw new PreviewRefusal('PROJECT_NOT_FOUND', 'Project not found or you do not have access to it.');
  }
  return {
    projectId: project.id,
    ref,
    cloudDevAllowed: typeof project.cloud_dev_allowed === 'boolean' ? project.cloud_dev_allowed : null,
  };
}

/** The exact session (with the receipt for one operation when asked), or
 * null when this project does not hold it. */
async function readSession(
  client: ApiClient,
  projectId: string,
  previewSessionId: string,
  operationId?: string,
): Promise<SessionView | null> {
  try {
    return await client.call<SessionView>('GET', '/deploy/preview/session', undefined, {
      project_id: projectId,
      preview_session_id: previewSessionId,
      preview_operation_id: operationId,
    });
  } catch (err) {
    if (err instanceof CliApiError && err.code === 'DRAFT_NOT_FOUND') return null;
    throw err;
  }
}

function isTransportFailure(err: unknown): boolean {
  return err instanceof CliApiError ? TRANSPORT_CODES.has(err.code) : !(err instanceof PreviewRefusal);
}

function operationId(): string {
  return `previewop_${randomUUID()}`;
}

function commandPrefix(opts: LifecycleOptions, ref: string): string {
  return opts.project ? ` --project ${shellArgument(ref)}` : '';
}

function nextCommands(opts: LifecycleOptions, project: ProjectRef, sessionId: string, previewId: string | null) {
  const suffix = commandPrefix(opts, project.ref);
  return {
    update: `somewhere preview update${suffix}`,
    status: `somewhere preview status${suffix}`,
    close: `somewhere preview close${suffix}`,
    promote: previewId
      ? promoteCommandForShell({
        previewSessionId: sessionId,
        previewId,
        projectRef: project.ref,
        interactive: process.stdin.isTTY === true,
      })
      : null,
  };
}

async function mintLink(client: ApiClient, projectId: string, sessionId: string, previewId: string): Promise<string | null> {
  try {
    const cap = await client.call<{ preview_url?: unknown }>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/preview/mint`,
      { draft_id: sessionId, candidate_release_id: previewId },
    );
    return isRecord(cap) && typeof cap.preview_url === 'string' ? cap.preview_url : null;
  } catch {
    return null;
  }
}

function lifecycleNote(view: SessionView | null): Record<string, unknown> {
  return {
    ends_when: [
      'somewhere preview close',
      'it is promoted',
      view ? `no update before ${view.expires_at}` : 'a long enough period without updates',
      view ? `${view.absolute_expires_at} regardless of updates` : 'its fixed end date regardless of updates',
    ],
    closes_when_this_command_exits: false,
  };
}

// ── Unconfirmed operations ──────────────────────────────────────────────

type Resolution =
  | { kind: 'none' }
  /** The platform's record says this operation produced the preview's current version. */
  | { kind: 'applied'; pending: PendingPreviewOperation }
  /** The platform settled it some other way; it is not the preview's current version. */
  | {
    kind: 'settled';
    pending: PendingPreviewOperation;
    reason: 'failed' | 'succeeded_not_current' | 'refused' | 'session_gone';
    view: SessionView | null;
    error?: CliApiError;
  }
  /** No settled fact yet: it may still land. */
  | { kind: 'unresolved'; pending: PendingPreviewOperation; reason: 'running' | 'not_recorded' | 'unreachable' };

function settle(ctx: Ctx, state: PreviewTrackingState, patch: Partial<PreviewTrackingState> = {}): PreviewTrackingState {
  clearPendingRequest(ctx.cwd, ctx.project.projectId);
  return savePreviewState({ ...state, ...patch, pending: null });
}

/**
 * Settle this directory's unconfirmed operation from the platform's own
 * receipt for it — never from which operation happens to be newest.
 * `replay` allows re-sending the exact stored request under the same
 * operation id when the platform has no record of it yet.
 */
async function resolvePending(
  ctx: Ctx,
  state: PreviewTrackingState,
  replay: boolean,
): Promise<{ state: PreviewTrackingState; resolution: Resolution }> {
  const pending = state.pending;
  if (!pending) return { state, resolution: { kind: 'none' } };
  let view: SessionView | null;
  try {
    view = await readSession(ctx.client, ctx.project.projectId, state.preview_session_id, pending.operation_id);
  } catch (err) {
    if (isTransportFailure(err)) return { state, resolution: { kind: 'unresolved', pending, reason: 'unreachable' } };
    throw err;
  }
  if (!view && pending.kind === 'update') {
    return { state: settle(ctx, state), resolution: { kind: 'settled', pending, reason: 'session_gone', view: null } };
  }
  // A start whose session the platform does not hold yet has no record either.
  const receipt: ReceiptState = view?.operation?.state ?? 'not_recorded';
  if (receipt === 'current' && view?.preview_id) {
    return {
      state: settle(ctx, state, {
        preview_id: view.preview_id,
        base_release_id: view.base_release_id,
        expires_at: view.expires_at,
      }),
      resolution: { kind: 'applied', pending },
    };
  }
  if (receipt === 'running') return { state, resolution: { kind: 'unresolved', pending, reason: 'running' } };
  if (receipt === 'succeeded_not_current' || receipt === 'failed') {
    return { state: settle(ctx, state), resolution: { kind: 'settled', pending, reason: receipt, view } };
  }
  if (!replay) return { state, resolution: { kind: 'unresolved', pending, reason: 'not_recorded' } };

  const body = loadPendingRequest(ctx.cwd, ctx.project.projectId, pending.payload_sha256);
  let res: SnapshotResult;
  try {
    res = await callDraftCandidate<SnapshotResult>(ctx.client, '/deploy', body);
  } catch (err) {
    if (isTransportFailure(err)) return { state, resolution: { kind: 'unresolved', pending, reason: 'unreachable' } };
    return {
      state: settle(ctx, state),
      resolution: { kind: 'settled', pending, reason: 'refused', view, error: err as CliApiError },
    };
  }
  const previewId = res.preview_id ?? res.candidate_release_id;
  if ((res.preview_session_id ?? res.draft_id) !== state.preview_session_id || typeof previewId !== 'string') {
    return { state, resolution: { kind: 'unresolved', pending, reason: 'unreachable' } };
  }
  return { state: settle(ctx, state, { preview_id: previewId }), resolution: { kind: 'applied', pending } };
}

function unresolvedRefusal(ctx: Ctx, state: PreviewTrackingState, resolution: Extract<Resolution, { kind: 'unresolved' }>): PreviewRefusal {
  const why = resolution.reason === 'running'
    ? 'the platform is still working on it'
    : resolution.reason === 'not_recorded'
      ? 'the platform has no record of it yet'
      : 'the platform could not be reached to check it';
  return new PreviewRefusal(
    'PREVIEW_OPERATION_PENDING',
    `An earlier change to preview ${state.preview_session_id} (operation ${resolution.pending.operation_id}) is not confirmed: ${why}. `
      + 'Nothing new was sent and your local files are untouched. Run the same command again: it first settles that '
      + 'change, re-sending exactly the original request under the same operation if needed — never your newer files.',
    {
      preview_session_id: state.preview_session_id,
      operation_id: resolution.pending.operation_id,
      reason: resolution.reason,
      next: `somewhere preview status${commandPrefix(ctx.opts, ctx.project.ref)}`,
    },
  );
}

/** An earlier operation settled as something other than the current version. */
function settledRefusal(ctx: Ctx, state: PreviewTrackingState, resolution: Extract<Resolution, { kind: 'settled' }>): PreviewRefusal {
  const suffix = commandPrefix(ctx.opts, ctx.project.ref);
  if (resolution.reason === 'refused' && resolution.error) return describeRefusal(ctx, state, resolution.error);
  if (resolution.reason === 'session_gone') {
    return new PreviewRefusal(
      'DRAFT_NOT_FOUND',
      `Preview ${state.preview_session_id} no longer exists in this project. Your local files are untouched. `
        + `Run \`somewhere preview close${suffix}\` to stop tracking it here, then \`somewhere preview start${suffix}\`.`,
      { preview_session_id: state.preview_session_id },
    );
  }
  const head = resolution.view?.preview_id ?? null;
  return new PreviewRefusal(
    'PREVIEW_OPERATION_SUPERSEDED',
    `The platform built an earlier change from this directory (operation ${resolution.pending.operation_id}), but it is not `
      + `this preview's current version${head ? `: ${head} is, and this directory did not produce it` : ''}. `
      + 'Nothing new was sent and your local files are untouched. '
      + (head
        ? `Inspect it with \`somewhere preview status${suffix}\`; to replace it with your files, run `
          + `\`somewhere preview update${suffix} --expect ${head}\` after reviewing it.`
        : `Inspect it with \`somewhere preview status${suffix}\` before deciding.`),
    { preview_session_id: state.preview_session_id, operation_id: resolution.pending.operation_id, current_preview_id: head },
  );
}

/** Turn a platform refusal into customer-facing guidance. */
function describeRefusal(ctx: Ctx, state: PreviewTrackingState, apiErr: CliApiError): PreviewRefusal {
  const data = isRecord(apiErr.data) ? apiErr.data : {};
  const suffix = commandPrefix(ctx.opts, ctx.project.ref);
  if (isBuildError(apiErr) && !ctx.opts.json) renderBuildError(apiErr, ctx.cwd);
  if (apiErr.code === 'DRAFT_CANDIDATE_CONFLICT') {
    const current = typeof data.candidate_release_id === 'string' ? data.candidate_release_id : null;
    return new PreviewRefusal(
      apiErr.code,
      `${apiErr.message} Nothing was changed and your local files are untouched. `
        + (current
          ? `This preview is now at ${current}, which this directory did not produce. Inspect it with \`somewhere preview status${suffix}\`; `
            + `to replace it with your files, run \`somewhere preview update${suffix} --expect ${current}\` after reviewing it.`
          : `Inspect it with \`somewhere preview status${suffix}\` before deciding.`),
      { data, preview_session_id: state.preview_session_id, current_preview_id: current },
    );
  }
  if (apiErr.code === 'DRAFT_SESSION_TERMINAL' || apiErr.code === 'DRAFT_NOT_FOUND') {
    return new PreviewRefusal(
      apiErr.code,
      `${apiErr.message} Your local files are untouched. Run \`somewhere preview close${suffix}\` to stop tracking it here, then \`somewhere preview start${suffix}\`.`,
      { data, preview_session_id: state.preview_session_id },
    );
  }
  return new PreviewRefusal(apiErr.code ?? 'ERROR', apiErr.message, { data, preview_session_id: state.preview_session_id });
}

/**
 * Send one complete snapshot as one new operation. The exact request is stored
 * and the operation recorded as pending BEFORE it leaves, so a lost response
 * can only ever be settled or replayed byte-for-byte.
 */
async function sendOperation(
  ctx: Ctx,
  state: PreviewTrackingState,
  args: {
    kind: 'start' | 'update';
    expected: string | null;
    baseReleaseId: string | null;
    collected: ReturnType<typeof collectFiles>;
    digest: string;
    forgetOnRefusal: boolean;
  },
): Promise<{ state: PreviewTrackingState; res: SnapshotResult }> {
  const opId = operationId();
  const body: Record<string, unknown> = {
    project_id: ctx.project.projectId,
    scope: 'all',
    files: args.collected.files,
    binary_files: args.collected.binaryFiles,
    functions: args.collected.functions,
    replace_functions: true,
    preview: true,
    preview_session_id: state.preview_session_id,
    preview_operation_id: opId,
    expected_preview_id: args.expected,
    ...(args.expected === null ? { base_release_id: args.baseReleaseId } : {}),
  };
  const payloadSha = savePendingRequest(ctx.cwd, ctx.project.projectId, body);
  state = savePreviewState({
    ...state,
    pending: {
      kind: args.kind,
      operation_id: opId,
      expected_preview_id: args.expected,
      snapshot_digest: args.digest,
      payload_sha256: payloadSha,
    },
  });
  let res: SnapshotResult;
  try {
    res = await callDraftCandidate<SnapshotResult>(ctx.client, '/deploy', body, (retryError) => {
      if (!ctx.opts.json) info(`The platform did not answer (${retryError.code}); re-sending the same operation once.`);
    });
  } catch (err) {
    if (isTransportFailure(err)) {
      throw new PreviewRefusal(
        'PREVIEW_OUTCOME_UNKNOWN',
        'The platform did not confirm this change, so it may or may not have applied. Your local files are unchanged. '
          + 'Run the same command again: it settles this change first, re-sending exactly this request if the platform has no record of it.',
        { preview_session_id: state.preview_session_id, operation_id: opId },
      );
    }
    // The platform evaluated the request and refused it: it did not apply. A
    // preview this command only just began tracking on the caller's word is
    // not kept after a refusal.
    if (args.forgetOnRefusal) clearPreviewState(ctx.cwd, ctx.project.projectId, state.preview_session_id);
    else settle(ctx, state);
    throw describeRefusal(ctx, state, err as CliApiError);
  }
  const previewId = res.preview_id ?? res.candidate_release_id;
  if ((res.preview_session_id ?? res.draft_id) !== state.preview_session_id || typeof previewId !== 'string') {
    throw new PreviewRefusal(
      'PREVIEW_OUTCOME_UNKNOWN',
      'The platform did not return the exact preview this command changed. Run the same command again; it settles this change first.',
      { preview_session_id: state.preview_session_id, operation_id: opId },
    );
  }
  return { state: settle(ctx, state, { preview_id: previewId }), res };
}

/** Print the settled preview this directory now works on. `res` is null when
 * an earlier, unconfirmed operation turned out to have landed and nothing new
 * was sent. */
async function reportPreview(
  ctx: Ctx,
  stateIn: PreviewTrackingState,
  action: 'start' | 'update',
  res: SnapshotResult | null,
  note: string | null,
): Promise<void> {
  const { client, cwd, opts, project } = ctx;
  let state = stateIn;
  const previewId = state.preview_id!;
  let view: SessionView | null = null;
  try {
    view = await readSession(client, project.projectId, state.preview_session_id);
  } catch {
    view = null;
  }
  if (view) {
    state = savePreviewState({ ...state, base_release_id: view.base_release_id, expires_at: view.expires_at });
  }
  const link = await mintLink(client, project.projectId, state.preview_session_id, previewId);
  const result = {
    ok: true,
    action,
    sent: res !== null,
    project_id: project.projectId,
    preview_session_id: state.preview_session_id,
    preview_id: previewId,
    base_release_id: view?.base_release_id ?? state.base_release_id,
    production_release_id: view?.production_release_id ?? null,
    status: view?.status ?? 'open',
    expires_at: view?.expires_at ?? null,
    absolute_expires_at: view?.absolute_expires_at ?? null,
    database_status: view?.database_status ?? res?.db_status ?? null,
    files_status: view?.files_status ?? res?.files_status ?? null,
    files_deployed: res?.files_deployed ?? null,
    has_functions: res?.has_functions ?? null,
    warnings: [...(res?.warnings ?? []), ...(note ? [note] : [])],
    preview_link: link,
    preview_link_note: link
      ? 'Single-use sign-in link for a browser. It is not stored anywhere.'
      : 'No sign-in link could be created; the preview itself is ready.',
    lifecycle: lifecycleNote(view),
    tracking: { scope: 'directory', dir: canonicalDir(cwd) },
    next: nextCommands(opts, project, state.preview_session_id, previewId),
  };
  if (opts.json) {
    printJson(result);
    return;
  }
  if (note) info(note);
  success(action === 'start' ? 'Preview started — production is unchanged.' : 'Preview updated — production is unchanged.');
  for (const w of res?.warnings ?? []) warn(w);
  console.log(dim(`   preview_session_id: ${result.preview_session_id}`));
  console.log(dim(`   preview_id: ${previewId}`));
  console.log(dim(`   base_release_id: ${result.base_release_id ?? 'unknown'}`));
  if (link) console.log(`${teal('🌐')} Sign-in link (single use): ${teal(link)}`);
  if (view) info(dim(`Stays open until you close or promote it, ${view.expires_at} without an update, or ${view.absolute_expires_at}.`));
  info(dim('Stopping this command closes nothing.'));
  info(dim(`Update: ${result.next.update}   Close: ${result.next.close}`));
  if (result.next.promote) info(dim(`Promote after review: ${result.next.promote}`));
}

// ── Commands ────────────────────────────────────────────────────────────

async function context(opts: LifecycleOptions): Promise<Ctx> {
  const client = new ApiClient(getToken());
  return { client, cwd: process.cwd(), opts, project: await resolveProject(client, opts.project) };
}

async function startCommand(opts: LifecycleOptions): Promise<void> {
  const ctx = await context(opts);
  const { client, cwd, project } = ctx;
  const collected = collectFiles(cwd);
  const digest = snapshotDigest(collected);
  await withPreviewLock(cwd, project.projectId, 'preview start', async () => {
    let state = loadPreviewState(cwd, project.projectId);
    let note: string | null = null;
    let sessionId = `draft_${randomUUID()}`;
    const suffix = commandPrefix(opts, project.ref);

    if (state) {
      const settled = await resolvePending(ctx, state, true);
      state = settled.state;
      const resolution = settled.resolution;
      if (resolution.kind === 'unresolved') throw unresolvedRefusal(ctx, state, resolution);
      if (resolution.kind === 'applied' && resolution.pending.kind === 'start') {
        // The earlier start did land; its response was lost.
        await reportPreview(ctx, state, 'start', null, resolution.pending.snapshot_digest === digest
          ? 'An earlier start of this preview had completed; its response was lost. Nothing new was sent.'
          : 'An earlier start of this preview had completed with the files it had then; your newer local changes were '
            + `not sent. Run \`somewhere preview update${suffix}\` to send them.`);
        return;
      }
      if (resolution.kind === 'settled' && resolution.pending.kind === 'update') throw settledRefusal(ctx, state, resolution);

      if (state.closed) {
        note = `The preview this directory was working on (${state.preview_session_id}) was closed; starting a new one.`;
        state = null;
      } else {
        const view = await readSession(client, project.projectId, state.preview_session_id);
        // Unfinished: its first snapshot never became a version (refused, e.g.
        // a build error). Finish THAT session rather than open a second one.
        const unfinished = state.preview_id === null;
        if (view?.status === 'promoting' || (view?.status === 'open' && (!unfinished || view.preview_id !== null))) {
          throw new PreviewRefusal(
            'PREVIEW_ALREADY_TRACKED',
            `This directory is already working on preview ${view.preview_session_id} (${view.status}). `
              + `Run \`somewhere preview update${suffix}\` to send your files to it, `
              + `or \`somewhere preview close${suffix}\` first to start over.`,
            { preview_session_id: view.preview_session_id, preview_id: view.preview_id, status: view.status },
          );
        }
        if (unfinished && (!view || (view.status === 'open' && view.base_is_production))) {
          sessionId = state.preview_session_id;
          note = `Finishing the preview an earlier start began (${sessionId}).`;
        } else if (unfinished && view?.status === 'open') {
          // It never got a version and production moved on since it began, so
          // it can never take a first snapshot. Close exactly it; begin again.
          await client.call('POST', '/deploy/preview/close', {
            project_id: project.projectId,
            preview_session_id: state.preview_session_id,
          });
          note = `The preview an earlier start began (${state.preview_session_id}) never got a version and production has changed since; it was closed and a new one is starting.`;
          state = null;
        } else {
          note = view
            ? `The preview this directory was working on (${state.preview_session_id}) is ${view.status}; starting a new one.`
            : `The preview this directory was working on (${state.preview_session_id}) no longer exists; starting a new one.`;
          state = null;
        }
      }
    }

    const { baseReleaseId, published } = await resolveBaseRelease({
      cloudDevAllowed: async () => project.cloudDevAllowed,
      readBaseReleaseState: () => readBaseReleaseState(project.projectId, async () =>
        client.call('GET', '/deploy/status', undefined, { project_id: project.projectId })),
      confirmPublish: () => readPublishConsent(opts.publishFirst === true),
      announce: opts.json ? () => {} : info,
      publish: async () => {
        await callDraftCandidate(client, '/deploy', {
          project_id: project.projectId,
          scope: 'all',
          files: collected.files,
          binary_files: collected.binaryFiles,
          functions: collected.functions,
          replace_functions: true,
        });
      },
    });
    if (published && !opts.json) success('Published — this project now has a live version.');

    const fresh = savePreviewState({
      dir: cwd,
      project_id: project.projectId,
      preview_session_id: sessionId,
      preview_id: null,
      base_release_id: baseReleaseId,
      expires_at: null,
      pending: null,
    });
    const sent = await sendOperation(ctx, fresh, {
      kind: 'start', expected: null, baseReleaseId, collected, digest, forgetOnRefusal: false,
    });
    await reportPreview(ctx, sent.state, 'start', sent.res, note);
  });
}

async function updateCommand(opts: LifecycleOptions): Promise<void> {
  const ctx = await context(opts);
  const { cwd, project } = ctx;
  const suffix = commandPrefix(opts, project.ref);
  await withPreviewLock(cwd, project.projectId, 'preview update', async () => {
    let state = loadPreviewState(cwd, project.projectId);
    const wasTracked = state !== null;

    if (opts.session) {
      if (!opts.expect) {
        throw new PreviewRefusal(
          'PREVIEW_EXPECTED_REQUIRED',
          'Updating a named preview needs --expect <preview_id>: the version you last saw. The newest version is never assumed.',
        );
      }
      if (state && state.preview_session_id !== opts.session) {
        throw new PreviewRefusal(
          'PREVIEW_IDENTITY_MISMATCH',
          `This directory is working on preview ${state.preview_session_id}, not ${opts.session}. Nothing was sent. `
            + `Run \`somewhere preview close${suffix}\` here first, or run the update from the checkout that owns ${opts.session}.`,
          { tracked_preview_session_id: state.preview_session_id, requested_preview_session_id: opts.session },
        );
      }
    } else if (!state) {
      throw new PreviewRefusal(
        'PREVIEW_NOT_TRACKED',
        `This directory is not working on a preview. Run \`somewhere preview start${suffix}\`, or name one with --session <id> --expect <preview_id>.`,
      );
    }
    if (state?.closed) {
      throw new PreviewRefusal(
        'DRAFT_SESSION_TERMINAL',
        `Preview ${state.preview_session_id} was closed. Your local files are untouched. Run \`somewhere preview start${suffix}\` for a new one.`,
        { preview_session_id: state.preview_session_id },
      );
    }

    const collected = collectFiles(cwd);
    const digest = snapshotDigest(collected);
    let note: string | null = null;
    if (state) {
      const settled = await resolvePending(ctx, state, true);
      state = settled.state;
      const resolution = settled.resolution;
      if (resolution.kind === 'unresolved') throw unresolvedRefusal(ctx, state, resolution);
      if (resolution.kind === 'settled' && resolution.reason !== 'failed') throw settledRefusal(ctx, state, resolution);
      if (resolution.kind === 'settled') note = `An earlier change (operation ${resolution.pending.operation_id}) failed on the platform and did not apply.`;
      if (resolution.kind === 'applied' && !opts.expect && resolution.pending.snapshot_digest === digest) {
        await reportPreview(ctx, state, 'update', null,
          'An earlier update with these exact files had completed; its response was lost. Nothing new was sent.');
        return;
      }
    }

    const sessionId = opts.session ?? state!.preview_session_id;
    const expected = opts.expect ?? state?.preview_id ?? null;
    if (!expected) {
      throw new PreviewRefusal(
        'PREVIEW_NOT_STARTED',
        `This preview has no version yet. Run \`somewhere preview start${suffix}\` to finish starting it.`,
        { preview_session_id: sessionId },
      );
    }
    const tracked = state ?? savePreviewState({
      dir: cwd,
      project_id: project.projectId,
      preview_session_id: sessionId,
      preview_id: expected,
      base_release_id: null,
      expires_at: null,
      pending: null,
    });
    const sent = await sendOperation(ctx, tracked, {
      kind: 'update', expected, baseReleaseId: null, collected, digest, forgetOnRefusal: !wasTracked,
    });
    await reportPreview(ctx, sent.state, 'update', sent.res, note);
  });
}

function resolveIdentity(opts: LifecycleOptions, project: ProjectRef, state: PreviewTrackingState | null): string {
  const id = opts.session ?? state?.preview_session_id;
  if (!id) {
    throw new PreviewRefusal(
      'PREVIEW_NOT_TRACKED',
      `This directory is not working on a preview. Name one with --session <id>, or list them with \`somewhere preview list${commandPrefix(opts, project.ref)}\`.`,
    );
  }
  return id;
}

async function statusCommand(opts: LifecycleOptions): Promise<void> {
  const ctx = await context(opts);
  const { client, cwd, project } = ctx;
  await withPreviewLock(cwd, project.projectId, 'preview status', async () => {
    let state = loadPreviewState(cwd, project.projectId);
    const id = resolveIdentity(opts, project, state);
    const tracked = state?.preview_session_id === id;
    // Status settles what the platform's record already decides; it never sends.
    if (tracked && state!.pending) state = (await resolvePending(ctx, state!, false)).state;
    const pending = tracked ? state!.pending : null;
    const view = await readSession(client, project.projectId, id, pending?.operation_id);
    if (!view) {
      throw new PreviewRefusal(
        'DRAFT_NOT_FOUND',
        `Preview ${id} does not exist in this project.${tracked ? ` Run \`somewhere preview close${commandPrefix(opts, project.ref)}\` to stop tracking it here.` : ''}`,
        { preview_session_id: id, tracked_here: tracked, pending_operation: pending },
      );
    }
    const { operation, ...session } = view;
    const result = {
      ok: true,
      project_id: project.projectId,
      ...session,
      tracking: {
        tracked_here: tracked,
        dir: canonicalDir(cwd),
        local_preview_id: tracked ? state!.preview_id : null,
        in_sync: tracked ? state!.preview_id === view.preview_id : null,
        pending_operation: pending ? { ...pending, receipt: operation?.state ?? null } : null,
        closed: tracked ? state!.closed : null,
      },
      next: nextCommands(opts, project, id, view.preview_id),
    };
    if (opts.json) {
      printJson(result);
      return;
    }
    info(`Preview ${teal(id)}: ${view.status}`);
    console.log(dim(`   preview_id: ${view.preview_id ?? 'none yet'}`));
    console.log(dim(`   base_release_id: ${view.base_release_id}${view.base_is_production ? ' (production)' : ' (production has moved on)'}`));
    console.log(dim(`   open until: ${view.expires_at} without an update; ${view.absolute_expires_at} at the latest`));
    console.log(dim(`   resumable: ${view.resumable}   promotable: ${view.promotable}`));
    if (pending) warn(`An earlier change (operation ${pending.operation_id}) is not confirmed yet (${operation?.state ?? 'unknown'}).`);
    if (tracked && state!.preview_id !== view.preview_id) {
      warn(`This directory last saw ${state!.preview_id ?? 'no version'}; the preview is at ${view.preview_id ?? 'no version'}.`);
    }
  });
}

async function listCommand(opts: LifecycleOptions): Promise<void> {
  const { client, cwd, project } = await context(opts);
  const state = loadPreviewState(cwd, project.projectId);
  const trackedId = state && !state.closed ? state.preview_session_id : null;
  const status = await client.call<Record<string, unknown>>('GET', '/deploy/status', undefined, {
    project_id: project.projectId,
  });
  const listed: unknown[] = Array.isArray(status?.previews) ? status.previews : [];
  const previews = listed
    .filter((preview): preview is Record<string, unknown> => isRecord(preview))
    .map((preview): Record<string, unknown> & { tracked_here: boolean } => ({
      ...preview,
      tracked_here: preview.preview_session_id === trackedId,
    }));
  const result = {
    ok: true,
    project_id: project.projectId,
    production_release_id: status?.published === true && typeof status.active_release_id === 'string'
      ? status.active_release_id
      : null,
    previews,
    tracked_here: trackedId,
    note: 'Lists open, ready previews. `somewhere preview status --session <id>` reads one preview in any state.',
  };
  if (opts.json) {
    printJson(result);
    return;
  }
  if (!previews.length) info('No open previews.');
  for (const preview of previews) {
    console.log(`${preview.tracked_here ? teal('*') : ' '} ${preview.preview_session_id}  ${dim(`preview_id ${String(preview.preview_id)}  until ${String(preview.expires_at)}`)}`);
  }
  if (trackedId && !previews.some((preview) => preview.tracked_here)) {
    info(dim(`This directory tracks ${trackedId}, which is not open and ready; check it with \`somewhere preview status\`.`));
  }
}

async function closeCommand(opts: LifecycleOptions): Promise<void> {
  const ctx = await context(opts);
  const { client, cwd, project } = ctx;
  await withPreviewLock(cwd, project.projectId, 'preview close', async () => {
    let state = loadPreviewState(cwd, project.projectId);
    const id = resolveIdentity(opts, project, state);
    const tracked = state?.preview_session_id === id;
    if (tracked && state!.pending) state = (await resolvePending(ctx, state!, false)).state;
    const retry = `somewhere preview close --session ${id}${commandPrefix(opts, project.ref)}`;
    let res: Record<string, unknown>;
    try {
      res = await client.call<Record<string, unknown>>('POST', '/deploy/preview/close', {
        project_id: project.projectId,
        preview_session_id: id,
      });
    } catch (err) {
      if (err instanceof CliApiError && err.code === 'DRAFT_NOT_FOUND' && tracked && state!.pending?.kind === 'start') {
        // The start that would create it is still unconfirmed and may yet land:
        // keep tracking it so it is never orphaned.
        throw new PreviewRefusal(
          'PREVIEW_OPERATION_PENDING',
          `Preview ${id} does not exist yet, but the start that creates it (operation ${state!.pending.operation_id}) is not confirmed. `
            + `This directory keeps tracking it. Run \`somewhere preview start${commandPrefix(opts, project.ref)}\` to settle that start, then close it.`,
          { preview_session_id: id, operation_id: state!.pending.operation_id },
        );
      }
      if (err instanceof CliApiError
          && (err.code === 'DRAFT_NOT_FOUND' || err.code === 'PROJECT_DELETING'
            || (err.code === 'DRAFT_TERMINAL_CONFLICT' && isRecord(err.data) && err.data.status === 'promoted'))) {
        const removed = clearPreviewState(cwd, project.projectId, id);
        throw new PreviewRefusal(err.code, `${err.message}${removed ? ' This directory no longer tracks it.' : ''}`, {
          data: err.data,
          preview_session_id: id,
          tracking_removed: removed,
        });
      }
      throw err;
    }
    const cleanupPending = res.cleanup_pending === true;
    let removed = false;
    if (tracked) {
      if (cleanupPending) {
        // Keep a closed receipt (never an active preview) so a plain
        // `somewhere preview close` here retries the cleanup.
        clearPendingRequest(cwd, project.projectId);
        savePreviewState({ ...state!, pending: null, closed: { at: new Date().toISOString(), cleanup_pending: true } });
      } else {
        removed = clearPreviewState(cwd, project.projectId, id);
      }
    }
    const result = {
      ok: true,
      project_id: project.projectId,
      ...res,
      preview_session_id: id,
      tracking_removed: removed,
      ...(cleanupPending ? { retry_cleanup: retry, closed_receipt_kept: tracked } : {}),
    };
    if (opts.json) {
      printJson(result);
      return;
    }
    success(`Preview ${id} is closed${res.idempotent_replay === true ? ' (it already was)' : ''}. Production and other previews are unchanged.`);
    if (cleanupPending) info(`Its cleanup is still finishing; run \`${retry}\` to retry it.`);
    if (removed) info(dim('This directory no longer tracks a preview.'));
  });
}

function run(handler: (opts: LifecycleOptions) => Promise<void>) {
  return async function action(this: Command): Promise<void> {
    const opts = this.optsWithGlobals() as LifecycleOptions;
    try {
      await handler(opts);
    } catch (err) {
      const json = opts.json === true;
      if (err instanceof PreviewRefusal) {
        if (json) printJsonError(err.code, err.message, err.extra);
        else error(`${err.code}: ${err.message}`);
      } else if (err instanceof CloudDevUnavailableError) {
        if (json) printJsonError(err.code, err.message);
        else { error(err.message); info('Nothing was created or changed.'); }
      } else if (err instanceof PublishConsentRequiredError) {
        const message = err.why === 'declined'
          ? 'Publishing the first production version was declined. Nothing was created or changed.'
          : 'This project has never been published, so a preview has no live version to build on. Re-run with --publish-first to publish deliberately. Nothing was created or changed.';
        if (json) printJsonError(err.code, message);
        else error(message);
      } else if (err instanceof BaseReleaseUnknownError) {
        if (json) printJsonError(err.code, err.message);
        else { error(err.message); info('Nothing was created or changed.'); }
      } else if (err instanceof CliApiError) {
        if (json) printJsonError(err.code, err.message, err.data ? { data: err.data } : undefined);
        else error(`${err.code}: ${err.message}`);
      } else if (err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
        const code = (err as Error & { code: string }).code;
        if (json) printJsonError(code, err.message);
        else error(err.message);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        if (json) printJsonError('ERROR', message);
        else error(message);
      }
      process.exitCode = 1;
    }
  };
}

export function registerPreviewLifecycle(preview: Command): void {
  // A typo must never fall through to the interactive watcher, which opens a
  // brand-new preview.
  preview.allowExcessArguments(false);
  preview.command('start')
    .description('Start a new preview from this directory\'s complete source, then exit. Prints the preview\'s ids; this directory remembers it for update/status/close. Stopping closes nothing.')
    .option('--project <id>', 'Override project ID')
    .option('--publish-first', 'For a never-published project: publish this directory to production first. Without it the command refuses.')
    .option('--json', 'Print a typed JSON result')
    .action(run(startCommand));
  preview.command('update')
    .description('Send this directory\'s complete source to its preview, replacing exactly the version it last saw. Refused, with nothing changed, if the preview moved on or an earlier change is still unconfirmed.')
    .option('--project <id>', 'Override project ID')
    .option('--session <preview_session_id>', 'Name the preview explicitly (requires --expect)')
    .option('--expect <preview_id>', 'The exact preview version you expect to replace')
    .option('--json', 'Print a typed JSON result')
    .action(run(updateCommand));
  preview.command('status')
    .description('Read one exact preview in any state: open, promoting, promoted, closed, or expired, plus any unconfirmed change from this directory.')
    .option('--project <id>', 'Override project ID')
    .option('--session <preview_session_id>', 'Read this preview instead of the one this directory tracks')
    .option('--json', 'Print a typed JSON result')
    .action(run(statusCommand));
  preview.command('list')
    .description('List the project\'s open previews and mark the one this directory tracks.')
    .option('--project <id>', 'Override project ID')
    .option('--json', 'Print a typed JSON result')
    .action(run(listCommand));
  preview.command('close')
    .description('Close one exact preview: its sign-in links stop working and its database copy and files are cleaned up. Production and other previews are untouched. Safe to repeat; repeating retries unfinished cleanup.')
    .option('--project <id>', 'Override project ID')
    .option('--session <preview_session_id>', 'Close this preview instead of the one this directory tracks')
    .option('--json', 'Print a typed JSON result')
    .action(run(closeCommand));
}

/** For `somewhere promote`: stop tracking a preview that promotion finished.
 * Skipped while another preview command holds this directory's lock; that
 * command, or the next one, sees the preview is promoted. */
export async function untrackPromotedPreview(dir: string, projectIds: string[], previewSessionId: string): Promise<boolean> {
  let removed = false;
  for (const projectId of new Set(projectIds)) {
    try {
      removed = await withPreviewLock(dir, projectId, 'promote', async () =>
        clearPreviewState(dir, projectId, previewSessionId)) || removed;
    } catch {
      // Busy or unreadable: promotion already succeeded, and the next preview
      // command here sees the preview is promoted.
    }
  }
  return removed;
}
