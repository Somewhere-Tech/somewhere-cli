// tsk_28753a0e: the plain `somewhere init` auth starter redeems a sign-in or
// group invitation link on /auth/magic. This drives the generated landing hook
// and the real pinned SDK client over a recording fetch: one verify per page
// load (StrictMode runs the effect twice), the token leaves the address bar
// before the request, only a same-origin redirect is followed, and a failure or
// an unknown outcome is shown, never retried.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const source = Boolean(process.env.SOMEWHERE_TEST_SOURCE);
const moduleRoot = source ? '../src' : '../dist';
const ext = source ? 'ts' : 'js';
const { resolveInitSelection } = await import(`${moduleRoot}/lib/init-features.${ext}`);
const { createFeatureTemplate } = await import(`${moduleRoot}/lib/init-feature-template.${ext}`);
const { writeInitScaffold } = await import(`${moduleRoot}/lib/init-scaffold.${ext}`);
const { runTypecheck } = await import(`${moduleRoot}/lib/typecheck.${ext}`);
const ts = createRequire(import.meta.url)('typescript');

const ORIGIN = 'https://crew.somewhere.site';

/** The smallest hook host the landing needs: state, refs and effects with
 *  deps. `strict` replays the first effect pass the way React StrictMode does
 *  in development (run, clean up, run again with the same refs). */
function createHost() {
  const slots = [];
  let cursor = 0;
  let queued = [];
  let dirty = false;
  const host = {
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[at];
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
        dirty = true;
      }];
    },
    useRef(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect(effect, deps) {
      const at = cursor++;
      const previous = slots[at];
      if (!previous || !deps || deps.some((dep, i) => dep !== previous.deps[i])) {
        slots[at] = { deps, cleanup: previous?.cleanup ?? null };
        queued.push(at, effect);
      }
    },
  };
  function runEffects() {
    const pending = queued;
    queued = [];
    for (let i = 0; i < pending.length; i += 2) {
      const slot = slots[pending[i]];
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = pending[i + 1]() ?? null;
    }
    return pending;
  }
  return {
    host,
    render(hook, { strict = false } = {}) {
      cursor = 0;
      const out = hook();
      const ran = runEffects();
      if (strict) {
        for (let i = 0; i < ran.length; i += 2) {
          const slot = slots[ran[i]];
          if (typeof slot.cleanup === 'function') slot.cleanup();
          slot.cleanup = ran[i + 1]() ?? null;
        }
      }
      return out;
    },
    takeDirty() {
      const was = dirty;
      dirty = false;
      return was;
    },
  };
}

function transpile(code) {
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

/** The generated auth starter, its pinned SDK installed, and the landing hook
 *  and auth client compiled to modules that import the real SDK. */
async function prepareStarter(ui) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-magic-journey-'));
  writeInitScaffold(dir, createFeatureTemplate(resolveInitSelection('auth', ui), { appName: 'Crew' }));
  const checked = await runTypecheck(dir);
  assert.equal(checked.ok, true, checked.raw);
  const sdkAuth = join(dir, 'node_modules', '@somewhere-tech', 'sdk', 'dist', 'esm', 'auth', 'index.js');
  assert.ok(existsSync(sdkAuth), 'the starter installs its pinned SDK');
  const out = join(dir, '.journey');
  mkdirSync(out);
  writeFileSync(join(out, 'react.mjs'), [
    'export const useState = (v) => globalThis.__journeyHost.useState(v);',
    'export const useRef = (v) => globalThis.__journeyHost.useRef(v);',
    'export const useEffect = (f, d) => globalThis.__journeyHost.useEffect(f, d);',
  ].join('\n'));
  writeFileSync(join(out, 'sdk-react.mjs'), 'export const useAuth = () => globalThis.__journeyAuth;\n');
  const service = transpile(readFileSync(join(dir, 'src/services/auth.ts'), 'utf8'))
    .replace("'@somewhere-tech/sdk/auth'", JSON.stringify(pathToFileURL(sdkAuth).href));
  writeFileSync(join(out, 'services-auth.mjs'), service);
  const landing = transpile(readFileSync(join(dir, 'src/auth/magic-link.ts'), 'utf8'))
    .replace("from 'react'", "from './react.mjs'")
    .replace("from '@somewhere-tech/sdk/react'", "from './sdk-react.mjs'")
    .replace("from '../services/auth'", "from './services-auth.mjs'");
  assert.doesNotMatch(landing, /from '(react|@somewhere-tech\/sdk\/react|\.\.\/services\/auth)'/);
  writeFileSync(join(out, 'magic-link.mjs'), landing);
  return { dir, out };
}

let starter;
async function starterModules() {
  starter ??= await prepareStarter('styled');
  return starter;
}

/** One page load of /auth/magic<search>. `respond` answers each fetch. */
async function openLink(search, respond, { strict = true } = {}) {
  const { out } = await starterModules();
  const events = [];
  const fetches = [];
  const location = {
    origin: ORIGIN,
    pathname: '/auth/magic',
    search,
    get href() { return `${ORIGIN}${this.pathname}${this.search}`; },
    replace(target) { events.push(['navigate', target]); },
    assign(target) { events.push(['assign', target]); },
  };
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = {};
  globalThis.window = {
    location,
    history: {
      replaceState(_state, _title, url) {
        events.push(['replaceState', url]);
        const next = new URL(url, ORIGIN);
        location.pathname = next.pathname;
        location.search = next.search;
      },
    },
    addEventListener() {},
  };
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, addressBar: location.href };
    fetches.push(call);
    events.push(['fetch', call.method, call.url]);
    return respond(call);
  };
  try {
    // A fresh client per page load, as a full navigation would create.
    const nonce = `?load=${Math.random()}`;
    const { auth } = await import(pathToFileURL(join(out, 'services-auth.mjs')).href + nonce);
    const { useMagicLinkLanding } = await import(pathToFileURL(join(out, 'magic-link.mjs')).href + nonce);
    globalThis.__journeyAuth = auth;
    const host = createHost();
    globalThis.__journeyHost = host.host;
    let landing = host.render(useMagicLinkLanding, { strict });
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (host.takeDirty()) landing = host.render(useMagicLinkLanding);
    }
    return { landing, events, fetches: fetches.filter((call) => call.url.includes('/magic-link/verify')) };
  } finally {
    Object.assign(globalThis, saved);
    delete globalThis.__journeyAuth;
    delete globalThis.__journeyHost;
  }
}

const verified = () => new Response(JSON.stringify({ ok: true, cookie_session: true, user: { id: 'usr_invitee', email: 'invitee@example.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const signedOut = () => new Response(JSON.stringify({ error: 'AUTH_REQUIRED' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
const answer = (verify) => (call) => (call.url.includes('/magic-link/verify') ? verify(call) : signedOut());

const inviteSearch = (redirect) => `?${new URLSearchParams({ token: 'tok_once', redirect_uri: redirect })}`;

test('a group invitation link verifies once, hides the token first, and opens its same-origin page', async () => {
  const run = await openLink(inviteSearch(`${ORIGIN}/teams/7?invite_id=inv_1`), answer(verified));
  assert.equal(run.fetches.length, 1, 'StrictMode replays the effect; the token is still redeemed once');
  assert.deepEqual({ url: run.fetches[0].url, method: run.fetches[0].method, body: run.fetches[0].body },
    { url: '/api/auth/magic-link/verify', method: 'POST', body: { token: 'tok_once' } });
  assert.equal(run.fetches[0].addressBar, `${ORIGIN}/auth/magic`, 'the token left the address bar before the request');
  const at = (match) => run.events.findIndex(match);
  assert.ok(at(([kind]) => kind === 'replaceState') < at(([kind, , url]) => kind === 'fetch' && url.includes('/magic-link/verify')));
  assert.deepEqual(run.events.filter(([kind]) => kind === 'navigate'), [['navigate', '/teams/7?invite_id=inv_1']]);
  assert.deepEqual(run.landing, { status: 'verifying' });
});

test('a cross-origin redirect_uri is ignored and the invitee lands home', async () => {
  for (const hostile of ['https://evil.example/steal', '//evil.example/x', 'javascript:alert(1)']) {
    const run = await openLink(inviteSearch(hostile), answer(verified));
    assert.equal(run.fetches.length, 1, hostile);
    assert.deepEqual(run.events.filter(([kind]) => kind === 'navigate'), [['navigate', '/']], hostile);
  }
});

test('a used or expired link shows the failure once and never retries or navigates', async () => {
  const run = await openLink(inviteSearch(`${ORIGIN}/teams/7?invite_id=inv_1`), answer(() => new Response(
    JSON.stringify({ ok: false, error: 'AUTH_INVALID_CREDS', message: 'Invalid, used, or expired sign-in link. Request a new one.' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  )));
  assert.equal(run.fetches.length, 1);
  assert.deepEqual(run.landing, { status: 'failed', error: 'Invalid, used, or expired sign-in link. Request a new one.' });
  assert.deepEqual(run.events.filter(([kind]) => kind === 'navigate'), []);
});

test('an unknown outcome (the request never answered) is shown, not replayed', async () => {
  const run = await openLink(inviteSearch(`${ORIGIN}/`), answer(() => { throw new TypeError('fetch failed'); }));
  assert.equal(run.fetches.length, 1, 'no automatic second attempt with a one-time token');
  assert.deepEqual(run.landing, { status: 'failed', error: 'Could not reach the server. Check your connection and try again.' });
  assert.deepEqual(run.events.filter(([kind]) => kind === 'navigate'), []);
});

test('a link without a token fails without calling the platform', async () => {
  const run = await openLink('?redirect_uri=%2F', answer(verified));
  assert.equal(run.fetches.length, 0);
  assert.deepEqual(run.landing, { status: 'failed', error: 'This sign-in link is incomplete. Request a new one.' });
});
