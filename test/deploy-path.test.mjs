import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetDir } from '../dist/commands/deploy.js';
import { classifyKey } from '../dist/lib/files.js';

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
  assert.equal(r.key, 'public/photos/cat.jpg');
});
