import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnforce, stripEnforceFlags } from '../dist/swpx/enforce.js';

test('stripEnforceFlags removes our own flags only', () => {
  assert.deepEqual(stripEnforceFlags(['foo', '--enforce', 'bar', '--no-enforce', '--save-dev']), ['foo', 'bar', '--save-dev']);
});

test('resolveEnforce precedence: flag > env', () => {
  delete process.env.SWPX_ENFORCE;
  assert.equal(resolveEnforce(['--enforce']), true);
  assert.equal(resolveEnforce(['--no-enforce']), false);
  process.env.SWPX_ENFORCE = '1';
  assert.equal(resolveEnforce([]), true);
  assert.equal(resolveEnforce(['--no-enforce']), false, 'flag beats env');
  process.env.SWPX_ENFORCE = '0';
  assert.equal(resolveEnforce([]), false);
  assert.equal(resolveEnforce(['--enforce']), true, 'flag beats env');
  delete process.env.SWPX_ENFORCE;
});
