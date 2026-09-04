import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  formatVerifyReport,
  normalizeVerifyFlow,
  runVerification,
} = await import('../dist/commands/verify.js');

const actions = [
  { fill: '#name', value: 'Potluck' },
  { click: '#save' },
  { expect: { selector: '#status', text: 'Saved' } },
];

function browserReport(overrides = {}) {
  return {
    passed: true,
    final_url: 'https://fixture.somewhere.site/',
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    request_expectations: [{ path: '/api/private', status: 401, ok: true }],
    steps: actions.map((action, step) => ({ step, action: Object.keys(action)[0], ok: true, duration_ms: 3 })),
    screenshots: [{ label: 'page', fs_path: '/_browser_tests/run/page.jpg', url: 'https://api.test/signed/page.jpg' }],
    ...overrides,
  };
}

function fixtureClient(reports, bodies = []) {
  return {
    async call(method, path, body) {
      assert.equal(method, 'POST');
      assert.equal(path, '/browser/test');
      bodies.push(body);
      return reports[bodies.length - 1] ?? reports.at(-1);
    },
  };
}

test('missing flow uses the default health check and desktop + phone viewports', () => {
  const flow = normalizeVerifyFlow(undefined);
  assert.deepEqual(flow, { actions: [], expect_requests: [], visible_only: false, viewports: ['desktop', 'mobile'] });
});

test('passing flow returns one report with every step, expected 401 excluded, and two screenshots', async () => {
  const flow = normalizeVerifyFlow({
    actions,
    expect_requests: [{ path: '/api/private', status: 401 }],
    visible_only: true,
    viewports: ['desktop', 'mobile'],
  });
  const bodies = [];
  const report = await runVerification(
    { project_id: 'fixture' },
    flow,
    fixtureClient([browserReport(), browserReport()], bodies),
  );
  assert.equal(report.passed, true, report.verdict);
  assert.equal(report.steps.length, 6);
  assert.equal(report.screenshots.length, 2);
  assert.equal(report.health.console.passed, true);
  assert.equal(report.health.network.passed, true);
  assert.equal(report.health.network.failed_requests.length, 0);
  assert.deepEqual(bodies.map((body) => body.viewport), ['desktop', 'mobile']);
  assert.ok(bodies.every((body) => body.capture_after === true && body.inline === false && body.visible_only === true));
  assert.ok(bodies.every((body) => !('session_id' in body)), 'verification never leaves a reconnectable browser session');
});

test('authenticated flow fields reach every hosted viewport without changing anonymous requests', async () => {
  const authenticated = normalizeVerifyFlow({
    actions: [
      { upload: '#avatar', file: 'data:image/png;base64,cG5n', name: 'shot.png' },
      { screenshot: 'signed-in' },
    ],
    auth: { user_id: 'usr_fixture' },
    local_storage: { sw_auth: 'session_fixture' },
    cookies: [{ name: '__Host-token', value: 'cookie_fixture' }],
    headers: { Authorization: 'Bearer user_fixture' },
    viewports: ['desktop', 'mobile'],
  });
  const bodies = [];
  await runVerification(
    { project_id: 'fixture', url: 'https://fixture.somewhere.site/account' },
    authenticated,
    fixtureClient([browserReport(), browserReport()], bodies),
  );
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.auth.user_id === 'usr_fixture'));
  assert.ok(bodies.every((body) => body.local_storage.sw_auth === 'session_fixture'));
  assert.ok(bodies.every((body) => body.cookies[0].name === '__Host-token'));
  assert.ok(bodies.every((body) => body.headers.Authorization === 'Bearer user_fixture'));
  assert.ok(bodies.every((body) => body.actions[0].upload === '#avatar' && body.actions[1].screenshot === 'signed-in'));

  const anonymousBodies = [];
  await runVerification(
    { project_id: 'fixture' },
    normalizeVerifyFlow({ viewports: ['desktop'] }),
    fixtureClient([browserReport()], anonymousBodies),
  );
  for (const field of ['auth', 'local_storage', 'cookies', 'headers']) {
    assert.equal(field in anonymousBodies[0], false, `anonymous verification must omit ${field}`);
  }
});

test('verification refuses session data without project scope and local impersonation before opening a browser', async () => {
  await assert.rejects(
    () => runVerification(
      { url: 'https://third-party.test' },
      normalizeVerifyFlow({ cookies: [{ name: 'session', value: 'secret' }] }),
      fixtureClient([browserReport()]),
    ),
    /needs --project/,
  );
  await assert.rejects(
    () => runVerification(
      { url: 'http://127.0.0.1:65534' },
      normalizeVerifyFlow({ auth: { user_id: 'usr_fixture' } }),
    ),
    /impersonation is not available against a local address/,
  );
});

test('verification rejects malformed and oversized session seed fields', () => {
  assert.throws(() => normalizeVerifyFlow({ auth: { user_id: '' } }), /auth must be/);
  assert.throws(() => normalizeVerifyFlow({ cookies: [{ name: '', value: 'x' }] }), /cookies\[0\]/);
  assert.throws(() => normalizeVerifyFlow({ headers: { Authorization: 42 } }), /only string values/);
  assert.throws(
    () => normalizeVerifyFlow({ local_storage: { sw_auth: 'x'.repeat(9 * 1024) } }),
    /8 KB/,
  );
});

test('verify --session and repeatable --cookie seed both hosted viewports', async () => {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/browser/test') {
        bodies.push(JSON.parse(body));
        res.end(JSON.stringify({ ok: true, data: browserReport({ steps: [] }) }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', message: req.url }));
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  const home = mkdtempSync(join(tmpdir(), 'sw-verify-session-home-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_fixture' }));

  const result = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      join(process.cwd(), 'dist/index.js'),
      'verify', '--project', 'fixture', '--url', 'https://fixture.somewhere.site/account',
      '--session', 'session_fixture',
      '--cookie', 'session=cookie_fixture',
      '--cookie', 'theme=dark',
      '--json',
    ], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
  await new Promise((resolvePromise) => server.close(resolvePromise));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, true);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.local_storage.sw_auth === 'session_fixture'));
  assert.ok(bodies.every((body) => body.cookies.length === 2));
  assert.deepEqual(bodies.map((body) => body.viewport).sort(), ['desktop', 'mobile']);
});

test('a third action failure names step 3 and its viewport', async () => {
  const failed = browserReport({
    passed: false,
    steps: [
      { step: 0, action: 'fill', ok: true },
      { step: 1, action: 'click', ok: true },
      { step: 2, action: 'expect', ok: false, error: 'Expected #status to contain Saved.' },
    ],
  });
  const report = await runVerification(
    { project_id: 'fixture' },
    normalizeVerifyFlow({ actions, viewports: ['desktop', 'mobile'] }),
    fixtureClient([browserReport(), failed]),
  );
  assert.equal(report.passed, false);
  assert.match(report.verdict, /step 3 \(expect #status\) failed at mobile/);
  assert.ok(formatVerifyReport(report)[0].includes('step 3'));
});

test('an unexpected 500 fails network health and the one-line verdict', async () => {
  const failed = browserReport({
    passed: false,
    failed_requests: [{ status: 500, method: 'GET', url: 'https://fixture.somewhere.site/api/broken' }],
  });
  const report = await runVerification(
    { project_id: 'fixture' },
    normalizeVerifyFlow({ actions: [], viewports: ['desktop'] }),
    fixtureClient([failed]),
  );
  assert.equal(report.passed, false);
  assert.equal(report.health.network.passed, false);
  assert.match(report.verdict, /unexpected request failure/);
});

test('a missing final screenshot fails verification instead of returning a false green', async () => {
  const report = await runVerification(
    { project_id: 'fixture' },
    normalizeVerifyFlow({ actions: [], viewports: ['mobile'] }),
    fixtureClient([browserReport({ screenshots: [] })]),
  );
  assert.equal(report.passed, false);
  assert.match(report.verdict, /screenshot capture failed at mobile/);
});

test('deploy --verify runs the flow after deploy and includes its structured report in JSON', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        res.end(JSON.stringify({
          ok: true,
          data: { project_id: 'fixture', url: 'https://fixture.somewhere.site', has_functions: false, files: 1 },
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/browser/test') {
        res.end(JSON.stringify({ ok: true, data: browserReport() }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', message: req.url }));
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  const home = mkdtempSync(join(tmpdir(), 'sw-verify-home-'));
  const project = mkdtempSync(join(tmpdir(), 'sw-verify-project-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_fixture' }));
  writeFileSync(join(project, '.somewhere.json'), JSON.stringify({ project_id: 'fixture', name: 'fixture', subdomain: 'fixture' }));
  writeFileSync(join(project, 'index.html'), '<h1>Fixture</h1>');
  writeFileSync(join(project, 'flow.json'), JSON.stringify({ actions, expect_requests: [{ path: '/api/private', status: 401 }] }));

  const result = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'dist/index.js'), 'deploy', '--verify', 'flow.json', '--json'], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
  await new Promise((resolvePromise) => server.close(resolvePromise));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verification.passed, true);
  assert.equal(payload.verification.screenshots.length, 2);
});
