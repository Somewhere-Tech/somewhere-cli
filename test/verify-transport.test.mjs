import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let mode = 'partial';
let status = 200;
let calls = 0;
const server = createServer((_req, res) => {
  calls++;
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'fixture-request' });
  if (mode === 'partial') res.write('{"ok":');
  else if (mode === 'broken') { res.write('{"ok":'); setTimeout(() => res.destroy(), 20); }
  else if (mode === 'invalid') res.end('not JSON');
  else if (status === 200) res.end(JSON.stringify({ ok: true, data: { passed: true, screenshots: [{ path: '/page.jpg' }] } }));
  else res.end(JSON.stringify({ ok: false, error: 'FORBIDDEN', message: 'Explicit refusal' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.SOMEWHERE_API_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.NO_PROXY = '127.0.0.1,localhost';
const { ApiClient, CliApiError } = await import('../dist/lib/client.js');
const { runVerification, normalizeVerifyFlow } = await import('../dist/commands/verify.js');
const client = new ApiClient('synthetic-key');
const shortClient = { call(method, path, body) { return client.call(method, path, body, undefined, { timeoutMs: 100 }); } };
const flow = normalizeVerifyFlow({ viewports: ['desktop'] });
test.after(() => { server.closeAllConnections(); server.close(); });

test('body consumption shares the request deadline and preserves observed status for non-verify callers', async () => {
  status = 200; mode = 'partial'; const before = calls; const started = Date.now();
  await assert.rejects(client.call('POST', '/ordinary', {}, undefined, { timeoutMs: 100 }), (error) => {
    assert.ok(error instanceof CliApiError);
    assert.equal(error.code, 'RESPONSE_BODY_TIMEOUT');
    assert.equal(error.statusCode, 200);
    assert.equal(error.meta.responseBodyIncomplete, true);
    assert.equal(error.meta.requestId, 'fixture-request');
    return true;
  });
  assert.ok(Date.now() - started < 1000, 'body wait is bounded by the original deadline');
  assert.equal(calls - before, 1, 'no retry');
});

test('partial successful HTTP body becomes unknown only in verify', async () => {
  for (const nextMode of ['partial', 'broken']) {
    mode = nextMode; status = 200; const before = calls;
    const report = await runVerification({ project_id: 'fixture' }, flow, shortClient);
    assert.equal(report.passed, false);
    assert.match(report.verdict, /^INCOMPLETE — Outcome unknown/);
    assert.equal(report.transport_errors[0].detail.status, 200);
    assert.match(report.transport_errors[0].detail.code, /^RESPONSE_BODY_(TIMEOUT|ERROR)$/);
    assert.equal(calls - before, 1);
  }
});

test('complete refusals, partial refusal bodies, and complete invalid JSON remain errors', async () => {
  for (const [nextMode, nextStatus, code] of [['complete', 403, 'FORBIDDEN'], ['partial', 401, 'RESPONSE_BODY_TIMEOUT'], ['invalid', 200, 'INVALID_RESPONSE']]) {
    mode = nextMode; status = nextStatus; const before = calls;
    await assert.rejects(runVerification({ project_id: 'fixture' }, flow, shortClient), (error) => error.code === code && error.statusCode === nextStatus);
    assert.equal(calls - before, 1);
  }
});

test('complete ordinary and verify success remain successful', async () => {
  mode = 'complete'; status = 200;
  assert.equal((await client.call('GET', '/ordinary')).passed, true);
  assert.equal((await runVerification({ project_id: 'fixture' }, flow, shortClient)).passed, true);
});
