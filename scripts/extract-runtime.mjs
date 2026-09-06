#!/usr/bin/env node
// Vendor the independent browser outline probe; no platform runtime or compiler.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const monorepo = process.argv[2];
if (!monorepo) throw new Error('Usage: node scripts/extract-runtime.mjs <monorepo>');
function extractDomOutlineScript() {
  const engineSrc = readFileSync(join(monorepo, 'worker/src/utils/browser-test.ts'), 'utf8');
  const stepsSrc = readFileSync(join(monorepo, 'worker/src/utils/browser-test-steps.ts'), 'utf8');
  const cap = stepsSrc.match(/MAX_OUTLINE_NODES\s*=\s*(\d+)\s*;/);
  if (!cap) throw new Error('MAX_OUTLINE_NODES not found in worker/src/utils/browser-test-steps.ts');
  const marker = 'const DOM_OUTLINE_SCRIPT = `';
  const start = engineSrc.indexOf(marker);
  if (start === -1) throw new Error('DOM_OUTLINE_SCRIPT not found in worker/src/utils/browser-test.ts');
  const bodyStart = start + marker.length;
  const end = engineSrc.indexOf('`;', bodyStart);
  if (end === -1) throw new Error('unterminated DOM_OUTLINE_SCRIPT template');
  const raw = engineSrc.slice(bodyStart, end);
  const unknown = raw.match(/(^|[^\\])\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g) || [];
  for (const hit of unknown) {
    if (!/MAX_OUTLINE_NODES/.test(hit) && !/computeOutlineVisibility/.test(hit)) {
      throw new Error(
        `DOM_OUTLINE_SCRIPT gained an interpolation this vendor step cannot resolve: ${hit.trim()}`,
      );
    }
  }
  const helperMatch = engineSrc.match(
    /export function computeOutlineVisibility\([\s\S]*?^}\n/m,
  );
  if (!helperMatch) {
    throw new Error('computeOutlineVisibility not found in worker/src/utils/browser-test.ts');
  }
  const helperJs = helperMatch[0]
    .replace(/^export\s+/, '')
    .replace(/info:\s*OutlineVisibilityInput/, 'info')
    .replace(/\):\s*\{\s*visible:\s*boolean;\s*disabled:\s*boolean\s*}\s*\{/, ') {');
  if (/OutlineVisibilityInput|:\s*boolean/.test(helperJs)) {
    throw new Error('computeOutlineVisibility TypeScript shape changed — extraction needs updating');
  }
  // eslint-disable-next-line no-eval
  const computeOutlineVisibility = eval('(' + helperJs + ')');
  const MAX_OUTLINE_NODES = Number(cap[1]);
  // eslint-disable-next-line no-eval
  const script = eval('`' + raw + '`');
  if (!script.includes('outline.push(') || !script.includes('testid_map')) {
    throw new Error('the lifted DOM probe does not build an outline + testid map — extraction needs updating');
  }
  return { script, cap: MAX_OUTLINE_NODES };
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: monorepo, encoding: 'utf8' }).trim();
const probe = extractDomOutlineScript();
const output = `// VENDORED browser probe from worker/src/utils/browser-test.ts @ ${commit}\n`
  + `export const MAX_OUTLINE_NODES = ${probe.cap};\n`
  + `export const DOM_OUTLINE_SCRIPT = ${JSON.stringify(probe.script)};\n`;
const outDir = join(import.meta.dirname, '..', 'runtime');
writeFileSync(join(outDir, 'browser-probes.mjs'), output);
writeFileSync(join(outDir, 'VENDOR.json'), JSON.stringify({ commit, files: {
  'browser-probes.mjs': createHash('sha256').update(output).digest('hex'),
} }, null, 2) + '\n');
console.log(`Browser probe vendored from ${commit}`);
