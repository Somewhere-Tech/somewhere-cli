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
  clearPreviewState,
  loadPreviewState,
  savePreviewState,
  snapshotDigest,
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
 * it. The directory remembers which preview it is working on (see
 * lib/preview-state.ts), so two checkouts of one project work on two previews.
 */

const TRANSPORT_CODES = new Set(['TIMEOUT', 'SERVER_SLOW', 'NETWORK_ERROR', 'RELEASE_PREVERIFY_UNAVAILABLE']);

interface LifecycleOptions {
  project?: string;
  json?: boolean;
  session?: string;
  expect?: string;
  publishFirst?: boolean;
}

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

/** The exact session, or null when this project does not hold it. */
async function readSession(client: ApiClient, projectId: string, previewSessionId: string): Promise<SessionView | null> {
  try {
    return await client.call<SessionView>('GET', '/deploy/preview/session', undefined, {
      project_id: projectId,
      preview_session_id: previewSessionId,
    });
  } catch (err) {
    if (err instanceof CliApiError && err.code === 'DRAFT_NOT_FOUND') return null;
    throw err;
  }
}

function isTransportFailure(err: unknown): boolean {
  return err instanceof CliApiError ? TRANSPORT_CODES.has(err.code) : !(err instanceof PreviewRefusal);
}

/**
 * Settle an operation whose response never arrived. If the exact session says
 * our operation produced its current version, adopt it; otherwise it did not
 * land (yet) and the record keeps it so the same operation can be re-sent.
 */
async function reconcilePending(
  client: ApiClient,
  state: PreviewTrackingState,
): Promise<{ state: PreviewTrackingState; adopted: PendingPreviewOperation | null }> {
  if (!state.pending) return { state, adopted: null };
  let view: SessionView | null;
  try {
    view = await readSession(client, state.project_id, state.preview_session_id);
  } catch (err) {
    // Unknown stays pending: only an identical re-send, or a change the
    // platform can refuse as stale, may follow it.
    if (isTransportFailure(err)) return { state, adopted: null };
    throw err;
  }
  if (view && view.preview_id && view.last_operation_id === state.pending.operation_id) {
    return {
      state: savePreviewState({
        ...state,
        preview_id: view.preview_id,
        base_release_id: view.base_release_id,
        expires_at: view.expires_at,
        pending: null,
      }),
      adopted: state.pending,
    };
  }
  return { state, adopted: null };
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

/** Send one complete snapshot to one exact session and settle the record. */
async function sendSnapshot(args: {
  client: ApiClient;
  cwd: string;
  opts: LifecycleOptions;
  project: ProjectRef;
  state: PreviewTrackingState;
  collected: ReturnType<typeof collectFiles>;
  baseReleaseId: string | null;
  action: 'start' | 'update';
  note?: string | null;
  /** The record was created by this command for an explicitly named preview. */
  forgetOnRefusal?: boolean;
}): Promise<void> {
  const { client, cwd, opts, project, collected, action } = args;
  let state = args.state;
  const pending = state.pending!;
  const body: Record<string, unknown> = {
    project_id: project.projectId,
    scope: 'all',
    files: collected.files,
    binary_files: collected.binaryFiles,
    functions: collected.functions,
    replace_functions: true,
    preview: true,
    preview_session_id: state.preview_session_id,
    preview_operation_id: pending.operation_id,
    expected_preview_id: pending.expected_preview_id,
    ...(pending.expected_preview_id === null ? { base_release_id: args.baseReleaseId } : {}),
  };
  let res: SnapshotResult;
  try {
    res = await callDraftCandidate<SnapshotResult>(client, '/deploy', body, (retryError) => {
      if (!opts.json) info(`The platform did not answer (${retryError.code}); re-sending the same operation once.`);
    });
  } catch (err) {
    throw settleFailure(err, state, opts, project, cwd, args.forgetOnRefusal === true);
  }
  const returnedSession = res.preview_session_id ?? res.draft_id;
  const previewId = res.preview_id ?? res.candidate_release_id;
  if (returnedSession !== state.preview_session_id || typeof previewId !== 'string') {
    throw new PreviewRefusal(
      'PREVIEW_OUTCOME_UNKNOWN',
      'The platform did not return the exact preview this command changed. Run the same command again; it re-sends the same operation.',
      { preview_session_id: state.preview_session_id },
    );
  }
  state = savePreviewState({ ...state, preview_id: previewId, pending: null });
  await reportPreview({ client, cwd, opts, project, state, action, res, note: args.note ?? null });
}

/** Print the settled preview this directory now works on. `res` is null when
 * an earlier, unconfirmed operation turned out to have landed and nothing new
 * was sent. */
async function reportPreview(args: {
  client: ApiClient;
  cwd: string;
  opts: LifecycleOptions;
  project: ProjectRef;
  state: PreviewTrackingState;
  action: 'start' | 'update';
  res: SnapshotResult | null;
  note: string | null;
}): Promise<void> {
  const { client, cwd, opts, project, action, res, note } = args;
  let state = args.state;
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

/** Turn a failed send into the right refusal, keeping or clearing the pending
 * operation according to whether the platform decided it. */
function settleFailure(
  err: unknown,
  state: PreviewTrackingState,
  opts: LifecycleOptions,
  project: ProjectRef,
  cwd: string,
  forgetOnRefusal: boolean,
): PreviewRefusal {
  if (isTransportFailure(err)) {
    return new PreviewRefusal(
      'PREVIEW_OUTCOME_UNKNOWN',
      'The platform did not confirm this change, so it may or may not have applied. Your local files are unchanged. '
        + 'Run the same command again: it re-sends the same operation, which cannot apply twice.',
      { preview_session_id: state.preview_session_id, operation_id: state.pending?.operation_id },
    );
  }
  // The platform evaluated the request and refused it: that operation did not
  // apply, so it is no longer pending. A preview this command only just began
  // tracking on the caller's word is not kept after a refusal.
  if (forgetOnRefusal) clearPreviewState(cwd, project.projectId, state.preview_session_id);
  else savePreviewState({ ...state, pending: null });
  const apiErr = err as CliApiError;
  const data = isRecord(apiErr.data) ? apiErr.data : {};
  const suffix = commandPrefix(opts, project.ref);
  if (isBuildError(apiErr) && !opts.json) renderBuildError(apiErr, cwd);
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

async function startCommand(opts: LifecycleOptions): Promise<void> {
  const client = new ApiClient(getToken());
  const cwd = process.cwd();
  const project = await resolveProject(client, opts.project);
  const collected = collectFiles(cwd);
  const digest = snapshotDigest(collected);
  let state = loadPreviewState(cwd, project.projectId);
  let note: string | null = null;
  let sessionId = `draft_${randomUUID()}`;
  let opId = operationId();

  if (state) {
    const settled = await reconcilePending(client, state);
    state = settled.state;
    if (settled.adopted?.kind === 'start' && settled.adopted.snapshot_digest === digest) {
      // The earlier start did land; its response was lost. Nothing to send.
      await reportPreview({
        client, cwd, opts, project, state, action: 'start', res: null,
        note: 'An earlier start of this preview had completed; its response was lost. Nothing new was sent.',
      });
      return;
    }
    const view = await readSession(client, project.projectId, state.preview_session_id);
    // Unfinished: its first snapshot was never confirmed (lost response, or
    // refused — e.g. a build error). Finish THAT session rather than open a
    // second one.
    const unfinished = state.pending?.kind === 'start' || state.preview_id === null;
    if (view?.status === 'promoting' || (view?.status === 'open' && (!unfinished || view.preview_id !== null))) {
      throw new PreviewRefusal(
        'PREVIEW_ALREADY_TRACKED',
        `This directory is already working on preview ${view.preview_session_id} (${view.status}). `
          + `Run \`somewhere preview update${commandPrefix(opts, project.ref)}\` to send your files to it, `
          + `or \`somewhere preview close${commandPrefix(opts, project.ref)}\` first to start over.`,
        { preview_session_id: view.preview_session_id, preview_id: view.preview_id, status: view.status },
      );
    }
    if (unfinished && (!view || (view.status === 'open' && view.base_is_production))) {
      sessionId = state.preview_session_id;
      if (state.pending?.kind === 'start' && state.pending.snapshot_digest === digest) opId = state.pending.operation_id;
      note = `Finishing the preview an earlier start began (${sessionId}).`;
    } else if (unfinished && view?.status === 'open') {
      // It never got a version and production moved on since it began, so it
      // can never take a first snapshot. Close exactly it and begin again.
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

  state = savePreviewState({
    dir: cwd,
    project_id: project.projectId,
    preview_session_id: sessionId,
    preview_id: null,
    base_release_id: baseReleaseId,
    expires_at: null,
    pending: { kind: 'start', operation_id: opId, expected_preview_id: null, snapshot_digest: digest },
  });
  await sendSnapshot({ client, cwd, opts, project, state, collected, baseReleaseId, action: 'start', note });
}

async function updateCommand(opts: LifecycleOptions): Promise<void> {
  const client = new ApiClient(getToken());
  const cwd = process.cwd();
  const project = await resolveProject(client, opts.project);
  let state = loadPreviewState(cwd, project.projectId);
  const wasTracked = state !== null;
  const suffix = commandPrefix(opts, project.ref);

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

  let adopted: PendingPreviewOperation | null = null;
  if (state) {
    const settled = await reconcilePending(client, state);
    state = settled.state;
    adopted = settled.adopted;
    if (state.pending?.kind === 'start') {
      throw new PreviewRefusal(
        'PREVIEW_NOT_STARTED',
        `This directory's preview was never confirmed as started. Run \`somewhere preview start${suffix}\` to finish starting it.`,
        { preview_session_id: state.preview_session_id },
      );
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
  const collected = collectFiles(cwd);
  const digest = snapshotDigest(collected);
  if (state && adopted && adopted.snapshot_digest === digest && !opts.expect) {
    // The earlier update did land; its response was lost. Nothing to send.
    await reportPreview({
      client, cwd, opts, project, state, action: 'update', res: null,
      note: 'An earlier update with these exact files had completed; its response was lost. Nothing new was sent.',
    });
    return;
  }
  const prior = state?.pending;
  const reuse = prior && prior.kind === 'update'
    && prior.snapshot_digest === digest
    && prior.expected_preview_id === expected;
  // An identical re-send of an unconfirmed operation reuses its id, so it cannot
  // apply twice. A different change gets a new id; if the earlier one did land,
  // the platform refuses this one as stale rather than stacking on top of it.
  state = savePreviewState({
    dir: cwd,
    project_id: project.projectId,
    preview_session_id: sessionId,
    preview_id: state?.preview_id ?? expected,
    base_release_id: state?.base_release_id ?? null,
    expires_at: state?.expires_at ?? null,
    pending: {
      kind: 'update',
      operation_id: reuse ? prior.operation_id : operationId(),
      expected_preview_id: expected,
      snapshot_digest: digest,
    },
  });
  await sendSnapshot({
    client, cwd, opts, project, state, collected, baseReleaseId: null, action: 'update',
    forgetOnRefusal: !wasTracked,
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
  const client = new ApiClient(getToken());
  const cwd = process.cwd();
  const project = await resolveProject(client, opts.project);
  let state = loadPreviewState(cwd, project.projectId);
  const id = resolveIdentity(opts, project, state);
  if (state && state.preview_session_id === id) state = (await reconcilePending(client, state)).state;
  const view = await readSession(client, project.projectId, id);
  const tracked = state?.preview_session_id === id;
  if (!view) {
    throw new PreviewRefusal(
      'DRAFT_NOT_FOUND',
      `Preview ${id} does not exist in this project.${tracked ? ` Run \`somewhere preview close${commandPrefix(opts, project.ref)}\` to stop tracking it here.` : ''}`,
      { preview_session_id: id, tracked_here: tracked },
    );
  }
  const result = {
    ok: true,
    project_id: project.projectId,
    ...view,
    tracking: {
      tracked_here: tracked,
      dir: canonicalDir(cwd),
      local_preview_id: tracked ? state!.preview_id : null,
      in_sync: tracked ? state!.preview_id === view.preview_id : null,
      pending_operation: tracked ? state!.pending : null,
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
  if (tracked && state!.preview_id !== view.preview_id) {
    warn(`This directory last saw ${state!.preview_id ?? 'no version'}; the preview is at ${view.preview_id ?? 'no version'}.`);
  }
}

async function listCommand(opts: LifecycleOptions): Promise<void> {
  const client = new ApiClient(getToken());
  const cwd = process.cwd();
  const project = await resolveProject(client, opts.project);
  const state = loadPreviewState(cwd, project.projectId);
  const status = await client.call<Record<string, unknown>>('GET', '/deploy/status', undefined, {
    project_id: project.projectId,
  });
  const listed: unknown[] = Array.isArray(status?.previews) ? status.previews : [];
  const previews = listed
    .filter((preview): preview is Record<string, unknown> => isRecord(preview))
    .map((preview): Record<string, unknown> & { tracked_here: boolean } => ({
      ...preview,
      tracked_here: preview.preview_session_id === state?.preview_session_id,
    }));
  const result = {
    ok: true,
    project_id: project.projectId,
    production_release_id: status?.published === true && typeof status.active_release_id === 'string'
      ? status.active_release_id
      : null,
    previews,
    tracked_here: state?.preview_session_id ?? null,
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
  if (state && !previews.some((preview) => preview.tracked_here)) {
    info(dim(`This directory tracks ${state.preview_session_id}, which is not open and ready; check it with \`somewhere preview status\`.`));
  }
}

async function closeCommand(opts: LifecycleOptions): Promise<void> {
  const client = new ApiClient(getToken());
  const cwd = process.cwd();
  const project = await resolveProject(client, opts.project);
  const state = loadPreviewState(cwd, project.projectId);
  const id = resolveIdentity(opts, project, state);
  const retry = `somewhere preview close --session ${id}${commandPrefix(opts, project.ref)}`;
  let res: Record<string, unknown>;
  try {
    res = await client.call<Record<string, unknown>>('POST', '/deploy/preview/close', {
      project_id: project.projectId,
      preview_session_id: id,
    });
  } catch (err) {
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
  const removed = clearPreviewState(cwd, project.projectId, id);
  const cleanupPending = res.cleanup_pending === true;
  const result = {
    ok: true,
    project_id: project.projectId,
    ...res,
    preview_session_id: id,
    tracking_removed: removed,
    ...(cleanupPending ? { retry_cleanup: retry } : {}),
  };
  if (opts.json) {
    printJson(result);
    return;
  }
  success(`Preview ${id} is closed${res.idempotent_replay === true ? ' (it already was)' : ''}. Production and other previews are unchanged.`);
  if (cleanupPending) info(`Its cleanup is still finishing; run \`${retry}\` to retry it.`);
  if (removed) info(dim('This directory no longer tracks a preview.'));
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
    .description('Send this directory\'s complete source to its preview, replacing exactly the version it last saw. Refused, with nothing changed, if the preview moved on.')
    .option('--project <id>', 'Override project ID')
    .option('--session <preview_session_id>', 'Name the preview explicitly (requires --expect)')
    .option('--expect <preview_id>', 'The exact preview version you expect to replace')
    .option('--json', 'Print a typed JSON result')
    .action(run(updateCommand));
  preview.command('status')
    .description('Read one exact preview in any state: open, promoting, promoted, closed, or expired.')
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
    .description('Close one exact preview: its sign-in links stop working and its database copy and files are cleaned up. Production and other previews are untouched. Safe to repeat.')
    .option('--project <id>', 'Override project ID')
    .option('--session <preview_session_id>', 'Close this preview instead of the one this directory tracks')
    .option('--json', 'Print a typed JSON result')
    .action(run(closeCommand));
}

/** For `somewhere promote`: stop tracking a preview that promotion finished. */
export function untrackPromotedPreview(dir: string, projectIds: string[], previewSessionId: string): boolean {
  let removed = false;
  for (const projectId of new Set(projectIds)) {
    try {
      removed = clearPreviewState(dir, projectId, previewSessionId) || removed;
    } catch {
      // An unreadable record is left for the user; promotion already succeeded.
    }
  }
  return removed;
}

