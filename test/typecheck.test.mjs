import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const typecheckModule = process.env.SOMEWHERE_TEST_SOURCE
  ? '../src/lib/typecheck.ts'
  : '../dist/lib/typecheck.js';
const scaffoldModule = process.env.SOMEWHERE_TEST_SOURCE
  ? '../src/lib/scaffold.ts'
  : '../dist/lib/scaffold.js';
const { npxTscInvocation, parseTscOutput, runTypecheck } = await import(typecheckModule);
const { buildScaffoldTsconfig } = await import(scaffoldModule);

test('npx fallback installs the typescript package before invoking tsc', () => {
  assert.deepEqual(npxTscInvocation('linux'), {
    command: 'npx',
    args: ['-y', '-p', 'typescript@5.9.3', 'tsc'],
    via: 'npx',
  });
  assert.equal(npxTscInvocation('win32').command, 'npx.cmd');
});

test('parseTscOutput extracts file:line:col, code, message', () => {
  const out = [
    "functions/api/tts.ts(4,16): error TS2304: Cannot find name 'sanitizeForSpeech'.",
    'src/App.tsx(12,3): error TS2322: Type number is not assignable to type string.',
    'noise line that is not a diagnostic',
  ].join('\n');
  const errors = parseTscOutput(out);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors[0], {
    file: 'functions/api/tts.ts',
    line: 4,
    column: 16,
    code: 'TS2304',
    message: "Cannot find name 'sanitizeForSpeech'.",
  });
  assert.equal(errors[1].code, 'TS2322');
});

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-tc-'));
  writeFileSync(join(dir, 'tsconfig.json'), buildScaffoldTsconfig());
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test('runTypecheck catches a dropped import (TS2304) with file:line', async () => {
  const dir = fixture({
    'api/tts.ts':
      'export default async function (req, sw) {\n' +
      '  const t = sanitizeForSpeech("hi");\n' +
      '  return Response.json({ t });\n' +
      '}\n',
  });
  const r = await runTypecheck(dir);
  assert.equal(r.ok, false);
  const undef = r.errors.find((e) => e.code === 'TS2304');
  assert.ok(undef, 'TS2304 reported');
  assert.equal(undef.file.replace(/\\/g, '/').endsWith('api/tts.ts'), true);
  assert.equal(undef.line, 2);
});

test('runTypecheck is clean once the symbol is defined', async () => {
  const dir = fixture({
    'api/tts.ts':
      'function sanitizeForSpeech(s) { return s; }\n' +
      'export default async function (req, sw) {\n' +
      '  const t = sanitizeForSpeech("hi");\n' +
      '  return Response.json({ t });\n' +
      '}\n',
  });
  const r = await runTypecheck(dir);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
});

test('runTypecheck ignores unresolved bare-import noise (TS2307/TS2875) but keeps TS2304', async () => {
  const dir = fixture({
    'api/tts.ts':
      "import { z } from 'zod';\n" +
      'export default async function (req, sw) {\n' +
      '  z.object({});\n' +
      '  const t = sanitizeForSpeech("hi");\n' +
      '  return Response.json({ t });\n' +
      '}\n',
  });
  const r = await runTypecheck(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.every((e) => e.code !== 'TS2307'), 'no module-resolution noise');
  assert.ok(r.errors.some((e) => e.code === 'TS2304'), 'dropped import still caught');
});

test('runTypecheck treats a tree with only unresolved imports as ok', async () => {
  const dir = fixture({
    'api/tts.ts':
      "import { z } from 'zod';\n" +
      'export default async function (req, sw) {\n' +
      '  return Response.json({ ok: true, s: z.string() });\n' +
      '}\n',
  });
  const r = await runTypecheck(dir);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('runTypecheck accepts a fresh Vite-shaped scaffold', async () => {
  const dir = fixture({
    'package.json': JSON.stringify({
      type: 'module',
      dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', vite: '^7.0.0' },
    }),
    'index.html': '<div id="root"></div>',
    'src/main.tsx':
      "import React from 'react';\n" +
      "import { createRoot } from 'react-dom/client';\n" +
      "createRoot(document.getElementById('root')).render(<React.StrictMode><main>Hello</main></React.StrictMode>);\n",
  });
  const r = await runTypecheck(dir);
  assert.equal(r.ok, true, r.raw);
});
