import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

// Directories / files never uploaded. Mirrors the deploy collector.
export const IGNORE = new Set([
  'node_modules',
  '.git',
  '.somewhere.json',
  '.mcp.json',
  '.env',
  '.DS_Store',
  'dist',
  '.next',
  '.vercel',
]);

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file

export const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tar', '.br',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.m4a',
  '.wasm',
]);

// Mirror of worker/src/routes/deploy.ts:isFunctionPath. Files matching these
// patterns must ship in `functions`/`update_functions`, not `files` — otherwise
// the worker writes them to static storage and never invokes the bundler, so
// the routes never register.
export function isFunctionPath(p: string): boolean {
  if (!/\.(ts|js|mjs)$/i.test(p)) return false;
  if (p.startsWith('api/') || p.startsWith('_lib/')) return true;
  if (/^\[[^/]+\]\.(ts|js|mjs)$/.test(p)) return true;
  return false;
}

export function isBinaryPath(p: string): boolean {
  return BINARY_EXTS.has(extname(p).toLowerCase());
}

export interface CollectedFiles {
  files: Record<string, string>;
  binaryFiles: Record<string, string>;
  functions: Record<string, string>;
  /** Files intentionally NOT uploaded (too big / symlink). A deploy is a full
   *  replacement, so a silent skip DELETES the file from production — the caller
   *  must surface these, not drop them quietly. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Walk a directory tree and bucket every file into static / binary / function,
 *  applying the same path remapping the deploy command uses. */
export function collectFiles(baseDir: string): CollectedFiles {
  const out: CollectedFiles = { files: {}, binaryFiles: {}, functions: {}, skipped: [] };
  const ignore = loadDeployIgnore(baseDir);
  walk(baseDir, baseDir, out, ignore);
  return out;
}

function walk(baseDir: string, currentDir: string, out: CollectedFiles, ignore: DeployIgnoreMatcher) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = join(currentDir, entry.name);
    const relPath = toDeployPath(relative(baseDir, fullPath));
    if (
      IGNORE.has(entry.name) ||
      entry.name.startsWith('.') ||
      ignore.ignores(relPath, entry.isDirectory())
    ) {
      continue;
    }

    // Symlinks are neither isFile() nor isDirectory() (lstat), so they'd fall
    // through silently — record and skip (we never follow them: they can escape
    // the project root).
    if (entry.isSymbolicLink()) {
      out.skipped.push({ path: relPath, reason: 'symlink (not followed)' });
      continue;
    }
    if (entry.isDirectory()) {
      walk(baseDir, fullPath, out, ignore);
      continue;
    }
    if (!entry.isFile()) continue;
    const size = statSync(fullPath).size;
    if (size > MAX_FILE_SIZE) {
      out.skipped.push({
        path: relPath,
        reason: `${formatBytes(size)} exceeds the ${formatBytes(MAX_FILE_SIZE)} per-file limit`,
      });
      continue;
    }

    classifyInto(out, baseDir, relPath);
  }
}

export type FileKind = 'static' | 'binary' | 'function';

/** The deploy key + bucket a relative path maps to. `functions/`-prefixed paths
 *  are stripped to their route; root-level api/_lib/[param] paths are functions. */
export function classifyKey(relPath: string): { kind: FileKind; key: string } {
  // Deploy keys are always POSIX/forward-slash. The worker's function detection
  // (api/, _lib/), the `functions/` prefix strip, and the bundler's index.html
  // entry matching all key off '/'. On Windows node:path hands back backslashes
  // (relative()/readdir join), so a raw win32 key ships as `src\App.jsx` /
  // `api\login.ts` → functions upload as static, entries never match →
  // DEPLOY_BLANK_PAGE. Normalize here: the single chokepoint every collector
  // (deploy, check, dev live-sync) routes its keys through. Disk reads still use
  // the original path via join(), which is win32-safe.
  relPath = toDeployPath(relPath);
  if (relPath.startsWith('functions/')) {
    return { kind: 'function', key: relPath.slice('functions/'.length) };
  }
  if (isFunctionPath(relPath)) {
    return { kind: 'function', key: relPath };
  }
  const staticPath = relPath.startsWith('public/')
    ? relPath.slice('public/'.length)
    : relPath;
  if (isBinaryPath(staticPath)) {
    return { kind: 'binary', key: staticPath };
  }
  return { kind: 'static', key: staticPath };
}

/** Read one file off disk and place it in the right bucket of `out`. */
export function classifyInto(out: CollectedFiles, baseDir: string, relPath: string) {
  const fullPath = join(baseDir, relPath);
  const { kind, key } = classifyKey(relPath);
  if (kind === 'function') {
    out.functions[key] = readFileSync(fullPath, 'utf-8');
  } else if (kind === 'binary') {
    out.binaryFiles[key] = readFileSync(fullPath).toString('base64');
  } else {
    out.files[key] = readFileSync(fullPath, 'utf-8');
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toDeployPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

interface DeployIgnoreRule {
  negate: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  hasSlash: boolean;
  regex: RegExp;
}

class DeployIgnoreMatcher {
  constructor(private readonly rules: DeployIgnoreRule[]) {}

  ignores(relPath: string, isDirectory: boolean): boolean {
    let ignored = false;
    const normalized = toDeployPath(relPath);
    for (const rule of this.rules) {
      if (!matchesIgnoreRule(rule, normalized, isDirectory)) continue;
      ignored = !rule.negate;
    }
    return ignored;
  }
}

function loadDeployIgnore(baseDir: string): DeployIgnoreMatcher {
  const rules: DeployIgnoreRule[] = [];
  for (const fileName of ['.gitignore', '.somewhereignore']) {
    const path = join(baseDir, fileName);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const rule = parseIgnoreRule(raw);
      if (rule) rules.push(rule);
    }
  }
  return new DeployIgnoreMatcher(rules);
}

function parseIgnoreRule(raw: string): DeployIgnoreRule | null {
  let pattern = raw.trim();
  if (!pattern || pattern.startsWith('#')) return null;

  let escapedLeadingMarker = false;
  if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
    pattern = pattern.slice(1);
    escapedLeadingMarker = true;
  }

  const negate = !escapedLeadingMarker && pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1).trim();
  if (!pattern) return null;

  pattern = pattern.replace(/\\/g, '/');
  const anchored = pattern.startsWith('/');
  pattern = pattern.replace(/^\/+/, '');
  const directoryOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  if (!pattern) return null;

  const hasSlash = pattern.includes('/');
  return {
    negate,
    directoryOnly,
    anchored,
    hasSlash,
    regex: globToRegExp(pattern),
  };
}

function matchesIgnoreRule(
  rule: DeployIgnoreRule,
  relPath: string,
  isDirectory: boolean,
): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  if (rule.anchored || rule.hasSlash) return rule.regex.test(relPath);
  return relPath.split('/').some((segment) => rule.regex.test(segment));
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i++;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(ch);
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(ch: string): string {
  return /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
}
