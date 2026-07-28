import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export interface InitScaffoldFile {
  path: string;
  content: string;
}

export interface InitScaffoldResult {
  created: string[];
}

const INIT_METADATA = new Set([
  '.DS_Store',
  '.git',
  '.mcp.json',
  '.somewhere.json',
]);

/**
 * Rule-9 boundary for `somewhere init`: a new/empty directory receives the
 * starter, while a directory containing application source keeps the original
 * link-only behavior. Dotfiles count as source unless they are metadata the
 * init command itself owns.
 */
export function canWriteInitScaffold(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).every((name) => INIT_METADATA.has(name));
}

/**
 * Write a complete template only after every path passes confinement and
 * overwrite checks. No partial scaffold is written on a preflight failure.
 */
export function writeInitScaffold(
  dir: string,
  files: readonly InitScaffoldFile[],
): InitScaffoldResult {
  const root = resolve(dir);
  const targets = new Map<string, { path: string; content: string }>();

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.endsWith('/')) {
      throw new Error(`Invalid scaffold file path: ${file.path}`);
    }

    const target = resolve(root, normalizedPath);
    const rel = relative(root, target);
    if (rel.startsWith('..') || rel === '') {
      throw new Error(`Scaffold file escapes the project directory: ${file.path}`);
    }
    if (targets.has(target)) {
      throw new Error(`Duplicate scaffold file path: ${normalizedPath}`);
    }
    if (existsSync(target)) {
      const kind = lstatSync(target).isDirectory() ? 'directory' : 'file';
      throw new Error(`Refusing to overwrite existing ${kind}: ${normalizedPath}`);
    }
    targets.set(target, { path: normalizedPath, content: file.content });
  }

  for (const [target, file] of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, { encoding: 'utf8', flag: 'wx' });
  }

  return { created: [...targets.values()].map(({ path }) => path) };
}
