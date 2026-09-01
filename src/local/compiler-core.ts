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

export function readCompileCore(root?: string): CompileCorePure {
  if (cached) return cached;
  const packageRoot = root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const corePath = join(packageRoot, 'runtime', 'compiler', 'compile-core.cjs');
  cached = createRequire(corePath)('./compile-core.cjs') as CompileCorePure;
  return cached;
}
