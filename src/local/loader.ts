/**
 * Module loading for the local function runtime.
 *
 * Two jobs the deployed runtime gets for free from the platform compiler:
 *
 * 1. Extensionless cross-file imports — `import { db } from '../_lib/db'`
 *    works deployed; Node ESM requires extensions. A resolve hook tries the
 *    same candidates the platform accepts (.ts/.tsx/.mts/.js/.mjs/.jsx and
 *    directory index files) for relative imports originating inside the
 *    project.
 *
 * 2. Bare specifiers the project has not installed — `import { createClient }
 *    from '@somewhere-tech/sdk'` in api/data.ts. Deployed, the platform
 *    resolves it; locally, Node looks only in the project's node_modules, so a
 *    project that has never run `npm install` renders its frontend fine (the
 *    compiler resolves the app's dependencies into the CLI's cache) and then
 *    500s on every function with ERR_MODULE_NOT_FOUND — the loop half-working
 *    in the most confusing possible way (tsk_3269026d). A bare specifier Node
 *    cannot find is retried against the SAME search path the compiler used, by
 *    re-resolving with a parentURL rooted in each cache dir so package
 *    `exports` maps and subpaths behave exactly as Node would. The project's
 *    own node_modules always wins; the cache is a fallback, never an override.
 *
 * 3. Hot reload — ESM has no cache invalidation, so every project-local file
 *    URL carries a ?gen=N query. Bumping the generation makes the next
 *    import() re-evaluate the whole project module graph; the hook propagates
 *    the parent's generation to children so nothing stale survives a save.
 *
 * TypeScript runs through Node's native type stripping (>= 22.18 / 23.6).
 */
import { registerHooks } from 'node:module';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXT_CANDIDATES = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx'];

let generation = 1;
let installedRoot: string | null = null;
/** Extra dirs to resolve bare specifiers from, in order, after the project. */
let fallbackModuleDirs: string[] = [];

export function bumpGeneration(): number {
  return ++generation;
}

/** file:// URL for a project entry file, stamped with the current generation. */
export function entryUrl(absPath: string): string {
  return `${pathToFileURL(absPath).href}?gen=${generation}`;
}

/**
 * Verify the running Node supports what the local runtime needs:
 * module.registerHooks + unflagged TypeScript type stripping.
 */
export function assertNodeSupport(): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  if (!ok) {
    throw new Error(
      `somewhere dev needs Node >= 22.18 (or >= 23.6) for TypeScript support and module hooks — you're on ${process.versions.node}. Upgrade Node and retry.`,
    );
  }
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveWithExtensions(base: string): string | null {
  if (isFile(base)) return base;
  for (const ext of EXT_CANDIDATES) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const ext of EXT_CANDIDATES) {
    const idx = resolvePath(base, 'index' + ext);
    if (isFile(idx)) return idx;
  }
  return null;
}

/**
 * Install the resolve hook for project files under `projectRoot`.
 * Safe to call once per process; subsequent calls just update the root.
 */
/**
 * Resolve symlinks. Node reports parentURL as a REAL path, so an installedRoot
 * that still contains a symlink never prefix-matches it and the hook silently
 * does nothing at all — no extensionless imports, no generation stamping, no
 * dependency fallback. macOS makes this the DEFAULT for anything under /tmp
 * (/tmp → /private/tmp, /var → /private/var), and a symlinked project
 * directory does it anywhere.
 */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function installLoader(projectRoot: string, moduleDirs: string[] = []): void {
  const root = realPath(resolvePath(projectRoot));
  // Each entry is a node_modules dir; resolve from its PARENT so Node performs
  // its normal node_modules lookup there.
  fallbackModuleDirs = moduleDirs.map((dir) => realPath(resolvePath(dir, '..')));
  if (installedRoot !== null) {
    installedRoot = root;
    return;
  }
  installedRoot = root;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (!installedRoot || !parent || !parent.startsWith('file://')) {
        return nextResolve(specifier, context);
      }
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
      // A bare specifier: not relative, not root-anchored, not a URL scheme
      // (node:, file:, data:, …).
      const isBare = !isRelative
        && !specifier.startsWith('/')
        && !/^[a-z][a-z0-9+.-]*:/i.test(specifier);
      if (!isRelative && !isBare) return nextResolve(specifier, context);

      const parentUrl = new URL(parent);
      const parentPath = fileURLToPath(`file://${parentUrl.pathname}`);
      if (!parentPath.startsWith(installedRoot)) {
        return nextResolve(specifier, context);
      }

      if (isBare) {
        try {
          // The project's own node_modules first, always.
          return nextResolve(specifier, context);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
          for (const dir of fallbackModuleDirs) {
            try {
              return nextResolve(specifier, {
                ...context,
                parentURL: pathToFileURL(resolvePath(dir, '__sw_resolve.js')).href,
              });
            } catch (fallbackErr) {
              if ((fallbackErr as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw fallbackErr;
            }
          }
          throw err;
        }
      }

      const target = resolvePath(dirname(parentPath), specifier);
      const found = resolveWithExtensions(target);
      if (!found) {
        // Let Node produce its standard (clear) ERR_MODULE_NOT_FOUND.
        return nextResolve(specifier, context);
      }

      const gen = parentUrl.searchParams.get('gen');
      const url = pathToFileURL(found).href + (gen ? `?gen=${gen}` : '');
      return { url, shortCircuit: true };
    },
  });
}
