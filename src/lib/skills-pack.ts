import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * The agent skills pack: short SKILL.md files generated on the platform side
 * from the docs topics (somewhere.tech scripts/skills/generate.mjs) and
 * shipped inside this release as skills-pack.generated.ts, so `somewhere init`
 * works offline and the pack is pinned to the CLI version.
 *
 * Layout in a project:
 *   .agents/skills/<name>/SKILL.md   the files
 *   .claude/skills/<name>            a link to ../../.agents/skills/<name>
 *   skills-lock.json                 pack version, CLI version, file hashes
 */

export interface SkillsPackFile {
  path: string;
  sha256: string;
  content: string;
}

export interface SkillsPack {
  schema: number;
  name: string;
  version: string;
  sha256: string;
  files: SkillsPackFile[];
}

export interface SkillsLock {
  pack: string;
  version: string;
  sha256: string;
  cli: string;
  source: 'bundled' | 'docs-host';
  files: Record<string, string>;
}

export const SKILLS_DIR = '.agents/skills';
export const CLAUDE_SKILLS_DIR = '.claude/skills';
export const SKILLS_LOCK = 'skills-lock.json';

const SKILL_PATH = /^([a-z0-9][a-z0-9-]*)\/SKILL\.md$/;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Recompute every file hash and the pack digest; throw on any mismatch. */
export function verifyPack(pack: SkillsPack): SkillsPack {
  if (!pack || pack.schema !== 1 || pack.name !== 'somewhere-skills' || typeof pack.version !== 'string' || !Array.isArray(pack.files) || pack.files.length === 0) {
    throw new Error('Skills pack is malformed (expected schema 1 with files).');
  }
  const paths = new Set<string>();
  for (const file of pack.files) {
    if (typeof file.path !== 'string' || !SKILL_PATH.test(file.path)) {
      throw new Error(`Skills pack names an unexpected path: ${String(file.path)}`);
    }
    if (paths.has(file.path)) throw new Error(`Skills pack repeats ${file.path}.`);
    paths.add(file.path);
    if (typeof file.content !== 'string' || sha256(file.content) !== file.sha256) {
      throw new Error(`Skills pack file ${file.path} does not match its sha256.`);
    }
  }
  const digest = sha256(pack.files.map((f) => `${f.path}\0${f.sha256}\n`).join(''));
  if (digest !== pack.sha256 || !pack.version.endsWith(`+${digest.slice(0, 12)}`)) {
    throw new Error('Skills pack digest does not match its files.');
  }
  return pack;
}

export function skillNames(pack: SkillsPack): string[] {
  return pack.files.map((f) => SKILL_PATH.exec(f.path)![1]);
}

export function readLock(dir: string): SkillsLock | null {
  const path = join(dir, SKILLS_LOCK);
  if (!existsSync(path)) return null;
  if (isSymlink(path)) throw new Error('Skills lock must not be a symlink.');
  const lock = JSON.parse(readFileSync(path, 'utf8')) as SkillsLock;
  if (!lock || lock.pack !== 'somewhere-skills' || typeof lock.version !== 'string'
    || !lock.files || typeof lock.files !== 'object' || Array.isArray(lock.files)
    || Object.entries(lock.files).some(([file, hash]) => !/^\.agents\/skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/.test(file)
      || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Skills lock is malformed; nothing was changed.');
  }
  return lock;
}

/** Link .claude/skills/<name> to the .agents copy; copy when links are refused. */
function linkForClaude(dir: string, name: string): 'link' | 'copy' {
  const at = join(dir, CLAUDE_SKILLS_DIR, name);
  const target = join('..', '..', SKILLS_DIR, name);
  mkdirSync(join(dir, CLAUDE_SKILLS_DIR), { recursive: true });
  if (existsSync(at) || isSymlink(at)) {
    if (isSymlink(at) && readlinkSync(at) === target) return 'link';
    writeFileSync(join(at, 'SKILL.md'), readFileSync(join(dir, SKILLS_DIR, name, 'SKILL.md')));
    return 'copy';
  }
  try {
    symlinkSync(target, at, 'dir');
    return 'link';
  } catch {
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'SKILL.md'), readFileSync(join(dir, SKILLS_DIR, name, 'SKILL.md')));
    return 'copy';
  }
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export interface InstallResult {
  version: string;
  written: string[];
  removed: string[];
  claude: 'link' | 'copy';
}

/**
 * Write the pack and its lock. Only skills this pack (or the previous lock)
 * owns are touched. Local edits, same-name project skills, and symlinked
 * write paths are refused before any file is changed.
 */
export function installSkills(
  dir: string,
  pack: SkillsPack,
  opts: { cli: string; source: SkillsLock['source'] },
): InstallResult {
  verifyPack(pack);
  const previous = readLock(dir);
  const state = previous ? inspectFiles(dir, previous) : null;
  const names = skillNames(pack);
  preflightInstall(dir, pack, previous, state);
  const removed: string[] = [];
  for (const path of Object.keys(previous?.files ?? {})) {
    const match = /^\.agents\/skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(path);
    if (match && !names.includes(match[1])) {
      rmSync(join(dir, path));
      removeEmptyDir(join(dir, SKILLS_DIR, match[1]));
      const claudePath = join(dir, CLAUDE_SKILLS_DIR, match[1]);
      if (isSymlink(claudePath)) rmSync(claudePath);
      else if (existsSync(claudePath)) {
        rmSync(join(claudePath, 'SKILL.md'));
        removeEmptyDir(claudePath);
      }
      removed.push(match[1]);
    }
  }
  const files: Record<string, string> = {};
  let claude: 'link' | 'copy' = 'link';
  for (const file of pack.files) {
    const rel = `${SKILLS_DIR}/${file.path}`;
    mkdirSync(join(dir, SKILLS_DIR, SKILL_PATH.exec(file.path)![1]), { recursive: true });
    writeFileSync(join(dir, rel), file.content);
    files[rel] = file.sha256;
    if (linkForClaude(dir, SKILL_PATH.exec(file.path)![1]) === 'copy') claude = 'copy';
  }
  const lock: SkillsLock = {
    pack: pack.name,
    version: pack.version,
    sha256: pack.sha256,
    cli: opts.cli,
    source: opts.source,
    files,
  };
  writeFileSync(join(dir, SKILLS_LOCK), `${JSON.stringify(lock, null, 2)}\n`);
  return {
    version: pack.version,
    written: Object.keys(files),
    removed,
    claude,
  };
}

function removeEmptyDir(path: string): void {
  try { rmdirSync(path); } catch { /* Extra project files keep their directory. */ }
}

function preflightInstall(dir: string, pack: SkillsPack, previous: SkillsLock | null,
  state: { missing: string[]; modified: string[] } | null): void {
  const conflicts = [...(state?.missing ?? []), ...(state?.modified ?? [])];
  for (const path of ['.agents', SKILLS_DIR, '.claude', CLAUDE_SKILLS_DIR]) {
    const full = join(dir, path);
    if (isSymlink(full) || (existsSync(full) && !lstatSync(full).isDirectory())) conflicts.push(path);
  }
  const names = new Set([...skillNames(pack), ...Object.keys(previous?.files ?? {})
    .map(path => path.split('/')[2])]);
  for (const name of names) {
    const rel = `${SKILLS_DIR}/${name}/SKILL.md`;
    const at = join(dir, SKILLS_DIR, name);
    const owned = previous?.files[rel];
    if (isSymlink(at) || isSymlink(join(dir, rel)) || (existsSync(at) && !owned)) conflicts.push(at);
    const claude = join(dir, CLAUDE_SKILLS_DIR, name);
    if (isSymlink(claude)) {
      if (!owned || readlinkSync(claude) !== join('..', '..', SKILLS_DIR, name)) conflicts.push(claude);
    } else if (existsSync(claude)) {
      const copy = join(claude, 'SKILL.md');
      if (!owned || isSymlink(copy) || !existsSync(copy)
        || sha256(readFileSync(copy, 'utf8')) !== owned) conflicts.push(claude);
    }
  }
  if (conflicts.length) throw new Error(`Skills conflict; nothing changed: ${[...new Set(conflicts)].join(', ')}. Preserve your edits or move conflicting skills before updating.`);
}

function inspectFiles(dir: string, lock: SkillsLock): { missing: string[]; modified: string[] } {
  const missing: string[] = [];
  const modified: string[] = [];
  for (const [path, hash] of Object.entries(lock.files)) {
    const full = join(dir, path);
    if (!existsSync(full)) missing.push(path);
    else if (sha256(readFileSync(full, 'utf8')) !== hash) modified.push(path);
  }
  return { missing, modified };
}

export type SkillsState = 'current' | 'stale' | 'modified' | 'missing' | 'unknown';

export interface SkillsStatus {
  state: SkillsState;
  installed: string | null;
  bundled: string;
  latest: string | null;
  cli: string;
  lock_cli: string | null;
  missing: string[];
  modified: string[];
  message: string;
}

/**
 * modified = a skill file was edited or deleted after install;
 * missing  = no skills-lock.json;
 * current / stale = the lock matches (or not) the pack the docs host serves
 *   now, or — when the host cannot be reached — this CLI's bundled pack;
 * unknown  = offline, and the installed pack came from the docs host, so
 *   this CLI cannot tell whether it is still the latest.
 */
export function skillsStatus(
  dir: string,
  bundled: SkillsPack,
  cli: string,
  latest: SkillsPack | null,
): SkillsStatus {
  const lock = readLock(dir);
  const base = { bundled: bundled.version, latest: latest?.version ?? null, cli };
  if (!lock) {
    return {
      ...base, state: 'missing', installed: null, lock_cli: null, missing: [], modified: [],
      message: 'No skills installed here. Run `somewhere skills update` to add them.',
    };
  }
  const { missing, modified } = inspectFiles(dir, lock);
  const common = { ...base, installed: lock.version, lock_cli: lock.cli, missing, modified };
  if (missing.length || modified.length) {
    return {
      ...common, state: 'modified',
      message: `${missing.length + modified.length} skill file(s) differ from the installed pack. \`somewhere skills update\` preserves conflicts; review your edits first.`,
    };
  }
  const reference = latest ?? bundled;
  if (lock.version === reference.version) {
    return { ...common, state: 'current', message: `Skills ${lock.version} match ${latest ? 'the latest pack' : `the pack in CLI ${cli}`}.` };
  }
  if (!latest && lock.source === 'docs-host') {
    return {
      ...common, state: 'unknown',
      message: `Skills ${lock.version} came from the docs host, which could not be reached to check for a newer pack.`,
    };
  }
  return {
    ...common, state: 'stale',
    message: `Skills ${lock.version} are out of date (latest ${reference.version}). Run \`somewhere skills update\`.`,
  };
}

export const DOCS_BASE = 'https://somewhere.tech';

/**
 * The pack the docs host serves now, hash-verified. null when the host is
 * unreachable or has no pack (offline, or a host that predates the route);
 * a pack that fails verification THROWS — it is never installed.
 */
export async function fetchLatestPack(timeoutMs = 5000): Promise<SkillsPack | null> {
  const configured = process.env.SOMEWHERE_DOCS_BASE;
  if (configured && configured.replace(/\/$/, '') !== DOCS_BASE) {
    throw new Error('Skills updates require the trusted https://somewhere.tech origin. Checksums verify integrity, not publisher authenticity.');
  }
  let res: Response;
  try {
    res = await fetch(`${DOCS_BASE}/skills/pack.json`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The docs host answered ${res.status} for the skills pack.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('The docs host returned a skills pack that is not JSON.');
  }
  return verifyPack(body as SkillsPack);
}
