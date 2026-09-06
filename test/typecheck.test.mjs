import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const typecheckModule = process.env.SOMEWHERE_TEST_SOURCE
  ? '../src/lib/typecheck.ts'
  : '../dist/lib/typecheck.js';
const scaffoldModule = process.env.SOMEWHERE_TEST_SOURCE
  ? '../src/lib/scaffold.ts'
  : '../dist/lib/scaffold.js';
const typecheckCommandModule = process.env.SOMEWHERE_TEST_SOURCE
  ? '../src/commands/typecheck.ts'
  : '../dist/commands/typecheck.js';
const {
  ensureDeclaredTypePackages,
  npxTscInvocation,
  parseTscOutput,
  planDeclaredTypePackages,
  runTypecheck,
  typecheckArgs,
} = await import(typecheckModule);
const { buildScaffoldPackageJson, buildScaffoldTsconfig } = await import(scaffoldModule);
const { MISSING_TSCONFIG_GUIDANCE, reportTypecheck } = await import(typecheckCommandModule);

test('missing-config guidance distinguishes new source from an existing deployed app', () => {
  assert.equal(
    MISSING_TSCONFIG_GUIDANCE,
    'No tsconfig.json here to typecheck against. Add a local tsconfig.json for a new app, or run `somewhere pull` for an existing deployed app.',
  );
});

test('typecheck verdict is advisory on errors and keeps the clean summary unchanged', (t) => {
  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (...args) => stdout.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')));

  reportTypecheck({
    ok: false,
    errors: [
      {
        file: 'src/one.ts',
        line: 1,
        column: 2,
        code: 'TS2322',
        message: 'Type number is not assignable to type string.',
      },
      {
        file: 'src/two.ts',
        line: 3,
        column: 4,
        code: 'TS2304',
        message: "Cannot find name 'missing'.",
      },
    ],
    via: 'npx',
    raw: '',
  });

  assert.equal(
    stderr[0],
    '✗ 2 type errors (via npx tsc) — deploys are not blocked by type errors; fix at your own pace.',
  );
  assert.ok(stdout.includes(
    '  src/one.ts:1:2 TS2322 Type number is not assignable to type string.',
  ));
  assert.ok(stdout.includes(
    "  src/two.ts:3:4 TS2304 Cannot find name 'missing'.",
  ));

  stdout.length = 0;
  stderr.length = 0;
  reportTypecheck({
    ok: true,
    errors: [],
    via: 'bundled',
    raw: '',
  });

  assert.deepEqual(stdout, ['✓ Typecheck clean (via bundled tsc).']);
  assert.deepEqual(stderr, []);
});

test('npx fallback installs the typescript package before invoking tsc', () => {
  assert.deepEqual(npxTscInvocation('linux'), {
    command: 'npx',
    args: ['-y', '-p', 'typescript@5.9.3', 'tsc'],
    via: 'npx',
  });
  assert.equal(npxTscInvocation('win32').command, 'npx.cmd');
});

test('typecheck explicitly loads the scaffolded project config without file args', () => {
  assert.deepEqual(typecheckArgs(), [
    '--project',
    'tsconfig.json',
    '--noEmit',
    '--pretty',
    'false',
  ]);
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
  writeFileSync(join(dir, 'package.json'), buildScaffoldPackageJson('fresh-pull', {}));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test('a fresh pull scaffold is clean via somewhere typecheck and bare tsc', async () => {
  const dir = fixture({
    'src/main.ts': 'export const answer: number = 42;\n',
  });

  const cliResult = await runTypecheck(dir);
  assert.equal(cliResult.ok, true, cliResult.raw);

  const require = createRequire(import.meta.url);
  const tscBin = require.resolve('typescript/bin/tsc');
  const bareResult = spawnSync(
    process.execPath,
    [tscBin, '--noEmit', '--pretty', 'false'],
    { cwd: dir, encoding: 'utf8' },
  );
  const bareOutput = `${bareResult.stdout ?? ''}${bareResult.stderr ?? ''}`;
  assert.equal(bareResult.status, 0, bareOutput);
});

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

// tsk_4e323e3b — a type package declared in package.json but not yet installed
// is a missing tree, not a code error, and the first check on a fresh pull said
// otherwise. These fixtures pin both directions: declared-but-missing resolves
// and passes; genuinely undeclared still fails with the real diagnostic.
function typesFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-declared-types-'));
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

test('a declared but uninstalled type package is planned for resolution', () => {
  const dir = typesFixture({
    'package.json': JSON.stringify({
      name: 'fixture',
      devDependencies: { '@types/react': '^18.3.0', typescript: '5.9.2' },
      dependencies: { '@types/node': '^22.0.0', react: '^18.3.1' },
    }),
  });
  const plan = planDeclaredTypePackages(dir);
  assert.deepEqual(plan.missing.sort(), ['@types/node', '@types/react']);
  assert.deepEqual(plan.specs.sort(), ['@types/node@^22.0.0', '@types/react@^18.3.0']);
  // Narrow by design: only @types/* the project declares. Runtime deps and the
  // compiler itself are never dragged in by this step.
  assert.ok(!plan.specs.some((spec) => spec.startsWith('react@') || spec.startsWith('typescript@')));
});

test('an already installed type package plans nothing, so a warm tree pays no cost', () => {
  const dir = typesFixture({
    'package.json': JSON.stringify({ devDependencies: { '@types/react': '^18.3.0' } }),
    'node_modules/@types/react/index.d.ts': 'export {};',
  });
  assert.deepEqual(planDeclaredTypePackages(dir), { specs: [], missing: [] });

  let invoked = false;
  const result = ensureDeclaredTypePackages(dir, () => { invoked = true; });
  assert.equal(invoked, false, 'no installer should be spawned for a warm tree');
  assert.equal(result.installed, false);
});

test('a project that declares no type packages plans nothing', () => {
  const bare = typesFixture({
    'package.json': JSON.stringify({ dependencies: { react: '^18.3.1' } }),
  });
  assert.deepEqual(planDeclaredTypePackages(bare), { specs: [], missing: [] });
  // No manifest at all is a no-op too, never a throw.
  assert.deepEqual(planDeclaredTypePackages(typesFixture({})), { specs: [], missing: [] });
});

test('resolving declared types makes the FIRST check clean without a manual install', async () => {
  const dir = typesFixture({
    'package.json': JSON.stringify({ devDependencies: { '@types/fixture-globals': '^1.0.0' } }),
    'tsconfig.json': buildScaffoldTsconfig(),
    'index.ts': 'export const seats: FixtureSeatCount = 4;\n',
  });

  // Before resolution the declared package is simply absent from the tree.
  assert.deepEqual(planDeclaredTypePackages(dir).missing, ['@types/fixture-globals']);
  const cold = await runTypecheck(dir, { installTypePackages: false });
  assert.equal(cold.ok, false, 'an unresolved declared type should not pass');
  assert.ok(cold.errors.some((e) => e.code === 'TS2304'), JSON.stringify(cold.errors));

  // Resolution stands in for npm here so the fixture stays offline; the specs it
  // receives are the real ones the CLI would hand npm.
  const seen = [];
  const resolved = ensureDeclaredTypePackages(dir, (specs, cwd) => {
    seen.push({ specs, cwd });
    mkdirSync(join(dir, 'node_modules', '@types', 'fixture-globals'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', '@types', 'fixture-globals', 'index.d.ts'),
      'declare type FixtureSeatCount = number;\n',
    );
    writeFileSync(
      join(dir, 'node_modules', '@types', 'fixture-globals', 'package.json'),
      JSON.stringify({ name: '@types/fixture-globals', version: '1.0.0', types: 'index.d.ts' }),
    );
  });
  assert.deepEqual(seen, [{ specs: ['@types/fixture-globals@^1.0.0'], cwd: dir }]);
  assert.equal(resolved.installed, true);

  const warm = await runTypecheck(dir, { installTypePackages: false });
  assert.equal(warm.ok, true, `expected a clean first check, got ${warm.raw}`);
});

test('a genuinely undeclared symbol still fails with its real diagnostic', async () => {
  const dir = typesFixture({
    'package.json': JSON.stringify({ devDependencies: {} }),
    'tsconfig.json': buildScaffoldTsconfig(),
    'index.ts': 'export const value = sanitizeForSpeech("hi");\n',
  });
  // Nothing to resolve, and resolution must never invent a package to silence this.
  assert.deepEqual(planDeclaredTypePackages(dir), { specs: [], missing: [] });
  const result = await runTypecheck(dir);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === 'TS2304' && /sanitizeForSpeech/.test(e.message)),
    JSON.stringify(result.errors),
  );
});

test('resolution fails open: an installer that throws never blocks the check', async () => {
  const dir = typesFixture({
    'package.json': JSON.stringify({ devDependencies: { '@types/never-there': '^1.0.0' } }),
    'tsconfig.json': buildScaffoldTsconfig(),
    'index.ts': 'export const ok = 1;\n',
  });
  const outcome = ensureDeclaredTypePackages(dir, () => {
    throw new Error('offline');
  });
  assert.equal(outcome.installed, false);
  assert.deepEqual(outcome.missing, ['@types/never-there']);

  const result = await runTypecheck(dir, { installTypePackages: false });
  assert.equal(result.ok, true, `the check must still run and report: ${result.raw}`);
});
