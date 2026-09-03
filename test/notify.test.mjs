import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getUpdateNotice,
  isNewer,
} from '../dist/lib/notify/providers/update.js';
import { collectNotices, subcommandSuppressesNotifications } from '../dist/lib/notify/index.js';

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

test('notification gate — update owns its output and cannot reprint the old-process version', () => {
  assert.equal(subcommandSuppressesNotifications(['node', 'sw', 'update']), true);
  assert.equal(subcommandSuppressesNotifications(['node', 'sw', 'whoami']), false);
});

test('update notice — newer and current directions are one-line and deterministic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-update-notice-'));
  const cachePath = join(dir, 'update-check.json');
  const now = 1_800_000_000_000;

  writeFileSync(cachePath, JSON.stringify({ checkedAt: now, latest: '0.31.9' }));
  const newer = await getUpdateNotice('0.31.8', { cachePath, now: () => now });
  assert.match(newer, /0\.31\.8.*0\.31\.9.*somewhere update/);
  assert.doesNotMatch(newer, /\n/);

  const current = await getUpdateNotice('0.31.9', { cachePath, now: () => now });
  assert.equal(current, null);
});

test('update notice — stale cache checks once, then reuses the daily cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-update-throttle-'));
  const cachePath = join(dir, 'update-check.json');
  const now = 1_800_000_000_000;
  writeFileSync(cachePath, JSON.stringify({ checkedAt: now - 86_400_001, latest: '0.31.8' }));
  let fetches = 0;
  const fetchLatest = async () => {
    fetches += 1;
    return '0.31.9';
  };

  await getUpdateNotice('0.31.8', { cachePath, fetchLatest, now: () => now });
  await getUpdateNotice('0.31.8', { cachePath, fetchLatest, now: () => now + 1 });

  assert.equal(fetches, 1);
  assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')), {
    checkedAt: now,
    latest: '0.31.9',
  });
});
