// Browser timeout repair: one connected run per segment with a caller-chosen
// execution cap, an INCOMPLETE verdict distinct from FAIL, the affected actor's
// browser kept (not erased by cleanup), and strict reuse for continued actors.
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  VERIFY_JOURNEY_LIMITS,
  createVerifyJourneyRun,
  formatVerifyJourneyReport,
  formatVerifyReport,
  normalizeVerifyJourney,
  normalizeVerifyFlow,
  runVerification,
} = await import('../dist/commands/verify.js');
const { CliApiError } = await import('../dist/lib/client.js');

function report(overrides = {}) {
  return {
    passed: true,
    final_url: 'https://club.somewhere.site/club',
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    request_expectations: [],
    steps: [{ step: 0, action: 'click', ok: true }],
    screenshots: [{ label: 'page', fs_path: '/_browser_tests/r/page.jpg', url: 'https://api.test/s/page.jpg' }],
    session_expires_at: '2026-09-27T12:03:00.000Z',
    ...overrides,
  };
}

/** A capped run: the listed steps ran, the rest were never started. */
function capped(sent, ranCount, overrides = {}) {
  return report({
    passed: false,
    steps: sent.map((action, i) => (i < ranCount
      ? { step: i, action: Object.keys(action)[0], ok: true }
      : { step: i, action: Object.keys(action)[0], ran: false })),
    incomplete: { reason: 'execution_cap', completed: ranCount, next_step: ranCount, budget_ms: sent.budget ?? 180_000, elapsed_ms: 141_200 },
    // What the platform reads from the persisted record when it releases a kept
    // browser: idle = release + 3 min, absolute = opened + 10 min, the earlier.
    session_expires_at: '2026-09-27T12:04:10.000Z',
    idle_expires_at: '2026-09-27T12:05:30.000Z',
    absolute_expires_at: '2026-09-27T12:04:10.000Z',
    ...overrides,
  });
}

function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    runs: () => calls.filter((call) => call.body.project_id),
    closes: () => calls.filter((call) => !call.body.project_id).map((call) => call.body.session_id),
    async call(method, path, body, _query, opts) {
      calls.push({ body: structuredClone(body), opts });
      if (!body.project_id) return { session_id: body.session_id, closed: true };
      return answer(body, calls.filter((call) => call.body.project_id).length);
    },
  };
}

const club = {
  actors: { alice: { cookies: [{ name: 'pref', value: 'x' }] }, bob: { auth: { user_id: 'usr_bob' } } },
  journey: [
    { as: 'alice', path: '/signup', actions: [{ click: '#create' }] },
    { as: 'bob', path: '/club', actions: [{ click: '#vote-1' }] },
    { as: 'alice', path: '/club', actions: [{ click: '#a' }, { click: '#b' }, { click: '#c' }] },
    { as: 'bob', actions: [{ click: '#close' }] },
  ],
};

test('continued actors must be the same browser and page; first calls may launch; budgets are sent', async () => {
  const client = fakeClient(() => report());
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(club), client, { runId: 's1' }).run();
  assert.equal(result.passed, true, result.verdict);
  const bodies = client.runs().map((call) => call.body);
  assert.deepEqual(bodies.map((body) => body.require_existing_session), [undefined, undefined, true, true]);
  assert.ok(bodies.every((body) => body.budget_ms === 180_000));
  assert.ok(client.runs().every((call) => call.opts.timeoutMs === 225_000));
  for (const body of bodies.filter((b) => b.require_existing_session)) {
    for (const seed of ['auth', 'cookies', 'local_storage', 'headers']) assert.equal(seed in body, false, 'strict reuse never carries a seed');
  }
  assert.deepEqual(result.kept_sessions, []);
});

test('an execution-cap stop is INCOMPLETE: mapped to the caller\'s actions, later segments not run, the actor kept open', async () => {
  const journey = normalizeVerifyJourney(club);
  const client = fakeClient((body, n) => (n === 3 ? capped(body.actions, 2) : report()));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, journey, client, { runId: 's2', now: () => Date.parse('2026-09-27T12:00:00Z') }).run();
  assert.equal(result.passed, false, 'incomplete is never a pass');
  assert.match(result.verdict, /^INCOMPLETE — segment 3 \(alice, desktop\) reached its 180s execution cap after 1 action; step 2 \(click #b\) and every later action did not run and have no verdict\. Nothing failed before the cap\./);
  assert.match(result.verdict, /Segment 4 did not run\./);
  assert.match(result.verdict, /kept open as session "vf-s2-alice"/);
  assert.match(result.verdict, /somewhere call browser '\{"session_id":"vf-s2-alice"\}'/);
  assert.match(result.verdict, /Nothing was continued automatically/);
  assert.match(result.verdict, /\[VERIFY_EXECUTION_CAP\]$/);
  assert.doesNotMatch(result.verdict, /^FAIL/);
  const segment = result.segments[2];
  assert.deepEqual(segment.incomplete, {
    reason: 'execution_cap', completed: 1, next_step: 2, next_action: 'click #b', not_run: 2, budget_ms: 180_000, elapsed_ms: 141_200,
  }, 'the inserted goto is excluded from counts and numbering');
  assert.equal(segment.ran, true);
  assert.deepEqual(result.segments.map((s) => s.ran), [true, true, true, false]);
  assert.equal(client.runs().length, 3, 'no automatic continuation');

  assert.deepEqual(client.closes(), ['vf-s2-bob'], 'cleanup closes the other actors and never the kept one');
  assert.deepEqual(result.cleanup.map((item) => [item.actor, item.status]), [['bob', 'closed'], ['alice', 'kept_open']]);
  assert.equal(result.cleanup_confirmed, true);
  assert.deepEqual(result.kept_sessions, [{
    actor: 'alice', session_id: 'vf-s2-alice',
    session_expires_at: '2026-09-27T12:04:10.000Z', idle_expires_at: '2026-09-27T12:05:30.000Z', absolute_expires_at: '2026-09-27T12:04:10.000Z',
    close: `somewhere call browser '{"session_id":"vf-s2-alice"}'`,
  }], 'the kept session carries only the times the platform reported at release');
  assert.match(result.verdict, /the platform closes it at 2026-09-27T12:04:10\.000Z unless it is closed first/);
  assert.doesNotMatch(result.verdict, /idles out about|12:03:00/, 'no CLI-estimated expiry');
  const notRun = result.steps.filter((step) => step.ran === false);
  assert.deepEqual(notRun.map((step) => step.name), ['click #b', 'click #c'], 'unrun actions are listed, not failed');
  assert.ok(notRun.every((step) => step.passed === false && !step.error));
  const printed = formatVerifyJourneyReport(result).join('\n');
  assert.match(printed, /segment 3 .*incomplete/);
  assert.match(printed, /step \d+ .*not run.* click #b/);
  assert.match(printed, /alice: kept open after the execution cap; close it with: somewhere call browser/);
});

test('a capped actor the platform closed is not reported as kept', async () => {
  const client = fakeClient((body, n) => (n === 3 ? capped(body.actions, 2, { session_expires_at: undefined, idle_expires_at: undefined, absolute_expires_at: undefined, session_closed: true }) : report()));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(club), client, { runId: 's5' }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^INCOMPLETE — /);
  assert.match(result.verdict, /The platform closed alice's browser, so there is no page left to inspect/);
  assert.deepEqual(result.kept_sessions, []);
  assert.doesNotMatch(result.verdict, /kept open/);
});

test('a capped actor with no persisted expiry is not claimed kept', async () => {
  const client = fakeClient((body, n) => (n === 3 ? capped(body.actions, 2, { session_expires_at: undefined, idle_expires_at: undefined, absolute_expires_at: undefined }) : report()));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(club), client, { runId: 's6', now: () => Date.parse('2026-09-27T12:00:00Z') }).run();
  assert.match(result.verdict, /No kept browser is confirmed/);
  assert.deepEqual(result.kept_sessions, []);
  assert.ok(client.closes().includes("vf-s6-alice"));
});

test('a cap before the inserted goto names the goto, not a caller action', async () => {
  const client = fakeClient((body, n) => (n === 3 ? capped(body.actions, 0) : report()));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(club), client, { runId: 's3' }).run();
  assert.deepEqual(result.segments[2].incomplete && [result.segments[2].incomplete.completed, result.segments[2].incomplete.next_step, result.segments[2].incomplete.not_run], [0, 0, 3]);
  assert.match(result.verdict, /the goto for its path \(goto \/club\) and every later action did not run/);
});

test('an incomplete run never hides an earlier genuine failure; that actor closes as on any failure', async () => {
  for (const [label, failure] of [
    ['a failed step before the cap', (sent) => ({ steps: [{ step: 0, action: 'goto', ok: true }, { step: 1, action: 'click', ok: false, error: 'no #a' }, ...sent.slice(2).map((_, i) => ({ step: i + 2, action: 'click', ran: false }))] })],
    ['a page error before the cap', () => ({ page_errors: ['TypeError: x is undefined'] })],
    ['an unexpected failed request before the cap', () => ({ failed_requests: [{ url: 'https://club.somewhere.site/api/save', status: 500, method: 'POST' }] })],
  ]) {
    const client = fakeClient((body, n) => (n === 3 ? capped(body.actions, 2, failure(body.actions)) : report()));
    const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(club), client, { runId: 'f' }).run();
    assert.match(result.verdict, /^FAIL/, label);
    assert.equal(result.segments[2].incomplete, undefined, label);
    assert.deepEqual(client.closes().sort(), ['vf-f-alice', 'vf-f-bob'], `${label}: every actor is closed`);
    assert.deepEqual(result.kept_sessions, [], label);
  }
});

test('a malformed incomplete block is not trusted as a clean boundary', async () => {
  const client = fakeClient((body, n) => (n === 3
    ? capped(body.actions, 2, { incomplete: { reason: 'execution_cap', completed: 2, next_step: 9, budget_ms: 180_000, elapsed_ms: 1 } })
    : report()));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(club), client, { runId: 'm' }).run();
  assert.match(result.verdict, /^FAIL/);
  assert.deepEqual(result.kept_sessions, []);
  assert.equal(client.closes().length, 2);
});

test('a continued actor whose browser or page is gone is refused before anything runs, and says so', async () => {
  for (const code of ['SESSION_EXPIRED', 'SESSION_TARGET_LOST']) {
    const client = fakeClient((_body, n) => {
      if (n === 3) throw new CliApiError(code, 'Browser session "vf-g-alice" is no longer live.', 409);
      return report();
    });
    const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(club), client, { runId: 'g' }).run();
    assert.match(result.verdict, new RegExp(`^FAIL — segment 3 \\(alice, desktop\\): alice's .* between segments, so segment 3 did not run \\(nothing was started, seeded or navigated\\)\\..*\\[${code}\\]$`));
    assert.equal(client.runs().length, 3, 'no replay and no fresh start');
    assert.equal(client.closes().length, 2, 'normal cleanup still closes both actors');
  }
});

test('single-user verify asks for the cap, and a capped viewport is INCOMPLETE, not FAIL', async () => {
  const flow = normalizeVerifyFlow({
    actions: [{ click: '#a' }, { click: '#b' }, { click: '#c' }],
    expect_requests: [{ path: '/api/c', status: 200 }],
    viewports: ['desktop', 'mobile'],
  });
  const client = fakeClient((body) => (body.viewport === 'mobile'
    ? capped(body.actions, 1, { request_expectations: [{ path: '/api/c', status: 200, ok: false, observed: [] }], screenshots: [] })
    : report({ steps: body.actions.map((a, i) => ({ step: i, action: 'click', ok: true })), request_expectations: [{ path: '/api/c', status: 200, ok: true, observed: [200] }] })));
  const result = await runVerification({ project_id: 'club' }, flow, client);
  assert.ok(client.runs().every((call) => call.body.budget_ms === 180_000 && call.opts.timeoutMs === 225_000));
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^INCOMPLETE — the run at mobile reached its 180s execution cap after 1 action; step 2 \(click #b\) and every later action did not run and have no verdict\./);
  assert.equal(result.incomplete.length, 1);
  assert.equal(result.incomplete[0].viewport, 'mobile');
  assert.deepEqual(result.steps.filter((s) => s.ran === false).map((s) => `${s.viewport} ${s.step}`), ['mobile 2', 'mobile 3']);
  assert.match(formatVerifyReport(result).join('\n'), /step 2 .*not run.*\[mobile\] click #b/);
});

test('a single-user capped run with an earlier failed step stays FAIL', async () => {
  const flow = normalizeVerifyFlow({ actions: [{ click: '#a' }, { click: '#b' }], viewports: ['desktop'] });
  const client = fakeClient((body) => capped(body.actions, 1, { steps: [{ step: 0, action: 'click', ok: false, error: 'no #a' }, { step: 1, action: 'click', ran: false }] }));
  const result = await runVerification({ project_id: 'club' }, flow, client);
  assert.match(result.verdict, /^FAIL — step 1 \(click #a\) failed at desktop: no #a/);
  assert.deepEqual(result.incomplete, []);
});

test('limits describe the cap, the headroom and the transport wait', () => {
  assert.equal(VERIFY_JOURNEY_LIMITS.segment_budget_ms, 180_000);
  assert.equal(VERIFY_JOURNEY_LIMITS.min_segment_budget_ms, 10_000);
  assert.equal(VERIFY_JOURNEY_LIMITS.transport_headroom_ms, 45_000);
  assert.equal(VERIFY_JOURNEY_LIMITS.segment_timeout_ms, 225_000);
  assert.equal(VERIFY_JOURNEY_LIMITS.deadline_ms, 600_000);
});
