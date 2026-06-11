#!/usr/bin/env node
/**
 * Vendor the deployed-function runtime out of the platform monorepo.
 *
 * The platform's deploy pipeline embeds the entire `sw`/`ctx` runtime as two
 * JS template literals inside worker/src/utils/function-bundle.ts:
 *
 *   SW_INIT_JS          → globalThis.sw.endpoint (auth/body/rateLimit/cors wrapper)
 *   PLATFORM_CONTEXT_JS → buildPlatformContext(env, request) — every sw.* binding
 *
 * `somewhere dev --local` / `somewhere exec` run user functions against the
 * SAME code, so the local contract is byte-identical to production. This
 * script re-extracts both blobs into runtime/ — run it whenever the worker
 * shim changes:
 *
 *   node scripts/extract-runtime.mjs /path/to/monorepo
 *
 * Both templates are interpolation-free (verified here), so evaluating them
 * as template literals reproduces the exact JS the deploy pipeline ships.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const monorepo = process.argv[2];
if (!monorepo) {
  console.error('Usage: node scripts/extract-runtime.mjs /path/to/somewhere-monorepo');
  process.exit(1);
}

const sourcePath = join(monorepo, 'worker/src/utils/function-bundle.ts');
const src = readFileSync(sourcePath, 'utf8');

function extract(name) {
  const marker = `const ${name} = \``;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
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

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: monorepo, encoding: 'utf8' }).trim();
} catch {
  // monorepo may not be a git checkout; provenance header just says unknown
}

const header = (name) =>
  `// VENDORED from worker/src/utils/function-bundle.ts (${name}) @ ${commit}\n` +
  `// — the exact runtime deployed functions run against. Do not edit by hand;\n` +
  `// re-sync with: node scripts/extract-runtime.mjs <monorepo>\n`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'runtime');
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, 'sw-init.mjs'), header('SW_INIT_JS') + extract('SW_INIT_JS') + '\n');
writeFileSync(
  join(outDir, 'platform-context.mjs'),
  header('PLATFORM_CONTEXT_JS') +
    extract('PLATFORM_CONTEXT_JS') +
    '\n\nexport { buildPlatformContext };\n',
);

console.log(`Vendored runtime @ ${commit} → runtime/sw-init.mjs, runtime/platform-context.mjs`);
