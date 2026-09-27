// Verify diagnostics (tsk_64e1bf6e2a38425895a1bfed32669501), reproduced from the
// solo Bookclub r10 evidence (coordination/root-20260926/browser-efficiency-evidence):
//  - failure 1: two of five signed-out probes returned 401 but were not declared;
//    the verdict said only "console error … status of 401 (Unauthorized)";
//  - failure 2: the platform's start navigation timed out before any action,
//    and the verdict blamed the flow's first action ("step 1 (wait #auth-email)").
// Both directions: the diagnosis names what happened, and it never declares a
// status on the flow's behalf.
import test from 'node:test';
import assert from 'node:assert/strict';

const { formatVerifyReport, normalizeVerifyFlow, runVerification } = await import('../dist/commands/verify.js');

const ORIGIN = 'https://bookclub-r10.somewhere.site';
const GENERIC_401 = 'Failed to load resource: the server responded with a status of 401 (Unauthorized)';

function platformReport(overrides = {}) {
  return {
    passed: true,
    final_url: `${ORIGIN}/signin`,
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    request_expectations: [],
    steps: [],
    screenshots: [{ label: 'page', fs_path: '/_browser_tests/r/page.jpg', url: 'https://api.test/s/page.jpg' }],
    ...overrides,
  };
}

function client(reports, bodies = []) {
  return {
    async call(_method, _path, body) {
      bodies.push(structuredClone(body));
      return reports[bodies.length - 1] ?? reports.at(-1);
    },
  };
}

const probe = "Promise.all(['/api/state','/api/proposals','/api/votes','/api/rounds/close','/api/rounds/open'].map(p => fetch(p, { method: p === '/api/state' ? 'GET' : 'POST' }).then(r => p + ' ' + r.status)))";
const failure1Flow = {
  actions: [{ wait: '#auth-email' }, { eval: 'location.pathname' }, { expect: { selector: "form[aria-label='Sign in']", visible: true } }, { eval: probe }],
  expect_requests: [{ path: '/api/state', status: 401 }, { path: '/api/votes', status: 401 }, { path: '/api/rounds/close', status: 401 }],
  viewports: ['mobile'],
};
const failure1Report = (initiator) => platformReport({
  passed: false,
  console_errors: [GENERIC_401, GENERIC_401],
  failed_requests: [
    { url: `${ORIGIN}/api/proposals`, status: 401, method: 'POST', ...(initiator ? { initiator } : {}) },
    { url: `${ORIGIN}/api/rounds/open`, status: 401, method: 'POST', ...(initiator ? { initiator } : {}) },
  ],
  request_expectations: failure1Flow.expect_requests.map((item) => ({ ...item, ok: true })),
  steps: failure1Flow.actions.map((action, step) => ({ step, action: Object.keys(action)[0], ok: true, duration_ms: 5 })),
});

test('failure 1: an undeclared probe 401 names the method, path, status, that the eval step made it, and the exact entry to add', async () => {
  const bodies = [];
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow(failure1Flow), client([failure1Report('eval')], bodies));
  assert.equal(report.passed, false, 'an undeclared status still fails the run');
  assert.equal(report.verdict,
    'FAIL — POST /api/proposals answered 401 at mobile, which the flow did not declare. Your eval step made this request (a probe). '
    + 'If the refusal is intended, add {"path":"/api/proposals","status":401} to expect_requests. Also undeclared: POST /api/rounds/open 401.');
  assert.deepEqual(report.undeclared_statuses.map((u) => [u.method, u.path, u.status, u.initiator]), [
    ['POST', '/api/proposals', 401, 'eval'],
    ['POST', '/api/rounds/open', 401, 'eval'],
  ]);
  assert.deepEqual(report.undeclared_statuses[0].declare, { path: '/api/proposals', status: 401 });
  // Never declared on the flow's behalf: the request carried only the three
  // declared statuses, and the console errors remain reported.
  assert.deepEqual(bodies[0].expect_requests, failure1Flow.expect_requests);
  assert.equal(report.health.console.passed, false);
  assert.equal(report.health.console.errors.length, 2);
  assert.match(formatVerifyReport(report).join('\n'), /undeclared: \[mobile\] POST \/api\/proposals → 401 \(from your eval step\); declare with \{"path":"\/api\/proposals","status":401\} if intended/);
});

test('the same undeclared status from the app\'s own code is called an app failure unless intended', async () => {
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow(failure1Flow), client([failure1Report('page')]));
  assert.equal(report.passed, false);
  assert.match(report.verdict, /The app's own code made this request, not a verify step\. If the app is meant to be refused here, add \{"path":"\/api\/proposals","status":401\} to expect_requests; otherwise it is an app failure to fix\./);
});

test('without initiator evidence (an older platform) the origin is not guessed', async () => {
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow(failure1Flow), client([failure1Report(undefined)]));
  assert.match(report.verdict, /It could not be established whether a verify step or the app made this request\./);
  assert.equal(report.undeclared_statuses[0].initiator, 'unknown');
});

test('a real console error still comes before an undeclared status', async () => {
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow(failure1Flow), client([{
    ...failure1Report('eval'),
    console_errors: ["TypeError: Cannot read properties of undefined (reading 'id')", GENERIC_401],
  }]));
  assert.match(report.verdict, /^FAIL — console error at mobile: TypeError: Cannot read properties of undefined/);
});

test('a resource-failure console line whose status matches no undeclared response is still reported as a console error', async () => {
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow(failure1Flow), client([{
    ...failure1Report('eval'),
    console_errors: ['Failed to load resource: the server responded with a status of 404 (Not Found)'],
  }]));
  assert.match(report.verdict, /^FAIL — console error at mobile: Failed to load resource: the server responded with a status of 404/);
});

test('every probe declared: the run passes and nothing is listed as undeclared', async () => {
  const declared = { ...failure1Flow, expect_requests: ['/api/state', '/api/proposals', '/api/votes', '/api/rounds/close', '/api/rounds/open'].map((path) => ({ path, status: 401 })) };
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow(declared), client([platformReport({
    request_expectations: declared.expect_requests.map((item) => ({ ...item, ok: true })),
    steps: declared.actions.map((action, step) => ({ step, action: Object.keys(action)[0], ok: true })),
  })]));
  assert.equal(report.passed, true, report.verdict);
  assert.deepEqual(report.undeclared_statuses, []);
});

const startTimeout = (extra = {}) => platformReport({
  passed: false,
  final_url: `${ORIGIN}/`,
  screenshots: [],
  steps: [{
    step: 0, action: 'goto', phase: 'start_navigation', ok: false, duration_ms: 0,
    error: 'navigation failed: Navigation timeout of 15000 ms exceeded. No response for the page\'s document was observed; the page was still on its initial blank page.',
  }],
  navigation_snapshot: { document_status: null, ready_state: 'complete', url: 'about:blank', text_chars: 0, pending: [] },
  ...extra,
});

test('failure 2: a start-page timeout is reported as the platform opening the page, not the flow\'s first action', async () => {
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow(failure1Flow), client([startTimeout()]));
  assert.equal(report.passed, false);
  assert.equal(report.steps[0].step, 0);
  assert.equal(report.steps[0].name, 'open the start page (before any action)');
  assert.match(report.verdict, /^FAIL — step 0 \(open the start page \(before any action\)\) failed at mobile: navigation failed: Navigation timeout of 15000 ms exceeded\. No response for the page's document was observed; the page was still on its initial blank page\./);
  assert.doesNotMatch(report.verdict, /wait #auth-email/);
});

test('a flow whose own first action is a goto keeps that action\'s name', async () => {
  const flow = normalizeVerifyFlow({ actions: [{ goto: '/club' }], viewports: ['desktop'] });
  const report = await runVerification({ project_id: 'club' }, flow, client([platformReport({ passed: false, steps: [{ step: 0, action: 'goto', ok: false, error: 'navigation failed: net::ERR_ABORTED' }] })]));
  assert.equal(report.steps[0].name, 'goto /club');
  assert.equal(report.steps[0].step, 1);
});

test('a start page opened a second time still passes, and says so without claiming a cause', async () => {
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow({ actions: [{ wait: '#auth-email' }], viewports: ['mobile'] }), client([platformReport({
    steps: [{ step: 0, action: 'wait', ok: true }],
    navigation_retries: [{ phase: 'start_navigation', error: 'Navigation timeout of 15000 ms exceeded', elapsed_ms: 15004, snapshot: { document_status: null } }],
  })]));
  assert.equal(report.passed, true);
  assert.match(report.verdict, /^PASS — .* The start page was opened a second time at mobile: the first navigation timed out with no document response observed while the page was still blank \(no action had run\)\.$/);
  assert.doesNotMatch(report.verdict, /infrastructur|never answered|proven/i);
  assert.deepEqual(report.navigation_retries, [{ viewport: 'mobile', detail: { phase: 'start_navigation', error: 'Navigation timeout of 15000 ms exceeded', elapsed_ms: 15004 } }]);
  assert.match(formatVerifyReport(report).join('\n'), /navigation repeated: \[mobile\] the start page was opened a second time after: Navigation timeout of 15000 ms exceeded/);
});

test('undeclared-status summaries carry no query, fragment, or credential-shaped path segment', async () => {
  const report = await runVerification({ project_id: 'club' }, normalizeVerifyFlow({ actions: [], viewports: ['desktop'] }), client([platformReport({
    passed: false,
    failed_requests: [{ url: `${ORIGIN}/api/share/eyJhbGciOi.eyJzdWIi.c2ln/view?token=secret#frag`, status: 403, method: 'GET', initiator: 'page' }],
  })]));
  assert.equal(report.undeclared_statuses[0].path, '/api/share/<redacted>/view');
  assert.deepEqual(report.undeclared_statuses[0].declare, { path: '/api/share/<redacted>/view', status: 403 });
  assert.doesNotMatch(report.verdict, /secret|frag|eyJ/);
});
