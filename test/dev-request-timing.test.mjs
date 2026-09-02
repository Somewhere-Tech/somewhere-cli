import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDatabaseTiming,
  LocalRequestTiming,
  platformDatabaseDuration,
} from '../dist/local/request-timing.js';

test('database timing reads the platform-reported query duration', () => {
  assert.equal(platformDatabaseDuration({
    ok: true,
    data: { rows: [{ ok: 1 }], meta: { duration: 4.25 } },
  }), 4.25);
});

test('database timing sums a fully reported batch', () => {
  assert.equal(platformDatabaseDuration({
    ok: true,
    data: {
      results: [
        { rows: [], meta: { duration: 1.25 } },
        { rows: [], meta: { duration: 2.5 } },
      ],
    },
  }), 3.75);
});

test('a database response with timing prints total and platform-reported time', async () => {
  const timing = new LocalRequestTiming(async () => Response.json({
    ok: true,
    data: { rows: [{ ok: 1 }], meta: { duration: 3.5 } },
  }));
  const response = await timing.fetch('https://api.somewhere.tech/v1/db/query', { method: 'POST' });
  await response.json();
  const breakdown = await timing.finish();

  assert.equal(breakdown.calls, 1);
  assert.equal(breakdown.platformMs, 3.5);
  assert.match(formatDatabaseTiming(breakdown), /^database [\d.]+ms total, 3\.5ms platform-reported$/);
});

test('a working database response without platform timing stays visible and never blocks', async () => {
  const timing = new LocalRequestTiming(async () => Response.json({
    ok: true,
    data: { rows: [{ ok: 1 }] },
  }));
  const response = await timing.fetch('https://api.somewhere.tech/v1/db/query', { method: 'POST' });
  assert.deepEqual(await response.json(), { ok: true, data: { rows: [{ ok: 1 }] } });
  const breakdown = await timing.finish();

  assert.equal(breakdown.calls, 1);
  assert.equal(breakdown.platformMs, null);
  assert.match(formatDatabaseTiming(breakdown), /platform timing not reported/);
});

test('non-database platform calls are passed through and omitted from the breakdown', async () => {
  const timing = new LocalRequestTiming(async () => Response.json({ ok: true }));
  const response = await timing.fetch('https://api.somewhere.tech/v1/fs/list');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(await timing.finish(), null);
});
