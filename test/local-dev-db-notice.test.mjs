/**
 * `somewhere dev` must SAY when the plan cannot reach the project database —
 * once, at startup, in product language — and must keep serving anyway.
 *
 * The bug this closes (blind test, fresh Free account, 2026-09-02): the local
 * loop started cleanly, the tester wrote a whole database-backed app against
 * it, and the plan gate only appeared at the first request — as a message
 * saying the connection was not ready and to "promote or redeploy the
 * function". The tester deployed to production and retried; identical error.
 * Twenty minutes were spent on a remediation that could never work, and the app
 * had to be written blind and proved only after shipping.
 *
 * BOTH DIRECTIONS ARE THE TEST. Printing the notice is half of it; the other
 * half is that nothing prints when the platform says yes or says nothing, and
 * that the notice is never a reason to stop the loop.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { localDevDbNotice } from '../dist/commands/dev.js';
import { localDevDbPlanHint } from '../dist/commands/status.js';

test('a plan without the local database is told so, up front and in product language', () => {
  const lines = localDevDbNotice(false, ['pro', 'scale']);
  assert.ok(lines, 'a refused plan must produce a notice');
  const text = lines.join(' ');

  assert.match(lines[0], /does not include reaching the project database/);
  assert.match(lines[0], /Pro and Scale plans/, 'it names the plans that include it');

  // The sentence that stops someone debugging code that is not broken.
  assert.match(text, /Deploying is unaffected on every plan/);
  assert.match(text, /somewhere deploy/);

  // The copy that sent the tester in a circle must not come back.
  assert.doesNotMatch(text, /redeploy/i);
  assert.doesNotMatch(text, /promote/i);
  assert.doesNotMatch(text, /retry/i);

  // Product language only — no platform internals (repo rule 8).
  assert.doesNotMatch(text, /D1|R2|Cloudflare|SQLite|PROJECT_DB|binding|slot|X-Sw-Env-Slot/i);

  // Short enough to read: it is a startup line, not a document.
  assert.ok(lines.length <= 3, `expected at most 3 lines, got ${lines.length}`);
});

test('the plan names come from the platform, never from a list typed into the CLI', () => {
  // The day the entitlement changes, the platform names different plans and
  // this line changes with it — with no CLI release.
  assert.match(localDevDbNotice(false, ['scale'])[0], /the Scale plan\./);
  assert.match(localDevDbNotice(false, ['builder', 'pro', 'scale'])[0],
    /the Builder, Pro and Scale plans\./);

  // And when the platform names nothing, the CLI invents nothing.
  const silent = localDevDbNotice(false, []);
  assert.match(silent[0], /does not include reaching the project database/);
  assert.doesNotMatch(silent[0], /Pro|Scale|Builder|Free/);
});

test('an entitled plan is told nothing at all', () => {
  assert.equal(localDevDbNotice(true, ['pro', 'scale']), null);
  assert.equal(localDevDbNotice(true, []), null);
});

test('an unknown answer is never a refusal', () => {
  // `null` is an older platform, or a project read that did not carry the
  // field. Printing a refusal here would tell a working account its loop is
  // broken — a worse bug than the silence this notice replaces.
  assert.equal(localDevDbNotice(null, []), null);
  assert.equal(localDevDbNotice(null, ['pro', 'scale']), null);
  assert.equal(localDevDbNotice(undefined, []), null);
});

test('the notice is a message, not a refusal — the local loop still runs', async () => {
  // The proof is structural: localDevDbNotice returns TEXT and nothing else.
  // It cannot throw, cannot exit, and the caller has no error branch to take.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../dist/commands/dev.js', import.meta.url), 'utf8'));

  const fn = src.slice(src.indexOf('function localDevDbNotice'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.doesNotMatch(body, /process\.exit|throw /,
    'the startup notice must never be able to stop the loop');

  // ...and at the call site, nothing between the notice and starting the server.
  const callSite = src.slice(src.indexOf('const dbNotice = localDevDbNotice('));
  const untilServe = callSite.slice(0, callSite.indexOf('startDevServer'));
  assert.ok(untilServe.length > 0, 'the notice must be printed before serving starts');
  assert.doesNotMatch(untilServe, /process\.exit/,
    'a plan without the local database must still get a serving loop');
});

test('somewhere status names the same plans and the same deploy carve-out', () => {
  const hint = localDevDbPlanHint(['pro', 'scale']);
  assert.match(hint, /included on the Pro and Scale plans/);
  assert.match(hint, /somewhere deploy` publishes on every plan/);
  assert.doesNotMatch(hint, /redeploy|promote/i);

  // Same silence rule as the dev notice when the platform named nothing.
  const bare = localDevDbPlanHint(undefined);
  assert.doesNotMatch(bare, /Pro|Scale|Builder/);
  assert.match(bare, /publishes on every plan/);
});
