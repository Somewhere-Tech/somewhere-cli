import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  walk(baseDir, baseDir, out);
  return out;
}

function walk(baseDir: string, currentDir: string, out: CollectedFiles) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;

    const fullPath = join(currentDir, entry.name);
    // Symlinks are neither isFile() nor isDirectory() (lstat), so they'd fall
    // through silently — record and skip (we never follow them: they can escape
    // the project root).
    if (entry.isSymbolicLink()) {
      out.skipped.push({ path: relative(baseDir, fullPath), reason: 'symlink (not followed)' });
      continue;
    }
    if (entry.isDirectory()) {
      walk(baseDir, fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const size = statSync(fullPath).size;
    if (size > MAX_FILE_SIZE) {
      out.skipped.push({
        path: relative(baseDir, fullPath),
        reason: `${formatBytes(size)} exceeds the ${formatBytes(MAX_FILE_SIZE)} per-file limit`,
      });
      continue;
    }

    const relPath = relative(baseDir, fullPath);
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
  relPath = relPath.replace(/\\/g, '/');
  if (relPath.startsWith('functions/')) {
    return { kind: 'function', key: relPath.slice('functions/'.length) };
  }
  if (isFunctionPath(relPath)) {
    return { kind: 'function', key: relPath };
  }
  if (isBinaryPath(relPath)) {
    return { kind: 'binary', key: relPath };
  }
  return { kind: 'static', key: relPath };
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
