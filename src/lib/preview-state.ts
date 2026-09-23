import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { cliConfigDir } from './config.js';

/**
 * Which preview THIS directory is working on.
 *
 * Kept under ~/.somewhere/previews, keyed by the directory's real path and the
 * project id — never in `.somewhere.json`, which is often committed and shared.
 * Two checkouts of one project therefore never share a preview, and copying a
 * checkout does not copy its preview. Holds ids only: no sign-in link, no
 * token.
 */
export interface PendingPreviewOperation {
  kind: 'start' | 'update';
  operation_id: string;
  expected_preview_id: string | null;
  snapshot_digest: string;
}

export interface PreviewTrackingState {
  version: 1;
  dir: string;
  project_id: string;
  preview_session_id: string;
  preview_id: string | null;
  base_release_id: string | null;
  expires_at: string | null;
  /** Written BEFORE a request is sent, cleared once its outcome is known. A
   * later command reconciles it against the exact session so a lost response
   * is never re-sent as a second change. */
  pending: PendingPreviewOperation | null;
  updated_at: string;
}

export class PreviewStateUnreadableError extends Error {
  readonly code = 'PREVIEW_STATE_UNREADABLE';

  constructor(readonly path: string) {
    super(
      `This directory's preview record at ${path} could not be read, so no preview was chosen. `
      + 'Move that file aside to stop tracking it here, or pass --session and --expect explicitly.',
    );
    this.name = 'PreviewStateUnreadableError';
  }
}

export function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

export function previewStateDir(): string {
  return join(cliConfigDir(), 'previews');
}

export function previewStatePath(dir: string, projectId: string): string {
  const key = createHash('sha256')
    .update(`${canonicalDir(dir)}\0${projectId}`)
    .digest('hex');
  return join(previewStateDir(), `${key}.json`);
}

function isState(value: unknown, dir: string, projectId: string): value is PreviewTrackingState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const pending = v.pending as Record<string, unknown> | null | undefined;
  return v.version === 1
    && v.dir === canonicalDir(dir)
    && v.project_id === projectId
    && typeof v.preview_session_id === 'string'
    && (v.preview_id === null || typeof v.preview_id === 'string')
    && (pending === null || (
      typeof pending === 'object'
      && (pending.kind === 'start' || pending.kind === 'update')
      && typeof pending.operation_id === 'string'
      && typeof pending.snapshot_digest === 'string'
    ));
}

/** The tracked preview for this directory + project, or null when none. A
 * record that exists but cannot be trusted is an error, never "none": treating
 * it as absent would let a later start silently replace a live preview. */
export function loadPreviewState(dir: string, projectId: string): PreviewTrackingState | null {
  const path = previewStatePath(dir, projectId);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new PreviewStateUnreadableError(path);
  }
  if (!isState(parsed, dir, projectId)) throw new PreviewStateUnreadableError(path);
  return parsed;
}

/** Atomic replace: write a private temp file beside the target, then rename. */
export function savePreviewState(state: Omit<PreviewTrackingState, 'version' | 'dir' | 'updated_at'> & { dir: string }): PreviewTrackingState {
  const root = previewStateDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const full: PreviewTrackingState = {
    version: 1,
    dir: canonicalDir(state.dir),
    project_id: state.project_id,
    preview_session_id: state.preview_session_id,
    preview_id: state.preview_id,
    base_release_id: state.base_release_id,
    expires_at: state.expires_at,
    pending: state.pending,
    updated_at: new Date().toISOString(),
  };
  const path = previewStatePath(state.dir, state.project_id);
  const temp = join(root, `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return full;
}

/** Stop tracking — only when the record still names the given session, so a
 * command never erases a record another command just replaced. */
export function clearPreviewState(dir: string, projectId: string, previewSessionId: string): boolean {
  const path = previewStatePath(dir, projectId);
  let current: PreviewTrackingState | null;
  try {
    current = loadPreviewState(dir, projectId);
  } catch {
    return false;
  }
  if (!current || current.preview_session_id !== previewSessionId) return false;
  unlinkSync(path);
  return true;
}

/** One digest of the complete snapshot: sorted kind/path/content hashes. */
export function snapshotDigest(snapshot: {
  files: Record<string, string>;
  binaryFiles: Record<string, string>;
  functions: Record<string, string>;
}): string {
  const hash = createHash('sha256');
  for (const [kind, map] of [
    ['file', snapshot.files],
    ['binary', snapshot.binaryFiles],
    ['function', snapshot.functions],
  ] as const) {
    for (const path of Object.keys(map).sort()) {
      hash.update(`${kind}\0${path}\0${createHash('sha256').update(map[path]).digest('hex')}\n`);
    }
  }
  return `sha256:${hash.digest('hex')}`;
}
