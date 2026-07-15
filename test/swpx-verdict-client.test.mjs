import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVerdict,
  getVerdictBatch,
  pollVerdictSummary,
  VerdictUnavailable,
} from '../dist/swpx/verdict-client.js';

const resp = (body, ok = true, status = 200) => async () => ({
  ok,
  status,
  json: async () => body,
});

test('getVerdict — unwraps a bare verdict and pins coordinates', async () => {
  const v = await getVerdict(
    'left-pad',
    '1.3.0',
    resp({ package: 'echoed-wrong', version: '0.0.0', verdict: 'verified', capabilities: ['fs'] }),
  );
  assert.equal(v.verdict, 'verified');
  assert.equal(v.package, 'left-pad'); // caller coordinates win over the echo
  assert.equal(v.version, '1.3.0');
  assert.deepEqual(v.capabilities, ['fs']);
});

test('getVerdict — unwraps an { ok, data } envelope', async () => {
  const v = await getVerdict(
    'foo',
    '1.0.0',
    resp({ ok: true, data: { package: 'foo', version: '1.0.0', verdict: 'unverified' } }),
  );
  assert.equal(v.verdict, 'unverified');
});

test('getVerdict — non-2xx becomes VerdictUnavailable (fall back, never block)', async () => {
  await assert.rejects(
    () => getVerdict('foo', '1.0.0', resp({}, false, 503)),
    VerdictUnavailable,
  );
});

test('getVerdict — network throw becomes VerdictUnavailable', async () => {
  const boom = async () => {
    throw new Error('ENOTFOUND npm.somewhere.tech');
  };
  await assert.rejects(() => getVerdict('foo', '1.0.0', boom), VerdictUnavailable);
});

test('getVerdict — unexpected shape becomes VerdictUnavailable', async () => {
  await assert.rejects(
    () => getVerdict('foo', '1.0.0', resp({ nonsense: true })),
    VerdictUnavailable,
  );
});

test('getVerdict — ok:false envelope becomes VerdictUnavailable', async () => {
  await assert.rejects(
    () => getVerdict('foo', '1.0.0', resp({ ok: false, error: 'RATE_LIMITED' })),
    VerdictUnavailable,
  );
});

test('getVerdictBatch — accepts { results: [...] }', async () => {
  const out = await getVerdictBatch(
    [
      { package: 'a', version: '1' },
      { package: 'b', version: '2' },
    ],
    resp({
      results: [
        { package: 'a', version: '1', verdict: 'verified' },
        { package: 'b', version: '2', verdict: 'blocked' },
      ],
    }),
  );
  assert.equal(out.length, 2);
  assert.equal(out[1].verdict, 'blocked');
});

test('getVerdictBatch — accepts a bare array and drops malformed rows', async () => {
  const out = await getVerdictBatch(
    [{ package: 'a', version: '1' }],
    resp([{ package: 'a', version: '1', verdict: 'verified' }, { junk: true }, null]),
  );
  assert.equal(out.length, 1);
});

test('getVerdictBatch — empty input short-circuits without a request', async () => {
  let called = false;
  const out = await getVerdictBatch([], async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('getVerdictBatch — failure throws VerdictUnavailable', async () => {
  await assert.rejects(
    () => getVerdictBatch([{ package: 'a', version: '1' }], resp({}, false, 500)),
    VerdictUnavailable,
  );
});

test('pollVerdictSummary — requests enrichment until the narrative resolves', async () => {
  let clock = 0;
  const urls = [];
  const requestHeaders = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    requestHeaders.push(init.headers);
    const summary = urls.length === 2 ? 'Readable and established.' : null;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { package: 'foo', version: '1.0.0', verdict: 'verified', summary },
      }),
    };
  };
  const verdict = await pollVerdictSummary('foo', '1.0.0', fetchImpl, {
    timeoutMs: 10,
    intervalMs: 2,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(verdict.summary, 'Readable and established.');
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.endsWith('/api/verdict/foo/1.0.0?enrich=1')));
  assert.ok(requestHeaders.every((headers) => headers['Cache-Control'] === 'no-cache'));
});

test('pollVerdictSummary — returns null at one overall deadline', async () => {
  let clock = 0;
  let calls = 0;
  const verdict = await pollVerdictSummary('foo', '1.0.0', async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { package: 'foo', version: '1.0.0', verdict: 'unverified', summary: null },
      }),
    };
  }, {
    timeoutMs: 7,
    intervalMs: 3,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(verdict, null);
  assert.equal(clock, 7);
  assert.equal(calls, 3);
});
