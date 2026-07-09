import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTargetDir } from '../dist/commands/deploy.js';
import { classifyKey, collectFiles } from '../dist/lib/files.js';

test('resolveTargetDir returns an absolute dir as-is', () => {
  assert.equal(resolveTargetDir('/abs/path', '/some/cwd'), '/abs/path');
});

test('resolveTargetDir resolves a relative dir against cwd', () => {
  assert.equal(resolveTargetDir('sub/dir', '/some/cwd'), '/some/cwd/sub/dir');
});

test('resolveTargetDir normalizes .. segments against cwd', () => {
  assert.equal(resolveTargetDir('../sibling', '/some/cwd'), '/some/sibling');
});

test('resolveTargetDir returns cwd when dir is undefined', () => {
  assert.equal(resolveTargetDir(undefined, '/some/cwd'), '/some/cwd');
});

test('resolveTargetDir defaults to process.cwd() when no cwd passed', () => {
  assert.equal(resolveTargetDir(), process.cwd());
});

// --- Windows path separators (win32 DEPLOY_BLANK_PAGE regression) ---
// node:path on win32 hands the collector backslash-separated relative paths.
// classifyKey must normalize so functions are detected and keys ship POSIX.

test('classifyKey normalizes backslash keys to forward slashes', () => {
  assert.equal(classifyKey('src\\App.jsx').key, 'src/App.jsx');
  assert.equal(classifyKey('assets\\img\\logo.png').key, 'assets/img/logo.png');
});

test('classifyKey detects a win32 api/ path as a function', () => {
  const r = classifyKey('api\\auth\\login.ts');
  assert.equal(r.kind, 'function');
  assert.equal(r.key, 'api/auth/login.ts');
});

test('classifyKey detects a win32 _lib/ path as a function', () => {
  assert.equal(classifyKey('_lib\\db.ts').kind, 'function');
});

test('classifyKey strips a win32 functions\\ prefix to the route', () => {
  const r = classifyKey('functions\\api\\hello.ts');
  assert.equal(r.kind, 'function');
  assert.equal(r.key, 'api/hello.ts');
});

test('classifyKey detects a win32 binary key', () => {
  const r = classifyKey('public\\photos\\cat.jpg');
  assert.equal(r.kind, 'binary');
  assert.equal(r.key, 'photos/cat.jpg');
});

test('classifyKey hoists public/ static files to the site root', () => {
  assert.deepEqual(classifyKey('public\\assets\\app.css'), {
    kind: 'static',
    key: 'assets/app.css',
  });
  assert.deepEqual(classifyKey('public/images/logo.png'), {
    kind: 'binary',
    key: 'images/logo.png',
  });
});

test('collectFiles respects root .gitignore and .somewhereignore rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-deploy-ignore-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'nested'), { recursive: true });
  mkdirSync(join(dir, 'photos'), { recursive: true });

  writeFileSync(join(dir, '.gitignore'), 'docs/\n*.raw\ndraft.txt\n/root-only.txt\n');
  writeFileSync(join(dir, '.somewhereignore'), 'photos/**\n!photos/keep.txt\nsecret.txt\n!draft.txt\n');
  writeFileSync(join(dir, 'index.html'), '<html></html>\n');
  writeFileSync(join(dir, 'docs', 'plan.md'), 'private docs\n');
  writeFileSync(join(dir, 'nested', 'root-only.txt'), 'nested file\n');
  writeFileSync(join(dir, 'notes.raw'), 'raw notes\n');
  writeFileSync(join(dir, 'photos', 'raw.jpg'), 'raw photo\n');
  writeFileSync(join(dir, 'photos', 'keep.txt'), 'keep me\n');
  writeFileSync(join(dir, 'root-only.txt'), 'root file\n');
  writeFileSync(join(dir, 'secret.txt'), 'secret\n');
  writeFileSync(join(dir, 'draft.txt'), 'deploy draft\n');

  const collected = collectFiles(dir);

  assert.deepEqual(Object.keys(collected.files).sort(), [
    'draft.txt',
    'index.html',
    'nested/root-only.txt',
    'photos/keep.txt',
  ]);
  assert.equal(Object.keys(collected.binaryFiles).length, 0);
  assert.equal(Object.keys(collected.functions).length, 0);
});

test('collectFiles hoists public/ assets in text and binary buckets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-deploy-public-'));
  mkdirSync(join(dir, 'public', 'assets'), { recursive: true });
  mkdirSync(join(dir, 'public', 'images'), { recursive: true });

  writeFileSync(join(dir, 'index.html'), '<html></html>\n');
  writeFileSync(join(dir, 'public', 'assets', 'app.css'), 'body { color: red; }\n');
  writeFileSync(join(dir, 'public', 'images', 'logo.png'), 'png bytes\n');

  const collected = collectFiles(dir);

  assert.equal(collected.files['assets/app.css'], 'body { color: red; }\n');
  assert.equal(collected.files['index.html'], '<html></html>\n');
  assert.equal(collected.binaryFiles['images/logo.png'], Buffer.from('png bytes\n').toString('base64'));
  assert.equal('public/assets/app.css' in collected.files, false);
  assert.equal('public/images/logo.png' in collected.binaryFiles, false);
});
