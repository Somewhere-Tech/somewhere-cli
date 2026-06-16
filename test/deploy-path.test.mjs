import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetDir } from '../dist/commands/deploy.js';

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
