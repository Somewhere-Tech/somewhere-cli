// Multi-user verify journeys (tsk_f49ccbb75f994f1fb5179198087d24de): one run,
// several isolated signed-in browsers, bounded existing browser calls, and every
// actor browser closed however the run ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  VERIFY_JOURNEY_LIMITS,
  createVerifyJourneyRun,
  formatVerifyJourneyReport,
  normalizeVerifyFlow,
  normalizeVerifyJourney,
  verifyFlowSchema,
} = await import('../dist/commands/verify.js');
const { normalizeBrowserActions } = await import('../dist/lib/browser-actions.js');
const { CliApiError } = await import('../dist/lib/client.js');

const SECRET_COOKIE = 'cookie-secret-8f2a';
const SECRET_STORAGE = 'storage-secret-19cd';

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
    accessibility_layout: 'layout: no horizontal overflow; 0 small tap targets',
    ...overrides,
  };
}

/** A fake platform: records every call; `answer(body, n)` decides each run. */
function fakeClient(answer = () => report()) {
  const calls = [];
  return {
    calls,
    runs: () => calls.filter((call) => call.body.project_id),
    closes: () => calls.filter((call) => !call.body.project_id),
    async call(method, path, body, _query, opts) {
      assert.equal(method, 'POST');
      assert.equal(path, '/browser/test');
      calls.push({ body: structuredClone(body), opts });
      if (!body.project_id) return { session_id: body.session_id, closed: true };
      return answer(body, calls.filter((call) => call.body.project_id).length);
    },
  };
}

const bookclub = {
  actors: {
    alice: { cookies: [{ name: 'pref', value: SECRET_COOKIE }] },
    bob: { auth: { user_id: 'usr_bob' }, local_storage: { theme: SECRET_STORAGE } },
  },
  journey: [
    { as: 'alice', path: '/signup', actions: [{ fill: '#email', value: 'alice@example.test' }, { click: '#create' }] },
    { as: 'bob', path: '/club', actions: [{ click: '#vote-1' }], expect_requests: [{ path: '/api/vote', status: 200 }] },
    { as: 'alice', path: '/club', viewport: 'mobile', actions: [{ eval: "fetch('/api/state').then(r => r.status)" }] },
    { as: 'bob', actions: [{ click: '#close' }], expect_requests: [{ path: '/api/close', status: 403 }] },
  ],
};

test('a legitimate two-user journey runs in order, each actor in its own continued browser', async () => {
  const journey = normalizeVerifyJourney(bookclub);
  const client = fakeClient();
  const run = createVerifyJourneyRun({ project_id: 'club' }, journey, client, { runId: 'r1' });
  const result = await run.run();
  assert.equal(result.passed, true, result.verdict);
  assert.match(result.verdict, /^PASS — 4 segments by 2 users \(alice, bob\)/);
  assert.equal(result.mode, 'journey');
  assert.equal(result.browser_runs, 4);

  const runs = client.runs().map((call) => call.body);
  assert.deepEqual(runs.map((body) => body.session_id), ['vf-r1-alice', 'vf-r1-bob', 'vf-r1-alice', 'vf-r1-bob']);
  assert.ok(runs.every((body) => body.project_id === 'club'), 'every actor call names the project');
  assert.deepEqual(runs.map((body) => body.url), ['/signup', '/club', undefined, undefined],
    'an actor\'s first segment starts at its path; a continued actor is not re-navigated by url');
  assert.deepEqual(runs[2].actions[0], { goto: '/club' }, 'a continued actor moves with a leading goto');
  assert.equal(runs[3].actions.length, 1, 'no goto without a path');
  assert.deepEqual(runs.map((body) => body.viewport), ['desktop', 'desktop', 'mobile', 'desktop']);
  assert.ok(runs.every((body) => body.capture_after === true && body.inline === false));
  assert.deepEqual(runs[3].expect_requests, [{ path: '/api/close', status: 403 }]);

  // Cleanup on success: exactly the two opened browsers are closed.
  assert.deepEqual(client.closes().map((call) => call.body), [{ session_id: 'vf-r1-alice' }, { session_id: 'vf-r1-bob' }]);
  assert.deepEqual(result.cleanup, [{ actor: 'alice', status: 'closed' }, { actor: 'bob', status: 'closed' }]);
  assert.equal(result.cleanup_confirmed, true);
  assert.equal(result.limits.cleanup_budget_ms, 20_000, 'the cleanup budget is reported separately from the journey budget');
  assert.ok(result.cleanup_ms >= 0);
  assert.equal(result.layout.length, 4, 'the overflow/tap-target line is reported for every segment');
  assert.match(result.layout[2].viewport, /alice #3 mobile/);
});

test('identity isolation: seeds reach only their own actor, only on its first call, and never the report', async () => {
  const client = fakeClient();
  const run = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r2' });
  const result = await run.run();
  const [alice1, bob1, alice2, bob2] = client.runs().map((call) => call.body);
  assert.deepEqual(alice1.cookies, [{ name: 'pref', value: SECRET_COOKIE }]);
  assert.equal('auth' in alice1 || 'local_storage' in alice1, false, 'alice never receives bob\'s identity');
  assert.deepEqual(bob1.auth, { user_id: 'usr_bob' });
  assert.deepEqual(bob1.local_storage, { theme: SECRET_STORAGE });
  assert.equal('cookies' in bob1, false, 'bob never receives alice\'s cookie');
  for (const body of [alice2, bob2]) {
    for (const field of ['auth', 'local_storage', 'cookies', 'headers']) {
      assert.equal(field in body, false, `a continued actor is not re-seeded (${field})`);
    }
  }
  assert.notEqual(alice1.session_id, bob1.session_id, 'separate browsers');
  const printed = JSON.stringify(result) + formatVerifyJourneyReport(result).join('\n');
  assert.ok(!printed.includes(SECRET_COOKIE) && !printed.includes(SECRET_STORAGE), 'seed values never appear in output');

  // A second run never resumes the first run's browsers.
  const again = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), fakeClient());
  assert.notEqual(again.sessions.alice, run.sessions.alice);
  assert.match(again.sessions.alice, /^vf-[0-9a-f]{8}-alice$/);
});

test('a failing segment stops the journey truthfully, and every opened browser is still closed', async () => {
  const client = fakeClient((_body, n) => n === 2
    ? report({ passed: false, steps: [{ step: 0, action: 'click', ok: false, error: 'selector #vote-1 did not match' }] })
    : report());
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r3' }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^FAIL — segment 2 — step 1 \(click #vote-1\) failed at bob #2 desktop: selector #vote-1 did not match/);
  assert.equal(client.runs().length, 2, 'later segments do not run after a failure');
  assert.deepEqual(result.segments.map((s) => [s.segment, s.ran, s.passed]), [[1, true, true], [2, true, false], [3, false, false], [4, false, false]]);
  assert.deepEqual(client.closes().map((call) => call.body.session_id), ['vf-r3-alice', 'vf-r3-bob']);
  assert.match(formatVerifyJourneyReport(result).join('\n'), /segment 3 .*not run/);
});

test('an intended 403 passes only when it is actually seen', async () => {
  const seen = fakeClient((body) => report({
    request_expectations: body.expect_requests.map((item) => ({ ...item, ok: true })),
  }));
  assert.equal((await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), seen).run()).passed, true);
  const missing = fakeClient((body) => report({
    request_expectations: body.expect_requests.map((item) => ({ ...item, ok: item.status !== 403, ...(item.status === 403 ? { error: 'Expected /api/close to return 403; saw 200.' } : {}) })),
  }));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), missing).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /segment 4 — expected request \/api\/close:403 was not observed at bob #4 desktop/);
});

test('a continued actor whose browser was replaced fails as a different person; a first call note does not', async () => {
  const client = fakeClient((_body, n) => report(n === 1 || n === 3 ? { session_note: 'session expired, started fresh' } : {}));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r4' }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^FAIL — segment 3 \(alice, mobile\): alice's browser ended between segments/);
  assert.match(result.verdict, /\[VERIFY_ACTOR_SESSION_ENDED\]$/);
  assert.equal(client.runs().length, 3);
  assert.equal(client.closes().length, 2);
});

test('platform refusals stop the run with their code and still clean up', async () => {
  for (const [code, message] of [
    ['BROWSER_ORIGIN_NOT_AUTHORIZED', 'Driving this page only works on an address one of your own projects serves.'],
    ['BROWSER_SESSION_LIMIT', 'You already have 3 live browser sessions (a, b, c). Close one.'],
    ['CLAIM_ACCOUNT_REQUIRED', 'Persistent browser sessions require a claimed account.'],
  ]) {
    const client = fakeClient((_body, n) => { if (n === 2) throw new CliApiError(code, message, 403); return report(); });
    const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r5' }).run();
    assert.equal(result.passed, false, code);
    assert.ok(result.verdict.startsWith(`FAIL — segment 2 (bob, desktop): ${message}`), result.verdict);
    assert.ok(result.verdict.endsWith(`[${code}]`));
    assert.equal(result.segments[1].ran, false, 'a refusal is not counted as a browser run');
    assert.equal(result.browser_runs, 1);
    assert.deepEqual(client.closes().map((call) => call.body.session_id), ['vf-r5-alice', 'vf-r5-bob']);
  }
});

test('a transport failure still closes the browsers; a close failure is reported, not hidden', async () => {
  const client = fakeClient((_body, n) => { if (n === 2) throw new Error('socket hang up'); return report(); });
  client.call = ((original) => async (method, path, body, query, opts) => {
    if (!body.project_id && body.session_id.endsWith('bob')) {
      client.calls.push({ body: structuredClone(body), opts });
      throw new CliApiError('AUTHORITY_UNAVAILABLE', 'try again', 503);
    }
    return original(method, path, body, query, opts);
  })(client.call.bind(client));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r6' }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /socket hang up \[VERIFY_SEGMENT_FAILED\][\s\S]*INCOMPLETE/);
  assert.deepEqual(result.cleanup[0], { actor: 'alice', status: 'closed' });
  assert.equal(result.cleanup[1].status, 'unconfirmed');
  assert.match(result.cleanup[1].reason, /close failed \(AUTHORITY_UNAVAILABLE\); the platform closes an idle browser within 3 minutes/);
  assert.equal(result.cleanup_confirmed, false, 'an unconfirmed close is never reported as clean');
  assert.match(formatVerifyJourneyReport(result).join('\n'), /bob unconfirmed[\s\S]*bob: close failed \(AUTHORITY_UNAVAILABLE\)/);
});

test('the journey deadline stops before the next segment and cleans up', async () => {
  let clock = 0;
  const client = fakeClient((_body, n) => { if (n === 2) clock += VERIFY_JOURNEY_LIMITS.deadline_ms + 1; return report(); });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r7', now: () => clock }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^FAIL — segment 3 \(alice, mobile\): The journey reached its 10-minute limit\. \[VERIFY_JOURNEY_DEADLINE\]$/);
  assert.equal(client.runs().length, 2);
  assert.equal(client.closes().length, 2);
});

test('closeAll is idempotent and only closes browsers the run opened', async () => {
  const client = fakeClient();
  const run = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r8' });
  assert.deepEqual((await run.closeAll()).cleanup, [], 'nothing opened, nothing closed');
  assert.equal(client.calls.length, 0);
  await assert.doesNotReject(run.run(), 'a closed run still returns a report');
  assert.equal(client.runs().length, 0, 'once cleanup has started, no segment starts');
  const client2 = fakeClient((_body, n) => { if (n === 1) throw new CliApiError('BROWSER_SESSION_LIMIT', 'limit', 429); return report(); });
  const run2 = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client2, { runId: 'r9' });
  await run2.run();
  await run2.closeAll();
  assert.deepEqual(client2.closes().map((call) => call.body.session_id), ['vf-r9-alice'], 'bob never started, so only alice is closed, once');
});

test('multi-user runs need the project and a deployed app, refused before any browser', async () => {
  const client = fakeClient();
  await assert.rejects(createVerifyJourneyRun({ url: 'https://club.somewhere.site/' }, normalizeVerifyJourney(bookclub), client).run(), /needs --project/);
  await assert.rejects(createVerifyJourneyRun({ project_id: 'club', url: 'http://127.0.0.1:5173/' }, normalizeVerifyJourney(bookclub), client).run(), /deployed app/);
  assert.equal(client.calls.length, 0);
});

test('limits and shape are enforced before any browser starts, naming the limit and the fix', () => {
  const four = { actors: { a: {}, b: {}, c: {}, d: {} }, journey: [{ as: 'a' }, { as: 'b' }, { as: 'c' }, { as: 'd' }] };
  assert.throws(() => normalizeVerifyJourney(four), /1 to 3 actors/);
  const many = { actors: { a: {} }, journey: Array.from({ length: 13 }, () => ({ as: 'a' })) };
  assert.throws(() => normalizeVerifyJourney(many), /13 segments; the limit is 12/);
  const thirty = Array.from({ length: 30 }, () => ({ click: '#x' }));
  assert.doesNotThrow(() => normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a', path: '/', actions: thirty }] }),
    'an actor\'s first path is the start url, not an extra action');
  assert.throws(() => normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a' }, { as: 'a', path: '/x', actions: thirty }] }),
    /31 actions \(including the goto for its path\); the limit per segment is 30/);
  const total = { actors: { a: {} }, journey: Array.from({ length: 5 }, () => ({ as: 'a', actions: thirty })) };
  assert.throws(() => normalizeVerifyJourney(total), /150 actions in total; the limit is 120/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'b' }] }), /must name one of the actors \(a\)/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: {}, b: {} }, journey: [{ as: 'a' }] }), /b is declared but never used/);
  assert.throws(() => normalizeVerifyJourney({ actors: { Alice: {} }, journey: [{ as: 'Alice' }] }), /actor name "Alice"/);
  for (const bad of ['//evil.test/x', 'https://evil.test/', 'club', '/a b']) {
    assert.throws(() => normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a', path: bad }] }), /path must be a path on this app/);
  }
  assert.throws(() => normalizeVerifyJourney({ ...bookclub, viewports: ['mobile'] }), /only "actors" and "journey" \(found viewports\)/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: { password: 'x' } }, journey: [{ as: 'a' }] }), /actors\.a has unsupported field: password/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: { local_storage: { k: 'x'.repeat(9000) } } }, journey: [{ as: 'a' }] }), /8 KB/);
  assert.throws(() => normalizeVerifyFlow(bookclub), /multi-user flow \(actors \+ journey\)\. Run it with `somewhere verify/,
    'deploy --verify and single-user loaders name the right command');
});

test('goto is one shared, path-only action', () => {
  assert.deepEqual(normalizeBrowserActions([{ goto: '/club' }]), { ok: true, actions: [{ goto: '/club' }] });
  for (const bad of ['//evil.test', 'https://evil.test', 'club', '/a\\b', 7]) {
    const out = normalizeBrowserActions([{ goto: bad }]);
    assert.equal(out.ok, false);
    assert.match(out.error, /goto must be a path on this app/);
  }
});

function cli(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sw-journey-home-'));
  const result = spawnSync(process.execPath, [join(process.cwd(), 'dist/index.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', ...env },
  });
  rmSync(home, { recursive: true, force: true });
  return result;
}

test('--schema prints the machine-readable flow contract; --help carries a valid multi-user example', () => {
  const schema = cli(['verify', '--schema']);
  assert.equal(schema.status, 0, schema.stderr);
  const parsed = JSON.parse(schema.stdout);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(verifyFlowSchema())));
  assert.equal(parsed.oneOf.length, 2);
  assert.deepEqual(parsed['x-limits'], { ...VERIFY_JOURNEY_LIMITS });
  assert.ok(parsed.oneOf[1].properties.journey.items.properties.actions.items.oneOf.some((item) => item.required[0] === 'goto'));

  const help = cli(['verify', '--help']);
  assert.equal(help.status, 0, help.stderr);
  const match = help.stdout.match(/Several users in one run[^\n]*\n([\s\S]*?)\nSegments run in order/);
  assert.ok(match, help.stdout);
  const example = JSON.parse(match[1].replace(/^  /gm, ''));
  assert.equal(normalizeVerifyJourney(example).journey.length, 3);
  assert.match(help.stdout, /3 actors, 12 segments,\s+30 actions per segment, 120 in total, 10 minutes/);
});

test('Ctrl-C during a journey closes every opened actor browser before exiting', async () => {
  const seen = [];
  let heldBob = null;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      res.setHeader('Content-Type', 'application/json');
      if (!body.project_id) {
        res.end(JSON.stringify({ ok: true, data: { session_id: body.session_id, closed: true } }));
        // Closing bob's browser ends his run, as on the platform: his call answers.
        if (body.session_id.endsWith('-bob') && heldBob) { const answer = heldBob; heldBob = null; setTimeout(answer, 20); }
        return;
      }
      if (seen.filter((b) => b.project_id).length === 1) { res.end(JSON.stringify({ ok: true, data: report() })); return; }
      // The second actor's segment is running when the operator presses Ctrl-C.
      heldBob = () => { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'BROWSER_TEST_FAILED', message: 'the browser was closed' })); };
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), 'sw-journey-sigint-'));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_fixture' }));
  const flowPath = join(dir, 'flow.json');
  writeFileSync(flowPath, JSON.stringify(bookclub));
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/index.js'), 'verify', '--project', 'club', '--flow', flowPath, '--json'], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let i = 0; i < 100 && seen.filter((b) => b.project_id).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.filter((b) => b.project_id).length, 2, `the second segment started (${stderr})`);
  child.kill('SIGINT');
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  server.closeAllConnections?.();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 130);
  const closes = seen.filter((b) => !b.project_id).map((b) => b.session_id).sort();
  assert.equal(closes.length, 3, 'both opened browsers were closed, bob again after his call ended');
  assert.ok(closes[0].endsWith('-alice') && closes[1].endsWith('-bob') && closes[2].endsWith('-bob'));
  assert.equal(seen.filter((b) => b.project_id).length, 2, 'no segment started after Ctrl-C');
  assert.match(stderr, /alice closed, bob (?:already )?closed/);
});

// ── Lifecycle: stop state, in-flight work, bounded concurrent cleanup ─────────

/** A fake platform whose segment answers and close delays the test controls. */
function controllableClient({ closeDelayMs = 0, closeFails = () => false, segment = () => report() } = {}) {
  const events = [];
  const held = [];
  const client = {
    events,
    held,
    runs: () => events.filter((e) => e.type === 'segment'),
    closes: (actor) => events.filter((e) => e.type === 'close-start' && (!actor || e.session.endsWith(`-${actor}`))),
    async call(_method, _path, body, _query, opts) {
      if (!body.project_id) {
        events.push({ type: 'close-start', session: body.session_id, at: Date.now() });
        await new Promise((r) => setTimeout(r, closeDelayMs));
        events.push({ type: 'close-end', session: body.session_id, at: Date.now() });
        if (closeFails(body.session_id)) throw new CliApiError('AUTHORITY_UNAVAILABLE', 'try again', 503);
        return { session_id: body.session_id, closed: true };
      }
      const n = client.runs().length + 1;
      events.push({ type: 'segment', session: body.session_id, n, timeoutMs: opts?.timeoutMs, at: Date.now() });
      return segment(body, n, opts, held);
    },
  };
  return client;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(predicate, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('stop is synchronous: a segment that settles during cleanup starts nothing else, and its actor is closed again after it settles', async () => {
  const bobCall = deferred();
  const client = controllableClient({
    closeDelayMs: 20,
    segment: (_body, n) => (n === 2 ? bobCall.promise : report()),
  });
  const journeyRun = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l1' });
  const running = journeyRun.run();
  await until(() => client.runs().length === 2);
  journeyRun.stop('VERIFY_INTERRUPTED', 'Stopped by SIGTERM.');
  const cleaning = journeyRun.closeAll();
  await until(() => client.closes().length === 2);
  bobCall.resolve(report());
  const bobSettledAt = Date.now();
  const { cleanup } = await cleaning;
  const result = await running;
  assert.equal(client.runs().length, 2, 'the segment that settled during cleanup did not start segment 3');
  assert.deepEqual(client.closes('alice').length, 1);
  const bobCloses = client.closes('bob');
  assert.equal(bobCloses.length, 2, 'bob is closed once at stop and once after his call settled');
  assert.ok(bobCloses[1].at >= bobSettledAt, 'the second close follows the settlement');
  assert.deepEqual(cleanup, [{ actor: 'alice', status: 'closed' }, { actor: 'bob', status: 'closed' }]);
  assert.equal(result.passed, false);
  assert.equal(result.segments[1].ran, true, 'the in-flight segment is reported as run');
  assert.deepEqual(result.segments[2].error, { code: 'VERIFY_INTERRUPTED', message: 'Stopped by SIGTERM.' });
  assert.match(result.verdict, /^FAIL — segment 3 \(alice, mobile\): Stopped by SIGTERM\. \[VERIFY_INTERRUPTED\]$/);
});

test('cleanup closes every opened browser concurrently under one budget', async () => {
  const client = controllableClient({ closeDelayMs: 150 });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l2' }).run();
  const starts = client.events.filter((e) => e.type === 'close-start');
  const firstEnd = client.events.find((e) => e.type === 'close-end');
  assert.equal(starts.length, 2);
  assert.ok(starts.every((e) => e.at <= firstEnd.at), 'both closes were in flight together, not one after another');
  assert.ok(result.cleanup_ms < 280, `two 150 ms closes took ${result.cleanup_ms} ms`);
});

test('a call still running when the cleanup budget runs out is reported unconfirmed, and cleanup stays inside its budget', async () => {
  const client = controllableClient({ segment: (_body, n) => (n === 2 ? new Promise(() => {}) : report()) });
  const journeyRun = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l3', cleanupBudgetMs: 300 });
  void journeyRun.run();
  await until(() => client.runs().length === 2);
  journeyRun.stop('VERIFY_INTERRUPTED', 'Stopped by SIGTERM.');
  const startedAt = Date.now();
  const { cleanup, cleanup_ms } = await journeyRun.closeAll();
  assert.ok(Date.now() - startedAt < 600, 'cleanup returned within its budget');
  assert.ok(cleanup_ms <= 400);
  assert.deepEqual(cleanup[0], { actor: 'alice', status: 'closed' });
  assert.equal(cleanup[1].status, 'unconfirmed');
  assert.match(cleanup[1].reason, /still running when cleanup ran out of time; the platform closes an idle browser within 3 minutes/);
  assert.equal(client.runs().length, 2);
});

test('each segment asks for an execution cap that fits the remaining journey; a budget-cut wait stops as the deadline and stays unconfirmed', async () => {
  let clock = 0;
  const client = controllableClient({
    segment: (body, n, opts) => {
      if (n === 1) {
        assert.equal(body.budget_ms, 180_000, 'a segment asks for the 180 s execution cap');
        clock = VERIFY_JOURNEY_LIMITS.deadline_ms - 60_000;
        return report();
      }
      assert.equal(body.budget_ms, 15_000, 'the cap shrinks so cap + transport headroom ends at the journey deadline');
      assert.equal(opts.timeoutMs, 60_000, 'the wait is the cap plus 45 s of headroom');
      throw new CliApiError('TIMEOUT', 'No response from POST /browser/test after 60s.', 0);
    },
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, {
    runId: 'l4', now: () => clock, recloseAfterAbandonedMs: 10,
  }).run();
  assert.equal(client.runs()[0].timeoutMs, VERIFY_JOURNEY_LIMITS.segment_timeout_ms);
  assert.equal(VERIFY_JOURNEY_LIMITS.segment_timeout_ms, 225_000, 'a full segment waits 180 s + 45 s');
  assert.match(result.verdict, /^INCOMPLETE — Outcome unknown/);
  assert.equal(result.segments[1].error.code, 'TIMEOUT');
  assert.equal(result.segments[1].outcome_unknown, true);
  assert.equal(client.runs().length, 2);
  assert.equal(client.closes('bob').length, 2, 'the abandoned actor is closed again later, inside the cleanup budget');
  assert.equal(result.cleanup[1].status, 'unconfirmed');
  assert.match(result.cleanup[1].reason, /got no answer, so the platform may still start it/);
  assert.equal(result.cleanup_confirmed, false);
});

test('a segment that cannot get the minimum cap plus headroom is not started', async () => {
  let clock = 0;
  const client = controllableClient({
    segment: (_body, n) => {
      if (n === 1) clock = VERIFY_JOURNEY_LIMITS.deadline_ms - 54_999;
      return report();
    },
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l4b', now: () => clock }).run();
  assert.equal(client.runs().length, 1, 'no call is started that could not answer before the deadline');
  assert.match(result.verdict, /^FAIL — segment 2 \(bob, desktop\): The journey reached its 10-minute limit\. Segment 2 was not started: 54s were left, less than the 10s minimum run plus 45s for its answer\. \[VERIFY_JOURNEY_DEADLINE\]$/);
  assert.deepEqual(result.cleanup.map((item) => item.status), ['closed']);
});

test('a client timeout inside the journey budget keeps its code, and that actor is never reported closed', async () => {
  const client = controllableClient({
    segment: (_body, n) => { if (n === 2) throw new CliApiError('TIMEOUT', 'No response from POST /browser/test after 90s.', 0); return report(); },
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l5', recloseAfterAbandonedMs: 10 }).run();
  assert.match(result.verdict, /^INCOMPLETE — Outcome unknown/);
  assert.equal(result.segments[1].error.code, 'TIMEOUT');
  assert.match(result.segments[1].error.message, /after 90s/);
  assert.deepEqual(result.cleanup.map((item) => item.status), ['closed', 'unconfirmed']);
});

/** Run the real CLI against a local fake platform; the handler decides answers. */
async function cliAgainst(handler) {
  const events = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const reply = (status, payload) => {
        events.push({ type: body.project_id ? 'segment-end' : 'close-end', session: body.session_id, at: Date.now() });
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      events.push({ type: body.project_id ? 'segment' : 'close', session: body.session_id, at: Date.now() });
      handler(body, reply, events);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), 'sw-journey-term-'));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_fixture' }));
  const flowPath = join(dir, 'flow.json');
  writeFileSync(flowPath, JSON.stringify(bookclub));
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/index.js'), 'verify', '--project', 'club', '--flow', flowPath, '--json'], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const done = async () => {
    const code = await exited;
    server.closeAllConnections?.();
    server.close();
    rmSync(dir, { recursive: true, force: true });
    return { code, stderr };
  };
  return { child, events, done };
}

test('SIGTERM mid-journey: no new segment starts, the in-flight actor is closed again after its call settles, exit 143', async () => {
  const run = await cliAgainst((body, reply, events) => {
    if (!body.project_id) {
      reply(200, { ok: true, data: { session_id: body.session_id, closed: true } });
      // Bob's held call settles only after cleanup has started.
      if (body.session_id.endsWith('-bob') && events.release) { const release = events.release; events.release = null; setTimeout(release, 150); }
      return;
    }
    const n = events.filter((e) => e.type === 'segment').length;
    if (n === 1) { reply(200, { ok: true, data: report() }); return; }
    events.release = () => reply(200, { ok: true, data: report() });
  });
  await until(() => run.events.filter((e) => e.type === 'segment').length === 2, 5000);
  run.child.kill('SIGTERM');
  const { code, stderr } = await run.done();
  assert.equal(code, 143, stderr);
  const segments = run.events.filter((e) => e.type === 'segment');
  assert.equal(segments.length, 2, 'the segment that settled during cleanup did not start another');
  const bobSettled = run.events.find((e) => e.type === 'segment-end' && e.session.endsWith('-bob'));
  const bobCloses = run.events.filter((e) => e.type === 'close' && e.session.endsWith('-bob'));
  assert.ok(bobSettled, 'bob\'s call settled during cleanup');
  assert.equal(bobCloses.length, 2);
  assert.ok(bobCloses[1].at >= bobSettled.at, 'bob was closed again after his call settled');
  assert.equal(run.events.filter((e) => e.type === 'close' && e.session.endsWith('-alice')).length, 1);
  assert.match(stderr, /browsers \(cleanup [\d.]+s of 20s budget\): alice closed, bob closed/);
});

test('SIGTERM with a failed close reports that browser as unconfirmed and still exits 143', async () => {
  const run = await cliAgainst((body, reply, events) => {
    if (!body.project_id) {
      if (body.session_id.endsWith('-bob')) {
        reply(503, { ok: false, error: 'AUTHORITY_UNAVAILABLE', message: 'try again' });
        if (events.release) { const release = events.release; events.release = null; setTimeout(release, 50); }
      } else {
        reply(200, { ok: true, data: { session_id: body.session_id, closed: true } });
      }
      return;
    }
    const n = events.filter((e) => e.type === 'segment').length;
    if (n === 1) { reply(200, { ok: true, data: report() }); return; }
    events.release = () => reply(200, { ok: true, data: report() });
  });
  await until(() => run.events.filter((e) => e.type === 'segment').length === 2, 5000);
  run.child.kill('SIGTERM');
  const { code, stderr } = await run.done();
  assert.equal(code, 143, stderr);
  assert.match(stderr, /alice closed, bob unconfirmed/);
  assert.match(stderr, /bob: close after its call finished failed \(AUTHORITY_UNAVAILABLE\); the platform closes an idle browser within 3 minutes/);
});
