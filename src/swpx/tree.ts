/** Resolve a project's dependency tree for `swpm install`.
 *
 *  When a lockfile is present it IS the resolved tree — the exact versions npm
 *  would install — so we read it directly (no registry round-trips, no guessing
 *  ranges). Without a lockfile we fall back to the direct deps in package.json
 *  and let the caller resolve their ranges. Parsing is split from fs reads so
 *  the lockfile/manifest parsers are unit-tested against fixture strings. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PkgRef {
  package: string;
  version: string;
}

export interface ResolvedTree {
  /** Direct dependency names from package.json (deps + devDeps + optional). */
  directNames: string[];
  /** Their declared ranges, for resolving when there's no lockfile. */
  ranges: Record<string, string>;
  /** Every concrete package@version from the lockfile; empty if none found. */
  locked: PkgRef[];
}

export function parsePackageJsonDeps(pkgJson: string): {
  directNames: string[];
  ranges: Record<string, string>;
} {
  let obj: unknown;
  try {
    obj = JSON.parse(pkgJson);
  } catch {
    return { directNames: [], ranges: {} };
  }
  const ranges: Record<string, string> = {};
  const o = obj as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const d = o?.[field];
    if (d && typeof d === 'object') {
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        if (typeof v === 'string') ranges[k] = v;
      }
    }
  }
  return { directNames: Object.keys(ranges), ranges };
}

/** Extract every concrete package@version from a package-lock.json /
 *  npm-shrinkwrap.json string. Handles lockfile v2/v3 (`packages` keyed by
 *  node_modules paths) and the older v1 (`dependencies` tree). Deduped. */
export function parseLockfile(lock: string): PkgRef[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(lock) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: PkgRef[] = [];
  const seen = new Set<string>();
  const add = (name: string, version: unknown) => {
    if (!name || typeof version !== 'string') return;
    const id = `${name}@${version}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ package: name, version });
  };

  const packages = obj.packages as Record<string, { version?: string; link?: boolean }> | undefined;
  if (packages && typeof packages === 'object') {
    for (const [key, val] of Object.entries(packages)) {
      if (!key) continue; // "" is the root project
      const idx = key.lastIndexOf('node_modules/');
      if (idx === -1) continue;
      if (val?.link) continue; // workspace symlink, not a real install
      add(key.slice(idx + 'node_modules/'.length), val?.version);
    }
    return out;
  }

  // lockfile v1: recursive `dependencies` tree.
  const walk = (deps: unknown) => {
    if (!deps || typeof deps !== 'object') return;
    for (const [name, info] of Object.entries(deps as Record<string, { version?: string; dependencies?: unknown }>)) {
      add(name, info?.version);
      walk(info?.dependencies);
    }
  };
  walk(obj.dependencies);
  return out;
}

/** Read package.json + the first lockfile we find in `dir`. Missing files yield
 *  an empty-ish tree rather than throwing — the caller decides what to do with
 *  no deps. */
export function readTree(dir: string): ResolvedTree {
  let directNames: string[] = [];
  let ranges: Record<string, string> = {};
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const parsed = parsePackageJsonDeps(readFileSync(pkgPath, 'utf-8'));
    directNames = parsed.directNames;
    ranges = parsed.ranges;
  }
  let locked: PkgRef[] = [];
  for (const lockName of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const lockPath = join(dir, lockName);
    if (existsSync(lockPath)) {
      locked = parseLockfile(readFileSync(lockPath, 'utf-8'));
      break;
    }
  }
  return { directNames, ranges, locked };
}
