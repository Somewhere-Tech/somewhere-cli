#!/usr/bin/env node
/**
 * Vendor the platform's own code out of the monorepo — the FUNCTION RUNTIME
 * and the COMPILER — so `somewhere dev` / `somewhere exec` run what deploy
 * runs, not a local reimplementation of it.
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
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

/* ─── The COMPILER ─────────────────────────────────────────────────────────
 *
 * `somewhere dev` compiles the project with the platform's OWN compiler, so
 * what renders on localhost is the deploy artifact rather than something a
 * second toolchain produced that looks similar. The compiler is the same
 * host-parameterized module the compile container runs
 * (worker/containers/compile/compile-core.cjs + its two dependency-free
 * helpers); the CLI supplies a different `host` — its own dependency cache
 * instead of the baked image — and gets identical output for the same tree.
 *
 * Copied verbatim, never adapted. The manifest below records each file's
 * sha256 and the monorepo commit, and test/compiler-vendor.test.mjs asserts
 * the shipped copy still hashes to it — so a hand-edit to the vendored
 * compiler is a failing test, not a silent local/deploy divergence.
 */
const COMPILER_FILES = ['compile-core.cjs', 'graph-contract.cjs', 'typed-functions.cjs'];
const compilerSrcDir = join(monorepo, 'worker/containers/compile');
const compilerOutDir = join(outDir, 'compiler');

// Drift guard 1: the core must still expose the host contract this CLI builds
// against. If the extraction is ever reverted (the compiler folded back into
// server.js) or the factory renamed, vendoring fails here instead of shipping
// a compiler the CLI cannot construct.
const coreSource = readFileSync(join(compilerSrcDir, 'compile-core.cjs'), 'utf8');
if (!/module\.exports\s*=\s*\{[\s\S]*\bcreateCompileCore\b/.test(coreSource)) {
  throw new Error(
    'worker/containers/compile/compile-core.cjs does not export createCompileCore. The CLI builds the ' +
      'compiler by handing it a host; without that factory there is no way to run the platform compiler ' +
      'locally. Re-vendor against a monorepo that has the compile-core extraction.',
  );
}

// Drift guard 2: esbuild is the compiler. A CLI on a different esbuild than
// the container is a compiler that produces different bytes for the same
// source — exactly the divergence the local loop exists to eliminate — and it
// would show up as a mystery parity failure, not as a version mismatch. Fail
// the vendor step instead.
const containerEsbuild = JSON.parse(readFileSync(join(compilerSrcDir, 'package.json'), 'utf8')).dependencies?.esbuild;
const cliManifestPath = join(__dirname, '..', 'package.json');
const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8'));
// The CLI runs esbuild-WASM, not native esbuild. Not a preference: the
// published CLI's supply-chain invariant is that every production dependency
// sits inside the signed artifact (validateLockedClosure), and native esbuild
// ships 24 optional PLATFORM packages of which only the build machine's own
// can ever be installed. esbuild-wasm is one platform-independent package that
// satisfies it. The VERSION must still match exactly — esbuild is the
// compiler, and the CLI/container parity fixture proves the two builds of that
// version emit identical bytes.
const cliEsbuild = cliManifest.dependencies?.['esbuild-wasm'];
if (!containerEsbuild) throw new Error('the compile container no longer pins esbuild in its dependencies');
if (cliEsbuild !== containerEsbuild) {
  throw new Error(
    `esbuild pin mismatch: the compile container pins esbuild ${containerEsbuild}, this CLI pins ` +
      `esbuild-wasm ${cliEsbuild ?? '(none)'}. The local dev loop must run the container's EXACT esbuild ` +
      'version or it compiles the same source to different bytes. Set ' +
      `"esbuild-wasm": "${containerEsbuild}" in the CLI's dependencies and re-run.`,
  );
}

/* The container's TOOLCHAIN pins. The compiler treats the build toolchain as
 * its own concern, never the app's (TOOLCHAIN_DEPS is excluded from the
 * per-build install), so the CLI must run the SAME typescript / postcss /
 * autoprefixer / tailwind versions the container does — a project's own
 * tailwind 3.3 or typescript 5.2 would compile to different CSS and resolve
 * aliases differently, which is exactly the local-vs-deploy divergence the
 * local loop exists to remove. Recorded here rather than hard-coded in the CLI
 * so a container bump reaches the local loop through re-vendoring. */
const containerDeps = JSON.parse(readFileSync(join(compilerSrcDir, 'package.json'), 'utf8')).dependencies ?? {};
const tw4Deps = JSON.parse(readFileSync(join(compilerSrcDir, 'tw4', 'package.json'), 'utf8')).dependencies ?? {};
const toolchain = {
  base: {
    typescript: containerDeps.typescript,
    postcss: containerDeps.postcss,
    autoprefixer: containerDeps.autoprefixer,
  },
  tw3: { tailwindcss: containerDeps.tailwindcss },
  tw4: { tailwindcss: tw4Deps.tailwindcss, '@tailwindcss/postcss': tw4Deps['@tailwindcss/postcss'] },
};
for (const [group, pins] of Object.entries(toolchain)) {
  for (const [name, range] of Object.entries(pins)) {
    if (!range) throw new Error(`the compile image no longer pins ${name} (toolchain group ${group})`);
  }
}

rmSync(compilerOutDir, { recursive: true, force: true });
mkdirSync(compilerOutDir, { recursive: true });
const compilerManifest = { commit, esbuild: containerEsbuild, toolchain, files: {} };
for (const name of COMPILER_FILES) {
  const bytes = readFileSync(join(compilerSrcDir, name));
  writeFileSync(join(compilerOutDir, name), bytes);
  compilerManifest.files[name] = createHash('sha256').update(bytes).digest('hex');
}
writeFileSync(join(compilerOutDir, 'VENDOR.json'), JSON.stringify(compilerManifest, null, 2) + '\n');
console.log(
  `Vendored compiler @ ${commit} (esbuild ${containerEsbuild}) → runtime/compiler/{${COMPILER_FILES.join(', ')}}`,
);
