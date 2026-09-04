import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const { buildBrowserBody, formatBrowserReport, browserExitCode, normalizeBrowserVerdict, localBrowserUnsupportedMessage } = await import(
  '../dist/commands/browser.js'
);
const { normalizeBrowserActions } = await import('../dist/lib/browser-actions.js');

function runCli(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'dist/index.js'), ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: process.env.SOMEWHERE_API_URL },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

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

test('buildBrowserBody: an explicit URL stays in EYES mode in a linked directory', () => {
  assert.deepEqual(buildBrowserBody('https://third-party.test/docs', {}, 'linked-proj'), {
    url: 'https://third-party.test/docs',
  });
  assert.deepEqual(buildBrowserBody(undefined, { url: 'https://third-party.test/docs' }, 'linked-proj'), {
    url: 'https://third-party.test/docs',
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

test('buildBrowserBody: concise actions, expected requests, and visible-only use the shared wire contract', () => {
  const actions = [
    { fill: '#email', value: 'a@b.co' },
    { upload: '#avatar', file: 'data:image/png;base64,cG5n', name: 'shot.png' },
    { click: '#save' },
    { expect: { selector: '.saved', text: 'Saved', visible: true, count: 1 } },
  ];
  const body = buildBrowserBody('https://example.com', {
    actionSequence: actions,
    expectedRequests: [{ path: '/api/tasks', status: 401 }],
    visibleOnly: true,
  });
  assert.deepEqual(body.actions, actions);
  assert.deepEqual(body.expect_requests, [{ path: '/api/tasks', status: 401 }]);
  assert.equal(body.visible_only, true);
  assert.equal('steps' in body, false);
});

test('buildBrowserBody: named --screenshot uses the shared concise shorthand', () => {
  const body = buildBrowserBody('my-app', { screenshot: 'after-save' });
  assert.deepEqual(body.actions, [{ screenshot: 'after-save' }]);
  assert.equal('steps' in body, false);
});

test('--actions uses the shared shorthand and rejects the expanded step spelling', () => {
  const canonical = normalizeBrowserActions([
    { fill: '#email', value: 'a@b.co' },
    { click: '#save' },
    { expect: { selector: '#status', text: 'Saved', value: 'ready' } },
  ]);
  assert.equal(canonical.ok, true);
  const expanded = normalizeBrowserActions([
    { action: 'fill', selector: '#email', value: 'a@b.co' },
  ]);
  assert.equal(expanded.ok, false);
  assert.match(expanded.error, /exactly one of click, fill, upload, select, wait, expect, screenshot, eval/);
});

test('buildBrowserBody: --snapshot is not a step', () => {
  const body = buildBrowserBody('https://example.com', { snapshot: true });
  assert.equal('steps' in body, false);
});

// `--snapshot` PRINTS the interactive-element map, so it has to ASK for it. The
// map is an opt-in section; without this the flag rendered whatever the
// response happened to carry, which was nothing — `--wait button --snapshot`
// matched a button and then printed "dom: 0 interactive elements" on a page
// with three of them (tsk_bdd72f02c2).
test('buildBrowserBody: --snapshot requests the DOM section', () => {
  assert.deepEqual(buildBrowserBody('https://example.com', { snapshot: true }).include, ['dom']);
});

test('buildBrowserBody: --snapshot requests the DOM section alongside steps', () => {
  const body = buildBrowserBody('https://example.com', { snapshot: true, wait: 'button' });
  assert.deepEqual(body.steps, [{ action: 'wait_for', selector: 'button' }]);
  assert.deepEqual(body.include, ['dom']);
});

test('buildBrowserBody: --snapshot merges with --include without duplicating', () => {
  const body = buildBrowserBody('https://example.com', { snapshot: true, include: 'network, dom' });
  assert.deepEqual(body.include, ['network', 'dom']);
});

test('buildBrowserBody: without --snapshot the DOM section stays opt-in', () => {
  assert.equal('include' in buildBrowserBody('https://example.com', { wait: 'button' }), false);
});

// A stored screenshot came back as a storage path alone. Read as a URL — the
// only thing a path in a report looks like — it is not one, so the single value
// the command handed back for "here is your screenshot" could not be used to
// see the screenshot (tsk_70fd0f63a9). Lead with the link; keep the stored path
// on its own line, because that is the durable handle for reading or replacing
// the file later.
test('formatBrowserReport: a stored screenshot prints a link that opens it', () => {
  const lines = formatBrowserReport({
    screenshots: [
      {
        label: 'page',
        fs_path: '/_browser_tests/run-1/00-step-1.jpg',
        url: 'https://api.somewhere.tech/v1/fs-signed/tok',
        url_expires_at: '2026-09-02T09:00:00.000Z',
      },
    ],
  });
  const shot = lines.find((l) => l.startsWith('screenshot:'));
  assert.match(shot, /https:\/\/api\.somewhere\.tech\/v1\/fs-signed\/tok/);
  assert.match(shot, /link expires 2026-09-02T09:00:00\.000Z/);
  assert.ok(
    lines.some((l) => l === 'screenshot_file: page — /_browser_tests/run-1/00-step-1.jpg'),
    `the stored path is still reported: ${JSON.stringify(lines)}`,
  );
});

test('formatBrowserReport: with no link the stored path is still reported', () => {
  const lines = formatBrowserReport({
    screenshots: [{ label: 'page', fs_path: '/_browser_tests/run-1/00-step-1.jpg' }],
  });
  assert.ok(lines.includes('screenshot: page — /_browser_tests/run-1/00-step-1.jpg'));
  assert.equal(lines.some((l) => l.startsWith('screenshot_file:')), false);
});

test('buildBrowserBody: --store forwards store:true (EYES mode)', () => {
  const body = buildBrowserBody('https://example.com', { store: true });
  assert.equal(body.store, true);
});

test('buildBrowserBody: --include forwards the trimmed section array', () => {
  const body = buildBrowserBody('https://example.com', { include: 'network, dom' });
  assert.deepEqual(body.include, ['network', 'dom']);
});

test('buildBrowserBody: --extract forwards extract:"markdown" (feature A)', () => {
  const body = buildBrowserBody('https://example.com', { extract: true });
  assert.equal(body.extract, 'markdown');
});

test('buildBrowserBody: --include markdown passes through', () => {
  const body = buildBrowserBody('https://example.com', { include: 'markdown' });
  assert.deepEqual(body.include, ['markdown']);
});

test('buildBrowserBody: --session forwards session_id (feature B)', () => {
  const body = buildBrowserBody('https://example.com', { session: 'checkout-flow' });
  assert.equal(body.session_id, 'checkout-flow');
});

test('localhost session refusal names the fresh-run alternative', () => {
  const message = localBrowserUnsupportedMessage({ session: 'checkout-flow' });
  assert.match(message, /named sessions are hosted-browser only/);
  assert.match(message, /omit --session/);
  assert.match(message, /pass the local URL again/);
});

test('formatBrowserReport: surfaces the session handle + expiry', () => {
  const lines = formatBrowserReport({
    passed: true,
    final_url: 'https://example.com/',
    session_id: 'flow1',
    session_expires_at: '2026-01-01T00:00:00Z',
    session_note: 'session expired, started fresh',
  });
  assert.ok(lines.some((l) => l.includes('session: flow1')));
  assert.ok(lines.some((l) => l.includes('session_note')));
});

test('formatBrowserReport: prints extracted markdown fenced', () => {
  const lines = formatBrowserReport({
    passed: true,
    final_url: 'https://example.com/',
    markdown: '# Title\n\nBody text',
  });
  assert.ok(lines.includes('--- markdown ---'));
  assert.ok(lines.includes('# Title'));
  assert.ok(lines.includes('--- end markdown ---'));
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

test('repeatable action flags and --actions preserve command-line order on the wire', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-browser-actions-home-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_test_key' }));
  const uploadFile = join(home, 'shot.png');
  writeFileSync(uploadFile, Buffer.from('png fixture'));
  const actionsFile = join(home, 'actions.json');
  writeFileSync(actionsFile, JSON.stringify([{ wait: '#ready' }, { upload: '#from-file', file: './shot.png' }, { eval: 'document.title' }]));
  lastRequest = null;
  const result = await runCli([
    'browser',
    'https://example.com',
    '--fill', '#email=a@b.co',
    '--upload', `#avatar=${uploadFile}`,
    '--click', '#save',
    '--actions', actionsFile,
    '--select', '#plan=pro',
    '--expect', '.saved:text=Saved',
    '--expect-request', '/api/tasks:401',
    '--visible-only',
    '--json',
  ], home);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lastRequest.body.actions, [
    { fill: '#email', value: 'a@b.co' },
    { upload: '#avatar', file: `data:image/png;base64,${Buffer.from('png fixture').toString('base64')}`, name: 'shot.png' },
    { click: '#save' },
    { wait: '#ready' },
    { upload: '#from-file', file: `data:image/png;base64,${Buffer.from('png fixture').toString('base64')}`, name: 'shot.png' },
    { eval: 'document.title' },
    { select: '#plan', value: 'pro' },
    { expect: { selector: '.saved', text: 'Saved' } },
  ]);
  assert.deepEqual(lastRequest.body.expect_requests, [{ path: '/api/tasks', status: 401 }]);
  assert.equal(lastRequest.body.visible_only, true);
});

test('existing --wait/--eval/--screenshot combinations remain on the legacy step contract', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-browser-legacy-home-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_test_key' }));
  lastRequest = null;
  const result = await runCli([
    'browser', '--project', 'fixture-project',
    '--wait', '#ready',
    '--eval', 'document.title',
    '--screenshot',
    '--json',
  ], home);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lastRequest.body.steps, [
    { action: 'wait_for', selector: '#ready' },
    { action: 'eval', script: 'document.title' },
    { action: 'screenshot' },
  ]);
  assert.equal('actions' in lastRequest.body, false);
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
  assert.match(lines.join('\n'), /dom: button \[data-testid=submit\] \[visible\] "Go"/);
});

test('formatBrowserReport: DOM state annotations distinguish hidden and disabled controls', () => {
  const lines = formatBrowserReport(
    {
      passed: true,
      dom_outline: [
        { tag: 'button', selector: '#hidden', visible: false },
        { tag: 'button', selector: '#disabled', visible: true, disabled: true },
      ],
    },
    { snapshot: true },
  );
  assert.match(lines.join('\n'), /#hidden \[hidden\]/);
  assert.match(lines.join('\n'), /#disabled \[disabled\]/);
});

test('formatBrowserReport: request expectations show pass/fail reasons', () => {
  const lines = formatBrowserReport({
    passed: false,
    request_expectations: [
      { path: '/api/allowed', status: 401, ok: true },
      { path: '/api/missing', status: 403, ok: false, error: 'no matching request was observed' },
    ],
  });
  assert.ok(lines.some((line) => line.includes('/api/allowed:401')));
  assert.ok(lines.some((line) => line.includes('/api/missing:403') && line.includes('no matching request')));
});

test('browserExitCode: clean pass is 0; a failed request or page error is 1', () => {
  assert.equal(browserExitCode({ passed: true, failed_requests: [], page_errors: [] }), 0);
  assert.equal(browserExitCode({ passed: false }), 1);
  assert.equal(browserExitCode({ passed: true, failed_requests: [{ status: 500 }] }), 1);
  assert.equal(browserExitCode({ passed: true, page_errors: [{ message: 'boom' }] }), 1);
  assert.equal(browserExitCode({ passed: true, request_expectations: [{ path: '/api/x', status: 401, ok: false }] }), 1);
  // Console errors alone are advisory — they don't fail the gate.
  assert.equal(browserExitCode({ passed: true, console_errors: ['noise'] }), 0);
});

test('normalizeBrowserVerdict makes passed agree with an unhealthy exit', () => {
  const result = normalizeBrowserVerdict({
    passed: true,
    failed_requests: [{ status: 404, url: 'https://example.com/missing' }],
    console_errors: ['resource failed'],
  });
  assert.equal(result.passed, false);
  assert.equal(browserExitCode(result), 1);
  assert.equal(normalizeBrowserVerdict({ passed: true, console_errors: ['advisory'] }).passed, true);
});

test.after(() => server.close());
