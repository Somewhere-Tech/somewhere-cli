import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { cliConfigDir } from './config.js';

/**
 * Which preview THIS directory is working on.
 *
 * Kept in the CLI config directory under previews/, keyed by the directory's
 * real path and the project id — never in `.somewhere.json`, which is often
 * committed and shared. Two checkouts of one project therefore never share a
 * preview, and copying a checkout does not copy its preview. Holds ids, one
 * unconfirmed operation, and that operation's exact request: never a sign-in
 * link or a token.
 *
 * Every read-modify-write of a record happens inside withPreviewLock, so two
 * commands in one directory cannot both mint a preview or drop each other's
 * pending operation.
 */
export interface PendingPreviewOperation {
  kind: 'start' | 'update';
  operation_id: string;
  expected_preview_id: string | null;
  snapshot_digest: string;
  /** Integrity check for the exact request stored beside this record. */
  payload_sha256: string;
}

export interface PreviewClosedReceipt {
  at: string;
  cleanup_pending: boolean;
}

export interface PreviewTrackingState {
  version: 1;
  dir: string;
  project_id: string;
  preview_session_id: string;
  preview_id: string | null;
  base_release_id: string | null;
  expires_at: string | null;
  /** Written BEFORE a request is sent, cleared only once the platform's own
   * record settles it. */
  pending: PendingPreviewOperation | null;
  /** Kept after close while the platform still reports cleanup pending, so a
   * plain `somewhere preview close` can retry it. Never an active preview. */
  closed: PreviewClosedReceipt | null;
  updated_at: string;
}

export type PreviewStateInput = Omit<PreviewTrackingState, 'version' | 'dir' | 'updated_at' | 'closed'> & {
  dir: string;
  closed?: PreviewClosedReceipt | null;
};

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

export class PreviewBusyError extends Error {
  readonly code = 'PREVIEW_BUSY';

  constructor(readonly holder: { pid?: number; host?: string; started_at?: string; command?: string } | null) {
    super(
      'Another `somewhere preview` command is working on this directory\'s preview'
      + `${holder?.pid ? ` (process ${holder.pid}${holder.command ? `, ${holder.command}` : ''})` : ''}. `
      + 'Nothing was sent. Run this command again when it finishes.',
    );
    this.name = 'PreviewBusyError';
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

function recordKey(dir: string, projectId: string): string {
  return createHash('sha256').update(`${canonicalDir(dir)}\0${projectId}`).digest('hex');
}

export function previewStatePath(dir: string, projectId: string): string {
  return join(previewStateDir(), `${recordKey(dir, projectId)}.json`);
}

function lockPath(dir: string, projectId: string): string {
  return join(previewStateDir(), `${recordKey(dir, projectId)}.lock`);
}

function payloadPath(dir: string, projectId: string): string {
  return join(previewStateDir(), `${recordKey(dir, projectId)}.pending-request.json`);
}

function ensureStateDir(): string {
  const root = previewStateDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

function atomicWrite(path: string, text: string): void {
  const temp = join(ensureStateDir(), `.${randomUUID()}.tmp`);
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function isState(value: unknown, dir: string, projectId: string): value is PreviewTrackingState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const pending = v.pending as Record<string, unknown> | null | undefined;
  const closed = v.closed as Record<string, unknown> | null | undefined;
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
      && typeof pending.payload_sha256 === 'string'
    ))
    && (closed === null || closed === undefined || (
      typeof closed === 'object' && typeof closed.cleanup_pending === 'boolean'
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
  return { ...parsed, closed: parsed.closed ?? null };
}

/** Atomic replace: write a private temp file beside the target, then rename. */
export function savePreviewState(state: PreviewStateInput): PreviewTrackingState {
  const full: PreviewTrackingState = {
    version: 1,
    dir: canonicalDir(state.dir),
    project_id: state.project_id,
    preview_session_id: state.preview_session_id,
    preview_id: state.preview_id,
    base_release_id: state.base_release_id,
    expires_at: state.expires_at,
    pending: state.pending,
    closed: state.closed ?? null,
    updated_at: new Date().toISOString(),
  };
  atomicWrite(previewStatePath(state.dir, state.project_id), `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

/** Stop tracking — only when the record still names the given session. */
export function clearPreviewState(dir: string, projectId: string, previewSessionId: string): boolean {
  let current: PreviewTrackingState | null;
  try {
    current = loadPreviewState(dir, projectId);
  } catch {
    return false;
  }
  if (!current || current.preview_session_id !== previewSessionId) return false;
  removeIfPresent(payloadPath(dir, projectId));
  removeIfPresent(previewStatePath(dir, projectId));
  return true;
}

/**
 * Keep the exact request of an operation that is about to be sent, so an
 * unconfirmed operation is only ever re-sent byte-for-byte — never rebound to
 * newer files under the same operation id. Returns its integrity hash.
 */
export function savePendingRequest(dir: string, projectId: string, body: Record<string, unknown>): string {
  const text = JSON.stringify(body);
  atomicWrite(payloadPath(dir, projectId), text);
  return createHash('sha256').update(text).digest('hex');
}

export function loadPendingRequest(dir: string, projectId: string, sha256: string): Record<string, unknown> {
  const path = payloadPath(dir, projectId);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new PreviewStateUnreadableError(path);
  }
  if (createHash('sha256').update(text).digest('hex') !== sha256) throw new PreviewStateUnreadableError(path);
  return JSON.parse(text) as Record<string, unknown>;
}

export function clearPendingRequest(dir: string, projectId: string): void {
  removeIfPresent(payloadPath(dir, projectId));
}

interface LockHolder {
  token: string;
  pid: number;
  host: string;
  started_at: string;
  command?: string;
}

const FOREIGN_HOST_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const TORN_LOCK_GRACE_MS = 30 * 1000;

function readHolder(path: string): LockHolder | 'gone' | 'torn' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as LockHolder;
    return typeof parsed.token === 'string' && typeof parsed.pid === 'number' ? parsed : 'torn';
  } catch {
    return 'torn';
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock whose owner can no longer be running: crash recovery. */
function isStale(path: string, holder: LockHolder | 'torn'): boolean {
  if (holder === 'torn') {
    try {
      return Date.now() - statSync(path).mtimeMs > TORN_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (holder.host === hostname()) return !processAlive(holder.pid);
  return Date.now() - Date.parse(holder.started_at) > FOREIGN_HOST_LOCK_TTL_MS;
}

function acquireLock(path: string, command: string): string {
  ensureStateDir();
  const token = randomUUID();
  const mine: LockHolder = { token, pid: process.pid, host: hostname(), started_at: new Date().toISOString(), command };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readHolder(path);
    if (holder === 'gone') continue;
    if (!isStale(path, holder)) throw new PreviewBusyError(holder === 'torn' ? null : holder);
    // Take the stale lock aside atomically: only one contender's rename wins.
    const aside = `${path}.stale-${randomUUID()}`;
    try {
      renameSync(path, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const moved = readHolder(aside);
    const sameStale = holder === 'torn' ? moved === 'torn' : moved !== 'gone' && moved !== 'torn' && moved.token === holder.token;
    if (!sameStale) {
      // A live lock replaced the stale one between our read and rename: put it
      // back (link fails if yet another owner appeared) and report busy.
      try {
        linkSync(aside, path);
        removeIfPresent(aside);
      } catch {
        // The path is owned again; the moved live lock stays aside, untouched.
      }
      throw new PreviewBusyError(moved === 'gone' || moved === 'torn' ? null : moved);
    }
    removeIfPresent(aside);
  }
  throw new PreviewBusyError(null);
}

function releaseLock(path: string, token: string): void {
  const holder = readHolder(path);
  if (holder !== 'gone' && holder !== 'torn' && holder.token === token) removeIfPresent(path);
}

/** Run `fn` holding this directory+project's preview lock. Refuses, without
 * waiting, when another live command holds it; recovers a crashed holder's. */
export async function withPreviewLock<T>(
  dir: string,
  projectId: string,
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  const path = lockPath(dir, projectId);
  const token = acquireLock(path, command);
  try {
    return await fn();
  } finally {
    releaseLock(path, token);
  }
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
