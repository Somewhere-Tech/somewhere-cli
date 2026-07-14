import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../dist/lib/notify/providers/update.js';
import { collectNotices, notificationsAllowed } from '../dist/lib/notify/index.js';

test('isNewer — basic precedence', () => {
  assert.equal(isNewer('1.0.1', '1.0.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
});

test('isNewer — numeric, not string (1.10.0 > 1.9.0)', () => {
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.9.0', '1.10.0'), false);
  assert.equal(isNewer('0.17.0', '0.9.0'), true);
});

test('isNewer — pre-release tags ignored on the base version', () => {
  assert.equal(isNewer('1.0.0-beta.1', '1.0.0'), false);
  assert.equal(isNewer('1.0.1-beta.1', '1.0.0'), true);
});

test('isNewer — unparseable inputs are not "newer" (fail-safe)', () => {
  assert.equal(isNewer('garbage', '1.0.0'), false);
  assert.equal(isNewer('1.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', 'x.y.z'), false);
});

test('collectNotices — central gate: silent on non-interactive output', async () => {
  // The test runner's stderr is not a TTY, so the gate must suppress ALL providers
  // — this is the contract that keeps notices out of agent/piped/safety output.
  const out = await collectNotices(['node', 'sw', 'whoami']);
  assert.deepEqual(out, []);
});

test('notificationsAllowed — update is silent even on an interactive terminal', () => {
  assert.equal(notificationsAllowed(['node', 'somewhere', 'update'], true, {}), false);
  assert.equal(notificationsAllowed(['node', 'somewhere', 'status'], true, {}), true);
});
