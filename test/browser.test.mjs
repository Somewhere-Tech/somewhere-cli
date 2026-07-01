import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// client.ts reads BASE_URL at module load, so point it at the mock server
// BEFORE the first import (browser.js imports client.js transitively).
let lastRequest = null;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastRequest = {
      method: req.method,
      url: req.url,
      auth: req.headers['authorization'],
      contentType: req.headers['content-type'],
      body: body ? JSON.parse(body) : null,
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        data: {
          passed: true,
          final_url: 'https://example.com/',
          console_errors: [],
          page_errors: [],
          failed_requests: [],
          steps: [],
          screenshots: [],
          dom_outline: [],
          testid_map: {},
        },
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.SOMEWHERE_API_URL = `http://127.0.0.1:${port}`;

const { ApiClient } = await import('../dist/lib/client.js');
const { buildBrowserBody, formatBrowserReport, browserExitCode } = await import(
  '../dist/commands/browser.js'
);

test('buildBrowserBody: a URL positional becomes `url`', () => {
  assert.deepEqual(buildBrowserBody('https://example.com', {}), {
    url: 'https://example.com',
  });
});

test('buildBrowserBody: a non-URL positional becomes `project_id`', () => {
  assert.deepEqual(buildBrowserBody('my-app', {}), { project_id: 'my-app' });
});

test('buildBrowserBody: falls back to the linked project when no target', () => {
  assert.deepEqual(buildBrowserBody(undefined, {}, 'linked-proj'), {
    project_id: 'linked-proj',
  });
});

test('buildBrowserBody: --url and --project flags win over the positional', () => {
  assert.deepEqual(
    buildBrowserBody('positional', { url: 'https://x.test', project: 'p' }),
    { url: 'https://x.test', project_id: 'p' },
  );
});

test('buildBrowserBody: action flags compile to an ordered steps array', () => {
  const body = buildBrowserBody('https://example.com', {
    path: '/login',
    wait: '#app',
    eval: 'document.title',
    screenshot: true,
    viewport: 'mobile',
  });
  assert.deepEqual(body.steps, [
    { action: 'goto', path: '/login' },
    { action: 'wait_for', selector: '#app' },
    { action: 'eval', script: 'document.title' },
    { action: 'screenshot' },
  ]);
  assert.equal(body.viewport, 'mobile');
});

test('buildBrowserBody: --snapshot is display-only (not a step)', () => {
  const body = buildBrowserBody('https://example.com', { snapshot: true });
  assert.equal('steps' in body, false);
});

test('buildBrowserBody: --store forwards store:true (EYES mode)', () => {
  const body = buildBrowserBody('https://example.com', { store: true });
  assert.equal(body.store, true);
});

test('buildBrowserBody: --include forwards the trimmed section array', () => {
  const body = buildBrowserBody('https://example.com', { include: 'network, dom' });
  assert.deepEqual(body.include, ['network', 'dom']);
});

test('request shape: POSTs /browser with bearer auth and the built body', async () => {
  lastRequest = null;
  const client = new ApiClient('smt_test_key');
  const body = buildBrowserBody('https://example.com', { eval: 'document.title' });
  await client.call('POST', '/browser/test', body);

  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.url, '/browser/test');
  assert.equal(lastRequest.auth, 'Bearer smt_test_key');
  assert.equal(lastRequest.contentType, 'application/json');
  assert.deepEqual(lastRequest.body, {
    url: 'https://example.com',
    steps: [{ action: 'eval', script: 'document.title' }],
  });
});

test('formatBrowserReport: surfaces the health signal as grep-able lines', () => {
  const lines = formatBrowserReport({
    passed: true,
    final_url: 'https://example.com/',
    console_errors: ['Refused to load favicon'],
    page_errors: [{ message: 'TypeError: x is not a function' }],
    failed_requests: [{ status: 500, method: 'GET', url: 'https://example.com/api/foo' }],
    steps: [{ action: 'eval', script: 'document.title', result: 'Example Domain' }],
    screenshots: ['/_browser_tests/abc.jpg'],
    dom_outline: [{ tag: 'a', text: 'Learn more', selector: 'a' }],
  });
  const out = lines.join('\n');
  assert.match(out, /^PASS https:\/\/example\.com\//m);
  assert.match(out, /console_errors: 1/);
  assert.match(out, /page_errors: 1/);
  assert.match(out, /failed_requests: 1/);
  assert.match(out, /dom: 1 interactive element/);
  assert.match(out, /console_error: Refused to load favicon/);
  assert.match(out, /page_error: TypeError: x is not a function/);
  assert.match(out, /failed_request: 500 GET https:\/\/example\.com\/api\/foo/);
  assert.match(out, /result: Example Domain/);
  assert.match(out, /screenshot: \/_browser_tests\/abc\.jpg/);
});

test('formatBrowserReport: EYES-mode scratch_url renders with its expiry', () => {
  const lines = formatBrowserReport({
    passed: true,
    screenshots: [
      { label: 'page', scratch_url: 'https://api.example/scratch/x.jpg', scratch_expires_at: '2026-07-01T00:00:00Z' },
    ],
  });
  const out = lines.join('\n');
  assert.match(out, /screenshot: page — https:\/\/api\.example\/scratch\/x\.jpg/);
  assert.match(out, /expires 2026-07-01T00:00:00Z/);
});

test('formatBrowserReport: an inline-only shot is noted, not dumped', () => {
  const lines = formatBrowserReport({
    passed: true,
    screenshots: [{ label: 'page', inline_base64: 'AAAA' }],
  });
  const out = lines.join('\n');
  assert.match(out, /screenshot: page — .*captured inline/);
  assert.doesNotMatch(out, /AAAA/);
});

test('formatBrowserReport: a VERIFY-mode fs_path prints as the stored path', () => {
  const lines = formatBrowserReport({
    passed: true,
    screenshots: [{ label: 'dashboard', fs_path: '/_browser_tests/run/00-dashboard.jpg' }],
  });
  assert.match(lines.join('\n'), /screenshot: dashboard — \/_browser_tests\/run\/00-dashboard\.jpg/);
});

test('formatBrowserReport: --snapshot prints the full DOM map', () => {
  const lines = formatBrowserReport(
    { passed: true, dom_outline: [{ tag: 'button', testid: 'submit', text: 'Go' }] },
    { snapshot: true },
  );
  assert.match(lines.join('\n'), /dom: button \[data-testid=submit\] "Go"/);
});

test('browserExitCode: clean pass is 0; a failed request or page error is 1', () => {
  assert.equal(browserExitCode({ passed: true, failed_requests: [], page_errors: [] }), 0);
  assert.equal(browserExitCode({ passed: false }), 1);
  assert.equal(browserExitCode({ passed: true, failed_requests: [{ status: 500 }] }), 1);
  assert.equal(browserExitCode({ passed: true, page_errors: [{ message: 'boom' }] }), 1);
  // Console errors alone are advisory — they don't fail the gate.
  assert.equal(browserExitCode({ passed: true, console_errors: ['noise'] }), 0);
});

test.after(() => server.close());
