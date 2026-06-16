import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// callRunner reads SOMEWHERE_RUNNER_URL at import time (module-level const), so
// set it BEFORE importing the client.
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    server.lastRequest = {
      method: req.method,
      url: req.url,
      auth: req.headers['authorization'],
      contentType: req.headers['content-type'],
      body: body ? JSON.parse(body) : null,
    };
    res.setHeader('Content-Type', 'application/json');
    // Mirror the runner's real envelope: successResponse({ result, logs, duration_ms }).
    res.end(
      JSON.stringify({
        ok: true,
        data: { result: { n: 7 }, logs: [{ level: 'log', message: 'hi' }], duration_ms: 12 },
      }),
    );
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.SOMEWHERE_RUNNER_URL = `http://127.0.0.1:${port}`;

const { ApiClient } = await import('../dist/lib/client.js');

test('callRunner POSTs /run on the runner host with bearer auth and unwraps the envelope', async () => {
  const client = new ApiClient('smt_test_key');
  const out = await client.callRunner({ project_id: 'p1', code: 'export default async (sw) => 1' });

  // Hit the runner root path, not /v1/...
  assert.equal(server.lastRequest.method, 'POST');
  assert.equal(server.lastRequest.url, '/run');
  assert.equal(server.lastRequest.auth, 'Bearer smt_test_key');
  assert.equal(server.lastRequest.contentType, 'application/json');
  assert.deepEqual(server.lastRequest.body, {
    project_id: 'p1',
    code: 'export default async (sw) => 1',
  });

  // Envelope unwrapped to data: { result, logs, duration_ms }.
  assert.deepEqual(out.result, { n: 7 });
  assert.equal(out.logs[0].message, 'hi');
  assert.equal(out.duration_ms, 12);
});

test.after(() => server.close());
