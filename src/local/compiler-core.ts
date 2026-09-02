/**
 * Direct access to the pure half of the vendored compiler.
 *
 * compile-core.cjs splits on one question — does this need to know where
 * things are installed? Everything that does not is exported at module scope
 * and takes no host: detectTailwind, isFunctionPath, the dependency review.
 * The CLI needs detectTailwind BEFORE it can build a host at all (which
 * Tailwind engine to put in the toolchain cache is decided by the project's
 * own CSS), so it reads those directly rather than constructing a compiler to
 * ask.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CompileCorePure {
  /** 4, 3, or 0 — decided from the project's CSS and config, same as on deploy. */
  detectTailwind: (files: Record<string, string>) => number;
  /** Mirror of the deploy pipeline's function/static split. */
  isFunctionPath: (path: string) => boolean;
  /** sha256 over a canonical compile input. */
  sourceDigest: (body: Record<string, unknown>) => string;
}

let cached: CompileCorePure | null = null;

function vendoredRoot(root?: string): string {
  return root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function readCompileCore(root?: string): CompileCorePure {
  if (cached) return cached;
  const corePath = join(vendoredRoot(root), 'runtime', 'compiler', 'compile-core.cjs');
  cached = createRequire(corePath)('./compile-core.cjs') as CompileCorePure;
  return cached;
}

let cachedPlatformModules: readonly string[] | null = null;

/**
 * The specifiers the PLATFORM provides, read from the vendored compiler's own
 * `PLATFORM_MODULES` — the single enumeration that also builds the compiler's
 * virtual-module resolver and its phantom-import exemption. Reading it here
 * rather than restating it is the point: a hand-kept second list is how the CLI
 * ends up telling a developer that `somewhere/db` is a missing npm package
 * (tsk_53badecfb7).
 *
 * Never throws. A CLI whose diagnostics depend on this must still be able to
 * print a diagnostic when the vendored file cannot be read.
 */
export function readPlatformModules(root?: string): readonly string[] {
  if (cachedPlatformModules) return cachedPlatformModules;
  try {
    const path = join(vendoredRoot(root), 'runtime', 'compiler', 'typed-functions.cjs');
    const mod = createRequire(path)('./typed-functions.cjs') as { PLATFORM_MODULES?: string[] };
    cachedPlatformModules = Array.isArray(mod.PLATFORM_MODULES) ? mod.PLATFORM_MODULES : [];
  } catch {
    cachedPlatformModules = [];
  }
  return cachedPlatformModules;
}
