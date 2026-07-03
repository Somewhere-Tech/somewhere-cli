import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { leadingZeroBits, solvePow, mintTempAccount } from '../dist/lib/temp-auth.js';

test('leadingZeroBits — hand-computed digests', () => {
  // 0x00 alone = a fully-zero byte = 8 leading zero bits.
  assert.equal(leadingZeroBits(Buffer.from([0x00])), 8);
  // 0x00 then 0x80 (0b10000000): the first byte contributes its 8 zero bits,
  // then the second byte's top bit is already 1 — 0 more. Total 8, not 16.
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x80])), 8);
  // 0x0F = 0b00001111 — 4 leading zero bits before the first 1.
  assert.equal(leadingZeroBits(Buffer.from([0x0f])), 4);
  // Two fully-zero bytes then a non-zero one — 16 leading zero bits.
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0xff])), 16);
  // 0xFF — the very first bit is already 1 — 0 leading zero bits.
  assert.equal(leadingZeroBits(Buffer.from([0xff])), 0);
});

test('solvePow — difficulty 8 returns a suffix whose recomputed sha256 verifies', () => {
  const nonce = 'tmpc_test_nonce_1';
  const { suffix, hash } = solvePow(nonce, 8);
  const recomputed = createHash('sha256').update(`${nonce}:${suffix}`, 'utf8').digest();
  assert.equal(recomputed.toString('hex'), hash);
  assert.ok(leadingZeroBits(recomputed) >= 8);
});

test('solvePow — difficulty 12 returns a suffix whose recomputed sha256 verifies', () => {
  const nonce = 'tmpc_test_nonce_2';
  const { suffix, hash } = solvePow(nonce, 12);
  const recomputed = createHash('sha256').update(`${nonce}:${suffix}`, 'utf8').digest();
  assert.equal(recomputed.toString('hex'), hash);
  assert.ok(leadingZeroBits(recomputed) >= 12);
});

test('mintTempAccount — GET challenge then POST create with {nonce, suffix}, envelope unwrapped', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/pow/challenge')) {
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          ok: true,
          data: {
            nonce: 'tmpc_abc',
            difficulty: 1,
            algorithm: 'sha256',
            input: 'tmpc_abc:<suffix>',
            expires_at: '2026-07-02T13:00:00.000Z',
            ttl_seconds: 600,
          },
        }),
      };
    }
    if (String(url).endsWith('/auth/temp-create')) {
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          ok: true,
          data: {
            access_token: 'smt_fallback_should_not_be_used',
            key: 'smt_temp_123',
            key_prefix: 'smt_temp',
            key_id: 'key_1',
            scopes: ['projects', 'deploy'],
            expires_at: '2026-07-02T16:00:00.000Z',
            ttl_seconds: 10800,
            claim_token: 'swtc_xyz',
            claim_url: 'https://somewhere.tech/claim?token=swtc_xyz',
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const account = await mintTempAccount(fetchImpl);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/auth\/pow\/challenge$/);
  assert.equal(calls[0].init, undefined); // plain GET, no init object
  assert.match(calls[1].url, /\/auth\/temp-create$/);
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { nonce: 'tmpc_abc', suffix: expectedSuffix('tmpc_abc', 1) });

  // `key` is preferred over `access_token` when both are present.
  assert.equal(account.key, 'smt_temp_123');
  assert.equal(account.claim_url, 'https://somewhere.tech/claim?token=swtc_xyz');
  assert.equal(account.ttl_seconds, 10800);
});

test('mintTempAccount — falls back to access_token when key is absent', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/auth/pow/challenge')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { nonce: 'n', difficulty: 1, algorithm: 'sha256', input: 'n:<suffix>', expires_at: 'x', ttl_seconds: 600 },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          access_token: 'smt_only_access_token',
          scopes: [],
          expires_at: 'x',
          ttl_seconds: 10800,
          claim_token: 'swtc_1',
          claim_url: 'https://somewhere.tech/claim?token=swtc_1',
        },
      }),
    };
  };
  const account = await mintTempAccount(fetchImpl);
  assert.equal(account.key, 'smt_only_access_token');
});

test('mintTempAccount — propagates the server error message on challenge failure', async () => {
  const fetchImpl = async () => ({
    ok: false,
    statusText: 'Too Many Requests',
    json: async () => ({ ok: false, error: 'RATE_LIMITED', message: 'slow down' }),
  });
  await assert.rejects(() => mintTempAccount(fetchImpl), /slow down/);
});

test('mintTempAccount — propagates the server error message on create failure', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/auth/pow/challenge')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { nonce: 'n', difficulty: 1, algorithm: 'sha256', input: 'n:<suffix>', expires_at: 'x', ttl_seconds: 600 },
        }),
      };
    }
    return {
      ok: false,
      statusText: 'Bad Request',
      json: async () => ({ ok: false, error: 'INVALID_SOLUTION', message: 'proof-of-work did not verify' }),
    };
  };
  await assert.rejects(() => mintTempAccount(fetchImpl), /proof-of-work did not verify/);
});

// Recompute the same suffix search the module does, purely to build the
// expected POST body for the "GET then POST" assertion above.
function expectedSuffix(nonce, difficulty) {
  let i = 0;
  for (;;) {
    const suffix = (i++).toString(36);
    const hash = createHash('sha256').update(`${nonce}:${suffix}`, 'utf8').digest();
    let bits = 0;
    for (const byte of hash) {
      if (byte === 0) { bits += 8; continue; }
      let mask = 0x80;
      while (mask > 0 && (byte & mask) === 0) { bits++; mask >>= 1; }
      break;
    }
    if (bits >= difficulty) return suffix;
  }
}
