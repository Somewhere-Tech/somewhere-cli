// tsk_ac45ad01 (CLI half): --path/--wait/--eval compose with action flags,
// --url on a session navigates every call, --auth-user resolves an email to
// exactly one user, and the cron/preview helpers state what they found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserBody, resolveAuthUser, urlPathOf } from '../dist/commands/browser.js';
import { cronPolicyLine } from '../dist/commands/cron.js';
import { choosePreviewCandidate } from '../dist/commands/dev.js';

test('--path, --wait and --eval join an action sequence instead of being refused', () => {
  const body = buildBrowserBody(undefined, {
    project: 'crew', path: '/auth/magic?token=t', wait: '#invite-result', eval: 'location.pathname',
    actionSequence: [{ click: '#accept' }],
  });
  assert.equal(body.steps, undefined);
  assert.deepEqual(body.actions, [{ goto: '/auth/magic?token=t' }, { click: '#accept' }, { wait: '#invite-result' }, { eval: 'location.pathname' }]);
});

test('single-step flags without actions keep the legacy step shape', () => {
  const body = buildBrowserBody(undefined, { project: 'crew', path: '/', wait: 'main', eval: '1+1' });
  assert.equal(body.actions, undefined);
  assert.deepEqual(body.steps, [{ action: 'goto', path: '/' }, { action: 'wait_for', selector: 'main' }, { action: 'eval', script: '1+1' }]);
});

test('--url with --session goes to that URL on every call; without a session it is only the start URL', () => {
  const kept = buildBrowserBody(undefined, { url: 'https://crew.somewhere.site/invite?token=x#top', session: 'bob', eval: 'location.pathname' });
  assert.equal(kept.session_id, 'bob');
  assert.deepEqual(kept.actions, [{ goto: '/invite?token=x#top' }, { eval: 'location.pathname' }]);
  const once = buildBrowserBody(undefined, { url: 'https://crew.somewhere.site/invite', eval: 'location.pathname' });
  assert.equal(once.actions, undefined);
  assert.equal(urlPathOf('/club'), '/club');
  assert.equal(urlPathOf('not a url'), undefined);
});

test('--auth-user: an id passes through; an email must match exactly one user', async () => {
  const calls = [];
  const client = (users) => ({ async call(method, path, body, query) { calls.push({ method, path, query }); return { users }; } });
  assert.equal(await resolveAuthUser(client([]), 'p1', 'usr_123'), 'usr_123');
  assert.equal(calls.length, 0, 'no lookup for an id');
  assert.equal(await resolveAuthUser(client([{ id: 'usr_bob', email: 'Bob@Example.com' }, { id: 'usr_bobby', email: 'bobby@example.com' }]), 'p1', 'bob@example.com'), 'usr_bob');
  assert.deepEqual(calls.at(-1), { method: 'GET', path: '/auth/users', query: { project_id: 'p1', search: 'bob@example.com', limit: '200' } });
  await assert.rejects(resolveAuthUser(client([]), 'p1', 'carol@example.com'), /No user with email carol@example\.com/);
  await assert.rejects(resolveAuthUser(client([{ id: 'a', email: 'x@y.z' }, { id: 'b', email: 'X@y.z' }]), 'p1', 'x@y.z'), /More than one user/);
});

test('cron list states the plan policy, including when scheduling is off', () => {
  assert.equal(cronPolicyLine({ crons: [], policy: { plan: 'free', enabled: false, min_interval_minutes: null, max_per_project: 0 } }),
    'free plan: creating or editing scheduled triggers is not available. See: somewhere docs cron');
  assert.equal(cronPolicyLine({ ok: true, data: { crons: [], policy: { plan: 'pro', enabled: true, min_interval_minutes: 5, max_per_project: 20 } } }),
    'pro plan: scheduled triggers allowed (up to 20 per project, at most once every 5 min).');
  assert.equal(cronPolicyLine({ crons: [], policy: null }), null, 'account-wide listings carry no policy');
});

test('preview link picks the only open preview, a named one, or explains', () => {
  const status = { preview_candidates: [
    { draft_id: 'draft_a', candidate_release_id: 'rel_a' },
    { draft_id: 'draft_b', candidate_release_id: 'rel_b' },
  ] };
  assert.deepEqual(choosePreviewCandidate(status, 'draft_b'), { draftId: 'draft_b', candidateReleaseId: 'rel_b' });
  assert.throws(() => choosePreviewCandidate(status), /2 previews are open; name one with --preview-session <id>: draft_a, draft_b/);
  assert.deepEqual(choosePreviewCandidate({ ok: true, data: { preview_candidates: [status.preview_candidates[0]] } }), { draftId: 'draft_a', candidateReleaseId: 'rel_a' });
  assert.throws(() => choosePreviewCandidate({ preview_candidates: [] }), /No open preview .*somewhere preview --once/);
  assert.throws(() => choosePreviewCandidate(status, 'draft_z'), /No open preview has preview_session_id draft_z/);
});
