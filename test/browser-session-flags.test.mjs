// tsk_ac45ad01 (CLI half): --path/--wait/--eval compose with action flags,
// --url with --session is only the start URL (no extra goto), --auth-user
// resolves an email to exactly one user, and the cron/preview helpers state
// what they found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserBody, resolveAuthUser } from '../dist/commands/browser.js';
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

test('--url with --session is only the start URL: no extra goto (a single-use link must load once)', () => {
  const kept = buildBrowserBody(undefined, { url: 'https://crew.somewhere.site/auth/magic?token=T', session: 'bob' });
  assert.equal(kept.session_id, 'bob');
  assert.equal(kept.url, 'https://crew.somewhere.site/auth/magic?token=T');
  assert.equal(kept.actions, undefined, 'no goto: a fresh session already opens the URL once');
  assert.equal(kept.steps, undefined, 'inspect mode is kept, so --extract and the DOM map still return');
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
  await assert.rejects(resolveAuthUser(client([]), undefined, 'bob@example.com'), /needs a project/);
  assert.equal(await resolveAuthUser(client([]), undefined, 'usr_9'), 'usr_9', 'an id works without a project (url mode)');
  // An exact match past the first page of partial matches is still found.
  const pages = [
    { users: [{ id: 'usr_x', email: 'bob@example.com.au' }], next_cursor: 'c1' },
    { users: [{ id: 'usr_bob', email: 'bob@example.com' }], next_cursor: null },
  ];
  let served = 0;
  const paged = { async call(_m, _p, _b, query) { if (served === 1) assert.equal(query.cursor, 'c1'); return pages[served++]; } };
  assert.equal(await resolveAuthUser(paged, 'p1', 'bob@example.com'), 'usr_bob');
});

test('--auth-user: complete pagination finds the one exact match; a cursor left after 10 pages refuses', async () => {
  const pagedClient = (pageCount, exactOnPage, lastCursor) => {
    const calls = [];
    return {
      calls,
      async call(_m, _p, _b, query) {
        calls.push(query.cursor ?? null);
        const index = calls.length - 1;
        const users = [{ id: `usr_partial_${index}`, email: `bob@example.com.${index}` }];
        if (index === exactOnPage) users.push({ id: 'usr_bob', email: 'bob@example.com' });
        const last = index === pageCount - 1;
        return { users, next_cursor: last ? lastCursor : `c${index + 1}` };
      },
    };
  };
  const complete = pagedClient(10, 9, null);
  assert.equal(await resolveAuthUser(complete, 'p1', 'bob@example.com'), 'usr_bob', 'exact match on the last page of a complete listing');
  assert.equal(complete.calls.length, 10);
  const unfinished = pagedClient(10, 3, 'c10');
  await assert.rejects(resolveAuthUser(unfinished, 'p1', 'bob@example.com'), /could not be confirmed\. Pass the user id instead/);
  assert.equal(unfinished.calls.length, 10, 'the request bound is kept: no 11th page');
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
