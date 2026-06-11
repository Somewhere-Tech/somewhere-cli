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
 * 2. Hot reload — ESM has no cache invalidation, so every project-local file
 *    URL carries a ?gen=N query. Bumping the generation makes the next
 *    import() re-evaluate the whole project module graph; the hook propagates
 *    the parent's generation to children so nothing stale survives a save.
 *
 * TypeScript runs through Node's native type stripping (>= 22.18 / 23.6).
 */
import { registerHooks } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXT_CANDIDATES = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx'];

let generation = 1;
let installedRoot: string | null = null;

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
      `somewhere dev --local needs Node >= 22.18 (or >= 23.6) for TypeScript support and module hooks — you're on ${process.versions.node}. Upgrade Node and retry.`,
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
export function installLoader(projectRoot: string): void {
  const root = resolvePath(projectRoot);
  if (installedRoot !== null) {
    installedRoot = root;
    return;
  }
  installedRoot = root;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (
        !installedRoot ||
        !parent ||
        !parent.startsWith('file://') ||
        (!specifier.startsWith('./') && !specifier.startsWith('../'))
      ) {
        return nextResolve(specifier, context);
      }

      const parentUrl = new URL(parent);
      const parentPath = fileURLToPath(`file://${parentUrl.pathname}`);
      if (!parentPath.startsWith(installedRoot)) {
        return nextResolve(specifier, context);
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
