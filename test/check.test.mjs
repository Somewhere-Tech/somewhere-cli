import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// client.ts reads BASE_URL at module load — point it at the mock server before
// the first import (check.js imports client.js transitively).
let lastRequest = null;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastRequest = {
      method: req.method,
      url: req.url,
      auth: req.headers['authorization'],
      body: body ? JSON.parse(body) : null,
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: { ok: true, build_log: ['compiled'] } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.SOMEWHERE_API_URL = `http://127.0.0.1:${port}`;

const { ApiClient, CliApiError } = await import('../dist/lib/client.js');
const { buildCheckBody, buildCheckRunBody, checkErrorsToCliError, formatCheckRunResult } =
  await import('../dist/commands/check.js');

const collected = (over = {}) => ({ files: {}, binaryFiles: {}, functions: {}, ...over });

test('buildCheckBody: always carries project_id + files', () => {
  assert.deepEqual(buildCheckBody(collected({ files: { 'index.html': '<html>' } }), 'p1'), {
    project_id: 'p1',
    files: { 'index.html': '<html>' },
  });
});

test('buildCheckBody: includes functions/binary_files only when non-empty', () => {
  const body = buildCheckBody(
    collected({
      files: { 'index.html': 'x' },
      functions: { 'api/hello.ts': 'export default () => {}' },
      binaryFiles: { 'logo.png': 'AAAA' },
    }),
    'p1',
  );
  assert.deepEqual(body.functions, { 'api/hello.ts': 'export default () => {}' });
  assert.deepEqual(body.binary_files, { 'logo.png': 'AAAA' });

  // Empty buckets are omitted entirely.
  const bare = buildCheckBody(collected({ files: { 'a.html': 'x' } }), 'p1');
  assert.equal('functions' in bare, false);
  assert.equal('binary_files' in bare, false);
});

test('buildCheckRunBody: appends the synthetic request target', () => {
  const body = buildCheckRunBody(collected({ files: { 'a.html': 'x' } }), 'p1', {
    path: '/api/hello',
    method: 'POST',
  });
  assert.equal(body.project_id, 'p1');
  assert.deepEqual(body.target, { path: '/api/hello', method: 'POST' });
});

test('request shape: dry compile POSTs /deploy/check with the source tree', async () => {
  lastRequest = null;
  const client = new ApiClient('smt_test_key');
  await client.call('POST', '/deploy/check', buildCheckBody(collected({ files: { 'a.html': 'x' } }), 'p1'));

  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.url, '/deploy/check');
  assert.equal(lastRequest.auth, 'Bearer smt_test_key');
  assert.deepEqual(lastRequest.body, { project_id: 'p1', files: { 'a.html': 'x' } });
});

test('request shape: --run POSTs /deploy/check/run with the target', async () => {
  lastRequest = null;
  const client = new ApiClient('smt_test_key');
  await client.call(
    'POST',
    '/deploy/check/run',
    buildCheckRunBody(collected({ files: { 'a.html': 'x' } }), 'p1', { path: '/api/hello', method: 'GET' }),
  );

  assert.equal(lastRequest.url, '/deploy/check/run');
  assert.deepEqual(lastRequest.body.target, { path: '/api/hello', method: 'GET' });
});

test('checkErrorsToCliError: errors-as-data maps to a renderable BUILD_ERROR', () => {
  const err = checkErrorsToCliError({
    ok: false,
    errors: [{ file: 'api/hello.ts', line: 2, column: 9, code: 'TS2304', message: "Cannot find name 'x'." }],
    build_log: ['compiled with errors'],
  });
  assert.ok(err instanceof CliApiError);
  assert.equal(err.code, 'BUILD_ERROR');
  assert.equal(err.data.errors.length, 1);
  assert.equal(err.data.errors[0].file, 'api/hello.ts');
});

test('checkErrorsToCliError: a clean (or empty) verdict returns null', () => {
  assert.equal(checkErrorsToCliError({ ok: true }), null);
  assert.equal(checkErrorsToCliError({ ok: false, errors: [] }), null);
  assert.equal(checkErrorsToCliError(undefined), null);
});

test('formatCheckRunResult: renders logs + status + body', () => {
  const lines = formatCheckRunResult({
    status: 200,
    body: { ok: true },
    logs: [{ level: 'log', message: 'hi' }],
    duration_ms: 12,
  });
  const out = lines.join('\n');
  assert.match(out, /Logs/);
  assert.match(out, /\[log\] hi/);
  assert.match(out, /200/);
  assert.match(out, /"ok": true/);
});

test('formatCheckRunResult: a thrown handler is reported, not swallowed', () => {
  const lines = formatCheckRunResult({ error: { name: 'TypeError', message: 'boom' } });
  assert.match(lines.join('\n'), /Handler threw: TypeError: boom/);
});

test.after(() => server.close());
