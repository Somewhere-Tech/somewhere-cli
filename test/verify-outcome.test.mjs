import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVerifyFlow, runVerification, normalizeVerifyJourney, createVerifyJourneyRun, formatVerifyReport, formatVerifyJourneyReport } from '../dist/commands/verify.js';
import { formatStepDuration, browserExitCode, formatBrowserReport } from '../dist/commands/browser.js';
import { withVerifyProgress } from '../dist/lib/verify-progress.js';
import { CliApiError } from '../dist/lib/client.js';

const healthy = { passed: true, steps: [{ step: 0, ok: true, duration_ms: 12.4 }], screenshots: [{ path: '/page.jpg' }] };
const flow = normalizeVerifyFlow({ actions: [{ click: '#save' }], viewports: ['desktop'] });
const journey = normalizeVerifyJourney({ actors: { alice: {}, bob: {} }, journey: [
  { as: 'alice', actions: [{ click: '#save' }] }, { as: 'bob', actions: [{ click: '#next' }] },
] });
function fake(answer, close = { closed: true }) {
  const calls = [];
  return { calls, async call(_method, _path, body, _query, opts) {
    calls.push({ body, opts });
    return body.project_id ? answer(body) : close;
  } };
}

for (const status of ['execution_timeout', 'evidence_timeout', 'cleanup_unknown']) {
  test(`${status} is incomplete without invented steps or screenshots`, async () => {
    const client = fake(() => ({ passed: false, lifecycle: { status, outcome_unknown: true } }));
    const report = await runVerification({ project_id: 'fixture' }, flow, client);
    assert.equal(report.passed, false);
    assert.match(report.verdict, /^INCOMPLETE — Outcome unknown/);
    assert.doesNotMatch(report.verdict, /screenshot capture failed|step 1.*did not run/);
    assert.deepEqual(report.incomplete, []);
    assert.deepEqual(report.steps, []);
    assert.equal(client.calls.length, 1);
    assert.match(formatVerifyReport(report).join('\n'), /page_health: .*UNKNOWN/);
    assert.equal(browserExitCode({ passed: true, lifecycle: { status, outcome_unknown: true } }), 1);
  });
}

test('a genuine failed step remains FAIL with uncertain cleanup, and timings are measured only', async () => {
  const client = fake(() => ({ ...healthy, passed: false, steps: [
    { step: 0, ok: false, error: 'Expected saved', duration_ms: 18.6 },
  ], lifecycle: { status: 'cleanup_unknown', outcome_unknown: true } }));
  const result = await runVerification({ project_id: 'fixture' }, flow, client);
  assert.match(result.verdict, /^FAIL — step 1 .*Expected saved.*INCOMPLETE — Outcome unknown/);
  assert.match(formatVerifyReport(result).join('\n'), /\(19 ms\)/);
  for (const value of [undefined, NaN, Infinity, -1, '12']) assert.equal(formatStepDuration(value), '');
  assert.equal(formatStepDuration(12, false), '');
});

for (const code of ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_SLOW']) {
  test(`${code} preserves JSON detail, is unknown, and never replays`, async () => {
    const client = fake(() => { throw new CliApiError(code, 'Original transport detail', 0); });
    const result = await runVerification({ project_id: 'fixture' }, flow, client);
    assert.equal(result.passed, false);
    assert.match(result.verdict, /^INCOMPLETE/);
    assert.deepEqual(result.transport_errors[0].detail, { code, message: 'Original transport detail', status: 0 });
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].body.budget_ms, 180000);
    assert.equal(client.calls[0].opts.timeoutMs, 225000);
  });
}

test('explicit HTTP authentication, validation and timeout refusals stay errors', async () => {
  for (const [code, status] of [['UNAUTHORIZED', 401], ['VALIDATION_ERROR', 400], ['TIMEOUT', 504], ['NETWORK_ERROR', 503]]) {
    const cause = new CliApiError(code, 'Refused', status);
    const client = fake(() => { throw cause; });
    await assert.rejects(runVerification({ project_id: 'fixture' }, flow, client), (error) => error === cause);
    assert.equal(client.calls.length, 1);
  }
});

test('unknown actor lifecycle never keeps the actor or starts a later segment', async () => {
  const client = fake(() => ({ ...healthy, passed: false, lifecycle: { status: 'execution_timeout', outcome_unknown: true },
    session_expires_at: '2099-01-01', idle_expires_at: '2099-01-01', absolute_expires_at: '2099-01-02',
    incomplete: { reason: 'execution_cap', completed: 0, next_step: 0, budget_ms: 180000, elapsed_ms: 180000 },
  }));
  const result = await createVerifyJourneyRun({ project_id: 'fixture' }, journey, client, { runId: 'unknown', recloseAfterAbandonedMs: 1 }).run();
  assert.equal(client.calls.filter((call) => call.body.project_id).length, 1);
  assert.deepEqual(result.kept_sessions, []);
  assert.equal(result.cleanup_confirmed, false, 'a close response cannot prove no late allocation survives');
  assert.equal(result.cleanup[0].status, 'unconfirmed');
  assert.equal(client.calls.filter((call) => !call.body.project_id).length, 2);
  assert.equal(result.segments[1].ran, false);
  assert.match(formatVerifyJourneyReport(result).join('\n'), /outcome unknown/);
  assert.doesNotMatch(result.verdict, /kept open|platform closed/);
});

test('healthy app with failed cleanup is INCOMPLETE, not PASS', async () => {
  const client = fake(() => healthy);
  const original = client.call;
  client.call = (...args) => args[2].project_id ? original(...args) : Promise.reject(new CliApiError('AUTHORITY_UNAVAILABLE', 'Unavailable', 503));
  const result = await createVerifyJourneyRun({ project_id: 'fixture' }, journey, client, { runId: 'cleanup' }).run();
  assert.equal(result.passed, false);
  assert.equal(result.cleanup_confirmed, false);
  assert.match(result.verdict, /^INCOMPLETE.*cleanup_unknown/);
});

test('human warning fires once at 60 seconds and never replays the operation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = [];
  t.mock.method(process.stderr, 'write', (line) => { output.push(line); return true; });
  let finish; let calls = 0;
  const running = withVerifyProgress(() => { calls++; return new Promise((resolve) => { finish = resolve; }); }, true);
  t.mock.timers.tick(59999);
  assert.equal(output.length, 0);
  t.mock.timers.tick(1);
  assert.match(output.join(''), /60 seconds.*do not restart/);
  t.mock.timers.tick(60000);
  assert.equal(output.length, 1);
  finish('done');
  assert.equal(await running, 'done');
  assert.equal(calls, 1);
});

test('JSON runs and already settled/rejected human runs never emit a warning', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = [];
  t.mock.method(process.stderr, 'write', (line) => { output.push(line); return true; });
  let finish;
  const running = withVerifyProgress(() => new Promise((resolve) => { finish = resolve; }), false);
  t.mock.timers.tick(60000);
  finish(1); await running;
  await withVerifyProgress(async () => 2, true);
  await assert.rejects(withVerifyProgress(async () => { throw new Error('refused'); }, true), /refused/);
  t.mock.timers.tick(60000);
  assert.deepEqual(output, []);
});

test('an unknown viewport does not hide a conclusive failure at another viewport', async () => {
  for (const failure of [
    { screenshots: [] },
    { request_expectations: [{ ok: false, path: '/save', status: 200 }] },
  ]) {
    const client = fake((body) => body.viewport === 'desktop'
      ? { ...healthy, ...failure, passed: false }
      : { passed: false, lifecycle: { status: 'evidence_timeout', outcome_unknown: true } });
    const result = await runVerification({ project_id: 'fixture' }, normalizeVerifyFlow({ viewports: ['desktop', 'mobile'] }), client);
    assert.match(result.verdict, /^FAIL.*desktop.*INCOMPLETE — Outcome unknown.*mobile/);
  }
});


test('browser output distinguishes a known unstarted cap and preserves genuine failures', () => {
  const capped = { passed: false, steps: [{ step: 0, ran: false }], incomplete: { reason: 'execution_cap', completed: 0, next_step: 0, budget_ms: 180000, elapsed_ms: 180000 } };
  assert.match(formatBrowserReport(capped)[0], /INCOMPLETE/);
  assert.equal(browserExitCode(capped), 1);
  assert.match(formatBrowserReport({ ...capped, steps: [{ step: 0, ok: false, error: 'assertion failed' }] })[0], /FAIL/);
});
