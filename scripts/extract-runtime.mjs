#!/usr/bin/env node
/**
 * Vendor the deployed-function runtime out of the platform monorepo.
 *
 * The platform's deploy pipeline embeds the entire `sw`/`ctx` runtime as JS
 * inside the worker. `somewhere dev --local` / `somewhere exec` run user
 * functions against the SAME code, so the local contract is byte-identical to
 * production. This script re-extracts both blobs into runtime/ — run it
 * whenever the worker shim changes:
 *
 *   node scripts/extract-runtime.mjs /path/to/monorepo
 *
 * Two runtime blobs, two extraction strategies:
 *
 *   SW_INIT_JS          → globalThis.sw.endpoint (auth/body/rateLimit/cors).
 *     Still a single interpolation-free template literal in
 *     worker/src/utils/function-bundle.ts; lifted by template-literal eval.
 *
 *   PLATFORM_CONTEXT_JS → buildPlatformContext(env, request), every sw.* binding.
 *     NO LONGER a single template literal: as of tsk_dfa7acc2 the worker splits
 *     it into per-namespace fragments (worker/src/runtime/<ns>.ts) assembled in
 *     worker/src/runtime/context.ts. The old string-scrape silently broke at
 *     that split — it kept finding nothing to update, so the vendored copy
 *     froze and drifted (e.g. it missed the X-Sw-Env-Slot header added in the
 *     dev/prod-slot work, leaving `dev --local`/`exec` binding PROD). We now
 *     ASSEMBLE the string exactly the way the worker does — esbuild-bundle
 *     context.ts and read its PLATFORM_CONTEXT_JS export (same technique as the
 *     worker's own scripts/check-runtime-split.mjs) — so the vendor can never
 *     again miss a fragment change. esbuild is loaded from the monorepo's own
 *     node_modules (no new CLI dependency).
 *
 * Drift guard: after assembly we assert the X-Sw-Env-Slot stamping is present
 * in the context blob and fail loudly if it vanished, so a future worker change
 * that drops slot stamping (or vendoring against a pre-slot monorepo) breaks the
 * vendor step instead of silently shipping a prod-binding local runtime.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const monorepo = process.argv[2];
if (!monorepo) {
  console.error('Usage: node scripts/extract-runtime.mjs /path/to/somewhere-monorepo');
  process.exit(1);
}

const sourcePath = join(monorepo, 'worker/src/utils/function-bundle.ts');
const src = readFileSync(sourcePath, 'utf8');

/** Lift a single interpolation-free template literal `const NAME = \`...\`.trim();`. */
function extractLiteral(name) {
  const marker = `const ${name} = \``;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker} (did the worker stop inlining ${name}?)`);
  const bodyStart = start + marker.length;
  const end = src.indexOf('`.trim();', bodyStart);
  if (end === -1) throw new Error(`unterminated template for ${name}`);
  const raw = src.slice(bodyStart, end);
  // Refuse to extract if the template gained interpolations — those would
  // need build-time values we don't have, and silent evaluation would embed
  // `undefined` into the runtime.
  if (/(^|[^\\])\$\{/.test(raw)) {
    throw new Error(`${name} now contains \${...} interpolations — extraction needs updating`);
  }
  // Evaluate as a real template literal so every escape (\`, \\, \$) resolves
  // exactly the way the worker's own template evaluation resolves it.
  // eslint-disable-next-line no-eval
  return eval('`' + raw + '`').trim();
}

/**
 * Assemble PLATFORM_CONTEXT_JS the way the worker does: esbuild-bundle
 * src/runtime/context.ts to ESM and read its PLATFORM_CONTEXT_JS export. This
 * resolves every per-namespace fragment regardless of how function-bundle.ts
 * re-exports it, so the vendor follows the runtime split automatically.
 */
async function assembleContext() {
  // esbuild lives in the monorepo's node_modules, not the CLI's — load it from
  // there so vendoring needs no new CLI dependency.
  const requireFromMonorepo = createRequire(join(monorepo, 'worker', 'package.json'));
  let esbuild;
  try {
    esbuild = requireFromMonorepo('esbuild');
  } catch {
    throw new Error(
      'esbuild not found in the monorepo (worker/node_modules). Run `npm install` in the ' +
        'monorepo first — the vendor assembles PLATFORM_CONTEXT_JS via esbuild.',
    );
  }
  const entry = join(monorepo, 'worker/src/runtime/context.ts');
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  const mod = await import(
    'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
  );
  const js = mod.PLATFORM_CONTEXT_JS;
  if (typeof js !== 'string' || js.length < 100_000) {
    throw new Error(
      `assembled PLATFORM_CONTEXT_JS is missing or suspiciously small (${js && js.length}). ` +
        'Did worker/src/runtime/context.ts stop exporting it?',
    );
  }
  return js;
}

const swInit = extractLiteral('SW_INIT_JS');
const platformContext = await assembleContext();

// Drift guard: the local runtime MUST stamp the execution slot on platform
// calls (X-Sw-Env-Slot), or `dev --local`/`exec` bind PROD for flag-enrolled
// projects. If this assertion ever fires, the worker dropped slot stamping or
// the monorepo predates it — do not ship a stale local runtime silently.
if (!platformContext.includes("'X-Sw-Env-Slot': projectEnv")) {
  throw new Error(
    'assembled PLATFORM_CONTEXT_JS does not stamp X-Sw-Env-Slot in platformFetch. ' +
      'The local runtime would bind PROD for flag-enrolled projects. Re-vendor against a ' +
      'monorepo that includes the dev/prod-slot header work (worker/src/runtime/context-head.ts).',
  );
}

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: monorepo, encoding: 'utf8' }).trim();
} catch {
  // monorepo may not be a git checkout; provenance header just says unknown
}

const header = (name, from) =>
  `// VENDORED from ${from} (${name}) @ ${commit}\n` +
  `// — the exact runtime deployed functions run against. Do not edit by hand;\n` +
  `// re-sync with: node scripts/extract-runtime.mjs <monorepo>\n`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'runtime');
mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, 'sw-init.mjs'),
  header('SW_INIT_JS', 'worker/src/utils/function-bundle.ts') + swInit + '\n',
);
writeFileSync(
  join(outDir, 'platform-context.mjs'),
  header('PLATFORM_CONTEXT_JS', 'worker/src/runtime/context.ts') +
    platformContext +
    '\n\nexport { buildPlatformContext };\n',
);

console.log(`Vendored runtime @ ${commit} → runtime/sw-init.mjs, runtime/platform-context.mjs`);
