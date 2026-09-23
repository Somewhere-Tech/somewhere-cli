// `somewhere preview start|update|status|list|close` + promote, driven through
// the built CLI binary against a stateful local platform (tsk_5228c20b).
//
// The mock keeps the platform's contract for exact previews: caller-minted
// session ids, expected-preview CAS, operation-id replay, terminal sessions,
// resume never creates, idempotent close, promote bound to the preview base.
// The platform's own enforcement is proven in the platform repository; these
// tests prove the CLI sends exact identities, keeps directory-scoped state,
// never retries a stale write over someone else's, and survives lost responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const PROJECT = '0f7c1c9e-1111-4111-8111-000000000001';
const UNPUBLISHED = '0f7c1c9e-1111-4111-8111-000000000002';

function platform() {
  const state = {
    active: 'rel_live_1',
    published: { [PROJECT]: true, [UNPUBLISHED]: false },
    sessions: new Map(),
    releaseSeq: 0,
    requests: [],
    // 'after' = apply, then drop the connection; 'before' = drop without applying.
    dropDeploy: [],
    closeCleanupPending: new Set(),
    // The platform's operation ledger: op id → { state, release }.
    ledger: new Map(),
    // Next preview write is received and left executing, its response lost.
    nextRunning: false,
    deployDelayMs: 0,
  };
  const receipt = (s, op) => {
    if (s.candidate_op === op && s.candidate) return { operation_id: op, state: 'current', release_id: s.candidate };
    const entry = state.ledger.get(op);
    if (!entry) return { operation_id: op, state: 'not_recorded', release_id: null };
    return {
      operation_id: op,
      state: entry.state === 'succeeded' ? 'succeeded_not_current' : entry.state,
      release_id: entry.release ?? null,
    };
  };
  const view = (s, op) => ({
    ...(op ? { operation: receipt(s, op) } : {}),
    project_id: s.project_id,
    preview_session_id: s.id,
    status: s.status,
    stored_status: s.status,
    preview_id: s.candidate,
    base_release_id: s.base,
    production_release_id: state.active,
    base_is_production: s.base === state.active,
    last_operation_id: s.candidate_op,
    created_at: '2026-09-23T00:00:00.000Z',
    last_updated_at: '2026-09-23T00:00:00.000Z',
    expires_at: '2026-09-24T00:00:00.000Z',
    absolute_expires_at: '2026-09-30T00:00:00.000Z',
    database_status: 'ready',
    files_status: 'ready',
    cleanup_status: 'none',
    promoted_release_id: null,
    resumable: s.status === 'open' && s.candidate !== null,
    promotable: s.status === 'open' && s.candidate !== null && s.base === state.active,
  });
  const fail = (res, status, error, message, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error, message, ...(data ? { data } : {}) }));
  };
  const ok = (res, data) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data }));
  };
  function applyPreview(body) {
    // A retry of an operation still executing gets no answer either.
    if (state.ledger.get(body.preview_operation_id)?.state === 'running') return ['running'];
    const id = body.preview_session_id;
    const expected = body.expected_preview_id;
    let s = state.sessions.get(id);
    if (expected !== null) {
      if (!s || s.project_id !== body.project_id) return [404, 'DRAFT_NOT_FOUND', 'This preview does not exist in this project, so there is nothing to update.'];
    } else {
      if (body.base_release_id !== state.active) return [409, 'STALE_RELEASE_BASE', 'The production release changed.'];
      if (!s) {
        s = { id, project_id: body.project_id, base: state.active, candidate: null, candidate_op: null, status: 'open', ops: new Set(), files: null };
        state.sessions.set(id, s);
      }
    }
    if (s.status !== 'open') {
      return [409, 'DRAFT_SESSION_TERMINAL', 'This preview was closed, so it has finished.', { draft_id: id, terminal_status: s.status }];
    }
    if (s.candidate_op === body.preview_operation_id && s.candidate) return [200, s];
    if (s.candidate !== expected) {
      return [409, 'DRAFT_CANDIDATE_CONFLICT', 'This draft has a different candidate. Re-read it and retry from that exact candidate.', {
        draft_id: id, candidate_release_id: s.candidate, expected_candidate_release_id: expected,
      }];
    }
    if (s.ops.has(body.preview_operation_id)) return [409, 'DRAFT_OPERATION_REUSED', 'This update was already applied.'];
    if (state.buildErrorNext) {
      state.buildErrorNext = false;
      state.ledger.set(body.preview_operation_id, { state: 'failed' });
      return [400, 'BUILD_ERROR', 'index.html: fixture build failure', { errors: [] }];
    }
    if (state.nextRunning) {
      state.nextRunning = false;
      state.ledger.set(body.preview_operation_id, { state: 'running', body, session: s });
      return ['running'];
    }
    return commit(s, body);
  }
  function commit(s, body) {
    s.candidate = `rel_preview_${++state.releaseSeq}`;
    s.candidate_op = body.preview_operation_id;
    s.ops.add(body.preview_operation_id);
    s.files = body.files;
    state.ledger.set(body.preview_operation_id, { state: 'succeeded', release: s.candidate });
    return [200, s];
  }
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      const body = raw ? JSON.parse(raw) : null;
      const path = url.pathname.replace(/^\/v1/, '');
      state.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      const projectMatch = /^\/projects\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && projectMatch) {
        const ref = decodeURIComponent(projectMatch[1]);
        const id = ref === 'app' ? PROJECT : ref;
        if (!(id in state.published)) return fail(res, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
        return ok(res, { id, subdomain: 'app', cloud_dev_allowed: true });
      }
      if (req.method === 'GET' && path === '/deploy/status') {
        const id = url.searchParams.get('project_id');
        if (!state.published[id]) return ok(res, { published: false, active_release_id: null, previews: [] });
        return ok(res, {
          published: true,
          active_release_id: state.active,
          previews: [...state.sessions.values()]
            .filter((s) => s.project_id === id && s.status === 'open' && s.candidate)
            .map((s) => ({ preview_session_id: s.id, preview_id: s.candidate, base_release_id: s.base, expires_at: '2026-09-24T00:00:00.000Z' })),
        });
      }
      if (req.method === 'POST' && path === '/deploy') {
        if (!body.preview) return fail(res, 500, 'UNEXPECTED', 'the CLI must not deploy to production here');
        return void setTimeout(() => {
        const drop = state.dropDeploy.shift();
        if (drop === 'before') return req.socket.destroy();
        const [status, codeOrSession, message, data] = applyPreview(body);
        if (status === 'running' || drop === 'after') return req.socket.destroy();
        if (status !== 200) return fail(res, status, codeOrSession, message, data);
        const s = codeOrSession;
        return ok(res, {
          preview_session_id: s.id, draft_id: s.id, preview_id: s.candidate, candidate_release_id: s.candidate,
          expires_at: Date.parse('2026-09-24T00:00:00.000Z'), db_status: 'ready', files_status: 'ready',
          files_deployed: Object.keys(body.files).length, preview: true,
        });
        }, state.deployDelayMs);
      }
      if (req.method === 'GET' && path === '/deploy/preview/session') {
        const s = state.sessions.get(url.searchParams.get('preview_session_id'));
        if (!s || s.project_id !== url.searchParams.get('project_id')) return fail(res, 404, 'DRAFT_NOT_FOUND', 'This preview does not exist in this project.');
        return ok(res, view(s, url.searchParams.get('preview_operation_id')));
      }
      if (req.method === 'POST' && path === '/deploy/preview/close') {
        const s = state.sessions.get(body.preview_session_id);
        if (!s || s.project_id !== body.project_id) return fail(res, 404, 'DRAFT_NOT_FOUND', 'Preview not found.');
        if (s.status === 'promoted') return fail(res, 409, 'DRAFT_TERMINAL_CONFLICT', 'This preview was already promoted; promotion owns its cleanup.', { status: 'promoted' });
        const replay = s.status !== 'open';
        s.status = s.status === 'open' ? 'closed' : s.status;
        const pending = state.closeCleanupPending.has(s.id);
        state.closeCleanupPending.delete(s.id);
        return ok(res, { preview_session_id: s.id, draft_id: s.id, status: s.status, idempotent_replay: replay, cleanup_complete: !pending, cleanup_pending: pending });
      }
      if (req.method === 'POST' && /^\/projects\/[^/]+\/preview\/mint$/.test(path)) {
        return ok(res, { preview_url: `https://app-dev.example.test/__sw_cap?t=cap_${body.draft_id.slice(-4)}_${body.candidate_release_id}` });
      }
      if (req.method === 'POST' && path === '/promote') {
        const s = state.sessions.get(body.preview_session_id);
        if (!s || s.candidate !== body.preview_id || s.status !== 'open') return fail(res, 409, 'DRAFT_VERSION_MISMATCH', 'This preview can no longer be promoted.');
        if (s.base !== state.active) {
          return fail(res, 409, 'PROMOTION_CONFLICT', 'Production changed after this preview session started. Production was not changed; the preview remains available for review.', {
            draft_base: s.base, current_live: state.active, candidate: s.candidate,
          });
        }
        s.status = 'promoted';
        state.active = `rel_live_from_${s.candidate}`;
        return ok(res, { version: 2, release_id: state.active, active_release_id: state.active, preview_session_id: s.id, preview_id: s.candidate, files_promoted: 1, has_functions: false });
      }
      if (req.method === 'GET' && /^\/projects\/[^/]+\/urls$/.test(path)) return ok(res, { prod_fallback: 'https://app.example.test' });
      if (req.method === 'GET' && /^\/projects\/[^/]+\/files$/.test(path)) return ok(res, { counts: { static: 1, binary: 0, functions: 0 } });
      return fail(res, 404, 'NOT_FOUND', `mock has no ${req.method} ${path}`);
    });
  });
  // Let an operation the test left executing finish on the platform.
  state.finishRunning = (op) => {
    const entry = state.ledger.get(op);
    if (entry.session.candidate !== entry.body.expected_preview_id) {
      state.ledger.set(op, { state: 'failed' });
      return;
    }
    commit(entry.session, entry.body);
  };
  return { state, server };
}

async function withPlatform(fn) {
  const { state, server } = platform();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}/v1`;
  // The CLI's supported config-directory override: HOME is never touched.
  const CONFIG = mkdtempSync(join(tmpdir(), 'preview-life-config-'));
  writeFileSync(join(CONFIG, 'config.json'), JSON.stringify({ token: 'smt_preview_fixture', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  const checkout = (name, project = PROJECT, html = `<main>${name}</main>`) => {
    const dir = mkdtempSync(join(tmpdir(), `preview-life-${name}-`));
    writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: project }) + '\n');
    writeFileSync(join(dir, 'index.html'), html);
    return dir;
  };
  const run = (dir, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SOMEWHERE_CONFIG_DIR: CONFIG, SOMEWHERE_API_URL: api, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { json = null; }
      resolve({ status, stdout, stderr, json });
    });
  });
  const previewsRoot = join(CONFIG, 'previews');
  const stateFiles = () => (existsSync(previewsRoot)
    ? readdirSync(previewsRoot)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.pending-request.json'))
      .map((f) => readFileSync(join(previewsRoot, f), 'utf8'))
    : []);
  const records = () => stateFiles().map((text) => JSON.parse(text));
  const deploys = () => state.requests.filter((r) => r.method === 'POST' && r.path === '/deploy');
  try {
    await fn({ state, run, checkout, stateFiles, records, deploys, CONFIG, previewsRoot });
  } finally {
    server.close();
  }
}

test('two checkouts of one project each start, update, and list their own preview', async () => {
  await withPlatform(async ({ state, run, checkout, stateFiles, deploys, CONFIG }) => {
    const a = checkout('agent-a');
    const b = checkout('agent-b');
    const startA = await run(a, ['preview', 'start', '--json']);
    assert.equal(startA.status, 0, startA.stdout + startA.stderr);
    const startB = await run(b, ['preview', 'start', '--json']);
    assert.equal(startB.status, 0, startB.stdout + startB.stderr);
    assert.match(startA.json.preview_session_id, /^draft_[0-9a-f-]{36}$/);
    assert.notEqual(startA.json.preview_session_id, startB.json.preview_session_id, 'separate checkouts get separate previews');
    assert.equal(startA.json.base_release_id, 'rel_live_1');
    assert.equal(startA.json.status, 'open');
    assert.equal(startA.json.lifecycle.closes_when_this_command_exits, false);
    assert.equal(startA.json.expires_at, '2026-09-24T00:00:00.000Z');
    assert.equal(startA.json.absolute_expires_at, '2026-09-30T00:00:00.000Z');
    assert.match(startA.json.next.promote, new RegExp(`somewhere promote ${startA.json.preview_session_id} ${startA.json.preview_id}`));
    // The first snapshot names the production base it was read from.
    const firstA = deploys()[0].body;
    assert.equal(firstA.expected_preview_id, null);
    assert.equal(firstA.base_release_id, 'rel_live_1');
    assert.equal(firstA.scope, 'all');
    assert.equal(firstA.replace_functions, true);

    // Directory-scoped state: two files, ids only, nothing in the shared link.
    const files = stateFiles();
    assert.equal(files.length, 2);
    // Everything came from the SOMEWHERE_CONFIG_DIR override, not the developer's home.
    assert.ok(state.requests.every((r) => r.auth === 'Bearer smt_preview_fixture'), 'the override config supplied the token');
    assert.ok(existsSync(join(CONFIG, 'last-run.json')), 'CLI state is written to the override directory');
    assert.equal(readdirSync(join(CONFIG, 'previews')).filter((f) => f.endsWith('.pending-request.json')).length, 0,
      'no stored request survives a confirmed operation');
    for (const text of files) {
      assert.doesNotMatch(text, /__sw_cap|cap_|smt_preview_fixture/, 'no sign-in link or token is stored');
    }
    for (const dir of [a, b]) {
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8'))), ['project_id'], '.somewhere.json is untouched');
    }

    writeFileSync(join(a, 'index.html'), '<main>agent-a v2</main>');
    const before = state.sessions.get(startB.json.preview_session_id).candidate;
    const updateA = await run(a, ['preview', 'update', '--json']);
    assert.equal(updateA.status, 0, updateA.stdout + updateA.stderr);
    const sent = deploys().at(-1).body;
    assert.equal(sent.preview_session_id, startA.json.preview_session_id);
    assert.equal(sent.expected_preview_id, startA.json.preview_id, 'update names the exact version it replaces');
    assert.equal('base_release_id' in sent, false);
    assert.notEqual(updateA.json.preview_id, startA.json.preview_id);
    assert.equal(state.sessions.get(startB.json.preview_session_id).candidate, before, 'the other checkout\'s preview is untouched');
    assert.equal(state.sessions.size, 2, 'no extra session was created');

    const list = await run(b, ['preview', 'list', '--json']);
    assert.equal(list.status, 0);
    assert.equal(list.json.previews.length, 2);
    assert.equal(list.json.tracked_here, startB.json.preview_session_id);
    assert.deepEqual(list.json.previews.filter((p) => p.tracked_here).map((p) => p.preview_session_id), [startB.json.preview_session_id]);

    const again = await run(a, ['preview', 'start', '--json']);
    assert.equal(again.status, 1);
    assert.equal(again.json.error, 'PREVIEW_ALREADY_TRACKED');
    assert.equal(state.sessions.size, 2, 'a second start in the same checkout creates nothing');
  });
});

test('a stale same-session update is refused once, never retried over the newer version', async () => {
  await withPlatform(async ({ state, run, checkout, deploys }) => {
    const a = checkout('stale');
    const started = await run(a, ['preview', 'start', '--json']);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const session = state.sessions.get(started.json.preview_session_id);
    // Another agent (MCP, another checkout) moves the same preview.
    session.candidate = 'rel_someone_else';
    session.candidate_op = 'previewop_someone_else';
    writeFileSync(join(a, 'index.html'), '<main>mine</main>');
    const count = deploys().length;
    const stale = await run(a, ['preview', 'update', '--json']);
    assert.equal(stale.status, 1);
    assert.equal(stale.json.error, 'DRAFT_CANDIDATE_CONFLICT');
    assert.equal(stale.json.current_preview_id, 'rel_someone_else');
    assert.match(stale.json.message, /--expect rel_someone_else/);
    assert.equal(deploys().length, count + 1, 'exactly one attempt; no fetch-latest-and-overwrite retry');
    assert.equal(session.candidate, 'rel_someone_else', 'the newer version survives');
    assert.equal(readFileSync(join(a, 'index.html'), 'utf8'), '<main>mine</main>', 'local work is intact');

    const status = await run(a, ['preview', 'status', '--json']);
    assert.equal(status.json.tracking.in_sync, false);
    assert.equal(status.json.tracking.pending_operation, null, 'a refused operation is no longer pending');

    const deliberate = await run(a, ['preview', 'update', '--expect', 'rel_someone_else', '--json']);
    assert.equal(deliberate.status, 0, deliberate.stdout + deliberate.stderr);
    assert.equal(deploys().at(-1).body.expected_preview_id, 'rel_someone_else');
  });
});

test('explicit identity: --session needs --expect and must match the checkout it runs in', async () => {
  await withPlatform(async ({ run, checkout, deploys }) => {
    const a = checkout('owner');
    const b = checkout('other');
    const c = checkout('fresh');
    const startA = await run(a, ['preview', 'start', '--json']);
    await run(b, ['preview', 'start', '--json']);
    const count = deploys().length;

    const noExpect = await run(c, ['preview', 'update', '--session', startA.json.preview_session_id, '--json']);
    assert.equal(noExpect.json.error, 'PREVIEW_EXPECTED_REQUIRED');
    const mismatch = await run(b, ['preview', 'update', '--session', startA.json.preview_session_id, '--expect', startA.json.preview_id, '--json']);
    assert.equal(mismatch.json.error, 'PREVIEW_IDENTITY_MISMATCH');
    const untracked = await run(c, ['preview', 'update', '--json']);
    assert.equal(untracked.json.error, 'PREVIEW_NOT_TRACKED');
    assert.equal(deploys().length, count, 'none of the refusals sent anything');

    const unknown = await run(c, ['preview', 'update', '--session', 'draft_99999999-9999-4999-8999-999999999999', '--expect', 'rel_x', '--json']);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.json.error, 'DRAFT_NOT_FOUND', 'resume of an unknown preview is refused, never created');

    const adopt = await run(c, ['preview', 'update', '--session', startA.json.preview_session_id, '--expect', startA.json.preview_id, '--json']);
    assert.equal(adopt.status, 0, adopt.stdout + adopt.stderr);
    assert.equal(adopt.json.preview_session_id, startA.json.preview_session_id);
  });
});

test('closed and expired previews refuse updates with a way forward; close keeps a cleanup receipt until cleanup finishes', async () => {
  await withPlatform(async ({ state, run, checkout, records }) => {
    const a = checkout('terminal');
    const started = await run(a, ['preview', 'start', '--json']);
    const id = started.json.preview_session_id;
    state.sessions.get(id).status = 'expired';
    const status = await run(a, ['preview', 'status', '--json']);
    assert.equal(status.json.status, 'expired');
    assert.equal(status.json.resumable, false);
    writeFileSync(join(a, 'index.html'), '<main>after expiry</main>');
    const refused = await run(a, ['preview', 'update', '--json']);
    assert.equal(refused.status, 1);
    assert.equal(refused.json.error, 'DRAFT_SESSION_TERMINAL');
    assert.match(refused.json.message, /preview close.*preview start/);
    assert.equal(readFileSync(join(a, 'index.html'), 'utf8'), '<main>after expiry</main>');

    // A terminal tracked preview is replaced by an explicit start, with a note.
    const restart = await run(a, ['preview', 'start', '--json']);
    assert.equal(restart.status, 0, restart.stdout + restart.stderr);
    assert.notEqual(restart.json.preview_session_id, id);
    assert.match(restart.json.warnings.join(' '), /is expired; starting a new one/);
    const second = restart.json.preview_session_id;

    state.closeCleanupPending.add(second);
    const closed = await run(a, ['preview', 'close', '--json']);
    assert.equal(closed.status, 0, closed.stdout + closed.stderr);
    assert.equal(closed.json.cleanup_pending, true);
    assert.equal(closed.json.closed_receipt_kept, true);
    assert.equal(closed.json.retry_cleanup, `somewhere preview close --session ${second}`);
    assert.equal(state.sessions.get(id).status, 'expired', 'close touched only the named preview');
    const [receipt] = records();
    assert.equal(receipt.preview_session_id, second);
    assert.equal(receipt.closed.cleanup_pending, true, 'a closed receipt is kept while cleanup is pending');

    const noUpdate = await run(a, ['preview', 'update', '--json']);
    assert.equal(noUpdate.json.error, 'DRAFT_SESSION_TERMINAL', 'a closed receipt is never an active preview');
    const list = await run(a, ['preview', 'list', '--json']);
    assert.equal(list.json.tracked_here, null);

    const retry = await run(a, ['preview', 'close', '--json']);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(retry.json.preview_session_id, second, 'a plain close retries the receipt');
    assert.equal(retry.json.idempotent_replay, true);
    assert.equal(retry.json.cleanup_pending, false);
    assert.equal(records().length, 0, 'the receipt goes once cleanup finished');

    const foreign = await run(a, ['preview', 'status', '--session', 'draft_99999999-9999-4999-8999-999999999999', '--json']);
    assert.equal(foreign.status, 1);
    assert.equal(foreign.json.error, 'DRAFT_NOT_FOUND');
  });
});

test('a lost response is settled only by the platform receipt; replays carry the exact original request', async () => {
  await withPlatform(async ({ state, run, checkout, deploys, records }) => {
    const a = checkout('lost');
    const started = await run(a, ['preview', 'start', '--json']);
    const session = state.sessions.get(started.json.preview_session_id);

    // Landed, same files: receipt `current` → adopted, nothing re-sent.
    writeFileSync(join(a, 'index.html'), '<main>landed</main>');
    state.dropDeploy.push('after', 'after');
    const lost = await run(a, ['preview', 'update', '--json']);
    assert.equal(lost.json.error, 'PREVIEW_OUTCOME_UNKNOWN');
    const landedOps = deploys().slice(-2).map((r) => r.body.preview_operation_id);
    assert.equal(landedOps[0], landedOps[1], 'the in-process retry re-sent the same operation');
    assert.equal(records()[0].pending.operation_id, landedOps[0]);
    const landed = session.candidate;
    let count = deploys().length;
    const settled = await run(a, ['preview', 'update', '--json']);
    assert.equal(settled.status, 0, settled.stdout + settled.stderr);
    assert.equal(settled.json.sent, false);
    assert.equal(settled.json.preview_id, landed);
    assert.equal(deploys().length, count, 'nothing re-sent for a change that already landed');
    assert.equal(records()[0].pending, null);

    // Not recorded, then the files change: the stored request is replayed
    // byte-for-byte under its own id FIRST, and only then the new change goes
    // out as a new operation on top of it.
    writeFileSync(join(a, 'index.html'), '<main>sent but never arrived</main>');
    state.dropDeploy.push('before', 'before');
    const unsent = await run(a, ['preview', 'update', '--json']);
    assert.equal(unsent.json.error, 'PREVIEW_OUTCOME_UNKNOWN');
    const original = deploys().at(-1).body;
    assert.equal(session.candidate, landed, 'nothing applied');
    writeFileSync(join(a, 'index.html'), '<main>newer local edit</main>');
    count = deploys().length;
    const after = await run(a, ['preview', 'update', '--json']);
    assert.equal(after.status, 0, after.stdout + after.stderr);
    const [replay, fresh] = deploys().slice(count);
    assert.deepEqual(replay.body, original, 'the replay is the exact original request, never rebound to newer files');
    assert.notEqual(fresh.body.preview_operation_id, original.preview_operation_id);
    assert.equal(fresh.body.files['index.html'], '<main>newer local edit</main>');
    assert.equal(fresh.body.expected_preview_id, state.ledger.get(original.preview_operation_id).release,
      'the new change builds on the settled replay, not on an unrelated head');
    assert.equal(deploys().length, count + 2);
  });
});

test('an operation still running or superseded is never adopted and blocks new writes', async () => {
  await withPlatform(async ({ state, run, checkout, deploys, records }) => {
    const a = checkout('running');
    const started = await run(a, ['preview', 'start', '--json']);
    const session = state.sessions.get(started.json.preview_session_id);

    writeFileSync(join(a, 'index.html'), '<main>slow change</main>');
    state.nextRunning = true;
    const lost = await run(a, ['preview', 'update', '--json']);
    assert.equal(lost.json.error, 'PREVIEW_OUTCOME_UNKNOWN');
    const op = records()[0].pending.operation_id;
    // Someone else's change lands on the same preview meanwhile.
    session.candidate = 'rel_other_agent';
    session.candidate_op = 'previewop_other_agent';

    writeFileSync(join(a, 'index.html'), '<main>even newer</main>');
    const count = deploys().length;
    const blocked = await run(a, ['preview', 'update', '--json']);
    assert.equal(blocked.status, 1);
    assert.equal(blocked.json.error, 'PREVIEW_OPERATION_PENDING');
    assert.equal(blocked.json.reason, 'running');
    assert.equal(deploys().length, count, 'nothing is sent while the earlier operation runs');
    assert.equal(records()[0].pending.operation_id, op, 'the pending operation is kept');
    assert.equal(records()[0].preview_id, started.json.preview_id, 'the newer unrelated head is not adopted');
    const status = await run(a, ['preview', 'status', '--json']);
    assert.equal(status.json.tracking.pending_operation.receipt, 'running');

    // It finishes on the platform but loses the CAS race: built, not current.
    state.ledger.set(op, { state: 'succeeded', release: 'rel_built_not_head' });
    const superseded = await run(a, ['preview', 'update', '--json']);
    assert.equal(superseded.status, 1);
    assert.equal(superseded.json.error, 'PREVIEW_OPERATION_SUPERSEDED');
    assert.equal(superseded.json.current_preview_id, 'rel_other_agent');
    assert.equal(deploys().length, count, 'still nothing sent');
    assert.equal(records()[0].pending, null, 'settled by the receipt');
    assert.equal(records()[0].preview_id, started.json.preview_id, 'and still not adopted');
    assert.equal(readFileSync(join(a, 'index.html'), 'utf8'), '<main>even newer</main>');
  });
});

test('concurrent commands in one directory are serialized: one proceeds, the other is refused without side effects', async () => {
  await withPlatform(async ({ state, run, checkout, records }) => {
    const a = checkout('race');
    state.deployDelayMs = 700;
    const [one, two] = await Promise.all([
      run(a, ['preview', 'start', '--json']),
      run(a, ['preview', 'start', '--json']),
    ]);
    const outcomes = [one, two].map((r) => r.json?.error ?? (r.status === 0 ? 'ok' : r.stdout + r.stderr)).sort();
    assert.deepEqual(outcomes, ['PREVIEW_BUSY', 'ok']);
    assert.equal(state.sessions.size, 1, 'exactly one preview was created');
    const winner = [one, two].find((r) => r.status === 0).json.preview_session_id;
    assert.equal(records().length, 1);
    assert.equal(records()[0].preview_session_id, winner, 'the record names the preview that was created');

    writeFileSync(join(a, 'index.html'), '<main>race update</main>');
    const [u1, u2] = await Promise.all([
      run(a, ['preview', 'update', '--json']),
      run(a, ['preview', 'update', '--json']),
    ]);
    const updates = [u1, u2].map((r) => r.json?.error ?? (r.status === 0 ? 'ok' : r.stdout + r.stderr)).sort();
    assert.deepEqual(updates, ['PREVIEW_BUSY', 'ok']);
    const applied = [u1, u2].find((r) => r.status === 0).json.preview_id;
    assert.equal(records()[0].preview_id, applied, 'the record holds the applied version');
    assert.equal(records()[0].pending, null, 'no pending operation was lost or left behind');
  });
});

test('a lock left by a crashed command is recovered; a live one is respected', async () => {
  await withPlatform(async ({ run, checkout, previewsRoot, records }) => {
    const a = checkout('crash');
    const first = await run(a, ['preview', 'start', '--json']);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const lock = readdirSync(previewsRoot).find((f) => f.endsWith('.json') && !f.endsWith('.pending-request.json')).replace(/\.json$/, '.lock');
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.on('close', resolve));
    writeFileSync(join(previewsRoot, lock), JSON.stringify({ token: 'crashed', pid: dead.pid, host: hostname(), started_at: new Date().toISOString() }));
    const recovered = await run(a, ['preview', 'status', '--json']);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.equal(existsSync(join(previewsRoot, lock)), false, 'the stale lock was taken over and released');

    writeFileSync(join(previewsRoot, lock), JSON.stringify({ token: 'live', pid: process.pid, host: hostname(), started_at: new Date().toISOString() }));
    const busy = await run(a, ['preview', 'update', '--json']);
    assert.equal(busy.json.error, 'PREVIEW_BUSY');
    assert.equal(JSON.parse(readFileSync(join(previewsRoot, lock), 'utf8')).token, 'live', 'a live lock is never taken');
    assert.equal(records()[0].pending, null);
  });
});

test('promote refuses a preview whose production base moved, keeps local work, and names the way forward', async () => {
  await withPlatform(async ({ state, run, checkout, stateFiles }) => {
    const a = checkout('promote');
    const started = await run(a, ['preview', 'start', '--json']);
    state.active = 'rel_live_2'; // someone deployed to production meanwhile
    const stale = await run(a, ['promote', started.json.preview_session_id, started.json.preview_id, '--yes', '--json']);
    assert.equal(stale.status, 1);
    assert.equal(stale.json.error, 'PROMOTION_CONFLICT');
    assert.equal(stale.json.local_files_changed, false);
    assert.ok(Array.isArray(stale.json.recovery) && stale.json.recovery.length >= 3);
    assert.match(stale.json.recovery.join('\n'), /somewhere preview close[\s\S]*somewhere preview start/);
    assert.equal(state.active, 'rel_live_2', 'production unchanged');
    assert.equal(stateFiles().length, 1, 'the directory still tracks its preview');

    const status = await run(a, ['preview', 'status', '--json']);
    assert.equal(status.json.base_is_production, false);
    assert.equal(status.json.promotable, false);

    await run(a, ['preview', 'close', '--json']);
    const fresh = await run(a, ['preview', 'start', '--json']);
    assert.equal(fresh.json.base_release_id, 'rel_live_2');
    const promoted = await run(a, ['promote', fresh.json.preview_session_id, fresh.json.preview_id, '--yes', '--json']);
    assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
    assert.equal(stateFiles().length, 0, 'a promoted preview is no longer tracked');
  });
});

test('never-published projects are not published implicitly, and a typo never starts the watcher', async () => {
  await withPlatform(async ({ run, checkout, deploys }) => {
    const fresh = checkout('unpublished', UNPUBLISHED);
    const refused = await run(fresh, ['preview', 'start', '--json']);
    assert.equal(refused.status, 1);
    assert.equal(refused.json.error, 'PUBLISH_CONSENT_REQUIRED');
    assert.equal(deploys().length, 0, 'nothing was published or created');

    const typo = await run(fresh, ['preview', 'stat', '--json']);
    assert.notEqual(typo.status, 0);
    assert.equal(deploys().length, 0);
  });
});

test('a start whose first snapshot was refused is finished on the same preview, or replaced once production moved', async () => {
  await withPlatform(async ({ state, run, checkout, deploys }) => {
    const a = checkout('unfinished');
    state.buildErrorNext = true;
    const failed = await run(a, ['preview', 'start', '--json']);
    assert.equal(failed.status, 1);
    assert.equal(failed.json.error, 'BUILD_ERROR');
    const firstSession = deploys().at(-1).body.preview_session_id;
    assert.equal(state.sessions.size, 1, 'the platform opened the session before the build failed');

    const retried = await run(a, ['preview', 'start', '--json']);
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    assert.equal(retried.json.preview_session_id, firstSession, 'the same preview is finished, not a second one opened');
    assert.equal(state.sessions.size, 1);

    const b = checkout('unfinished-moved');
    state.buildErrorNext = true;
    await run(b, ['preview', 'start', '--json']);
    const emptySession = deploys().at(-1).body.preview_session_id;
    state.active = 'rel_live_9';
    const replaced = await run(b, ['preview', 'start', '--json']);
    assert.equal(replaced.status, 0, replaced.stdout + replaced.stderr);
    assert.notEqual(replaced.json.preview_session_id, emptySession);
    assert.equal(state.sessions.get(emptySession).status, 'closed', 'the empty, unusable preview was closed exactly');
    assert.equal(state.sessions.get(firstSession).status, 'open', 'no other preview was touched');
    assert.match(replaced.json.warnings.join(' '), /never got a version/);
  });
});
