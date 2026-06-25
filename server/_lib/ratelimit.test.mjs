import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, clientIp } from './ratelimit.mjs';

function fakeSw() {
  const store = new Map();
  return {
    db: {
      query: async (_sql, params) => {
        const [bucket, reset, now] = params;
        let row = store.get(bucket);
        if (!row || row.reset_at < now) row = { count: 1, reset_at: reset };
        else row = { count: row.count + 1, reset_at: row.reset_at };
        store.set(bucket, row);
        return { data: [{ count: row.count, reset_at: row.reset_at }] };
      },
    },
  };
}

test('checkRateLimit — allows up to the limit, then denies with retry-after', async () => {
  const sw = fakeSw();
  for (let i = 0; i < 3; i++) assert.equal((await checkRateLimit(sw, 'ip', { limit: 3 })).ok, true, `req ${i}`);
  const over = await checkRateLimit(sw, 'ip', { limit: 3 });
  assert.equal(over.ok, false);
  assert.ok(over.retryAfterMs > 0);
});

test('checkRateLimit — separate buckets are independent', async () => {
  const sw = fakeSw();
  await checkRateLimit(sw, 'a', { limit: 1 });
  assert.equal((await checkRateLimit(sw, 'b', { limit: 1 })).ok, true);
  assert.equal((await checkRateLimit(sw, 'a', { limit: 1 })).ok, false);
});

test('checkRateLimit — window reset re-allows', async () => {
  const sw = fakeSw();
  const t0 = 1_000_000;
  await checkRateLimit(sw, 'ip', { limit: 1, now: t0 });
  assert.equal((await checkRateLimit(sw, 'ip', { limit: 1, now: t0 })).ok, false);
  // an hour later → reset
  assert.equal((await checkRateLimit(sw, 'ip', { limit: 1, now: t0 + 3_600_001 })).ok, true);
});

test('checkRateLimit — a store failure ALLOWS (never deny on limiter error)', async () => {
  const sw = { db: { query: async () => { throw new Error('db down'); } } };
  assert.equal((await checkRateLimit(sw, 'ip')).ok, true);
});

test('clientIp — reads cf-connecting-ip, falls back to x-forwarded-for', () => {
  assert.equal(clientIp({ headers: new Map([['cf-connecting-ip', '1.2.3.4']]) }), '1.2.3.4');
  assert.equal(clientIp({ headers: new Map([['x-forwarded-for', '5.6.7.8, 9.9.9.9']]) }), '5.6.7.8');
  assert.equal(clientIp({ headers: new Map() }), 'unknown');
});
