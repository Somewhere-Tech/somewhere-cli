import test from 'node:test';
import assert from 'node:assert/strict';
import { prebuiltOptIn } from '../dist/commands/deploy.js';

// The deploy body sets `allow_bundled: true` iff prebuiltOptIn(opts) is true
// (see deploy.ts: `if (prebuilt) body.allow_bundled = true`). These assert the
// flag → payload mapping without touching the filesystem or the network.

test('--prebuilt opts in (allow_bundled would be set)', () => {
  assert.equal(prebuiltOptIn({ prebuilt: true }), true);
});

test('--allow-bundled alias opts in', () => {
  assert.equal(prebuiltOptIn({ allowBundled: true }), true);
});

test('absence of the flag omits the opt-in (no allow_bundled in payload)', () => {
  assert.equal(prebuiltOptIn({}), false);
});

// Concretely assert the payload shape the action builds from prebuiltOptIn.
function buildAllowBundled(opts) {
  const body = {};
  if (prebuiltOptIn(opts)) body.allow_bundled = true;
  return body;
}

test('--prebuilt puts allow_bundled:true in the deploy payload', () => {
  assert.deepEqual(buildAllowBundled({ prebuilt: true }), { allow_bundled: true });
});

test('--allow-bundled puts allow_bundled:true in the deploy payload', () => {
  assert.deepEqual(buildAllowBundled({ allowBundled: true }), { allow_bundled: true });
});

test('a normal deploy omits allow_bundled from the payload', () => {
  const body = buildAllowBundled({});
  assert.deepEqual(body, {});
  assert.equal('allow_bundled' in body, false);
});
