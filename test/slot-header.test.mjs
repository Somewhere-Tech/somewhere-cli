/**
 * Header-sent gate for the dev/prod execution-slot routing (tsk_ab9ad0fd).
 *
 * `somewhere dev --local` and `somewhere exec` run user functions in local Node
 * through the VENDORED deployed runtime (runtime/platform-context.mjs →
 * buildPlatformContext → platformFetch). Before this lane the vendored copy was
 * frozen before the X-Sw-Env-Slot work, so its sw.db / sw.fs calls bound PROD
 * even when the project was flag-enrolled in DEV_SLOT_ENFORCE_PROJECTS.
 *
 * These tests prove the re-vendored runtime stamps X-Sw-Env-Slot on every
 * platform call, taken from the execution slot (env.PROJECT_ENV). The local
 * runtime always binds PROJECT_ENV='dev' (see prepareLocalProject), so the
 * dev --local / exec path emits X-Sw-Env-Slot: dev. We intercept globalThis.fetch
 * (what platformFetch calls) and assert on the outgoing headers — no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildPlatformContext } = await import(
  pathToFileURL(join(root, 'runtime', 'platform-context.mjs')).href
);
// dist/ artifacts — the real dev --local dispatch path (compiled from src/local).
const { dispatchRequest } = await import(pathToFileURL(join(root, 'dist/local/runtime.js')).href);
const { compileRoutes } = await import(pathToFileURL(join(root, 'dist/local/router.js')).href);

/**
 * Build a context with the given execution slot and capture every outgoing
 * platform request. Returns { ctx, calls } where calls[i] = { url, slot }.
 */
function withCapture(projectEnv) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers((init && init.headers) || {});
    calls.push({ url: String(url), slot: headers.get('X-Sw-Env-Slot') });
    // Minimal envelope so db.query / fs.read resolve without a real backend.
    return new Response(JSON.stringify({ ok: true, data: { rows: [], meta: {} } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  // The same bindings prepareLocalProject hands the runtime, minus PROJECT_DB
  // (its absence selects the REST data path — exactly the local case).
  const bindings = {
    PROJECT_ID: 'proj_test',
    SUBDOMAIN: 'swtest',
    TIER: 'free',
    PROJECT_API_KEY: 'smt_test_key',
    USER_ENV: '{}',
    PROJECT_SCOPES: '{}',
    PROJECT_ENV: projectEnv,
    PLATFORM_API_BASE: 'https://api.example.invalid',
  };
  const request = new Request('https://swtest.example.invalid/api/x');
  const ctx = buildPlatformContext(bindings, request);
  return { ctx, calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('sw.db.query stamps X-Sw-Env-Slot: dev for the local execution slot', async () => {
  const { ctx, calls, restore } = withCapture('dev');
  try {
    await ctx.db.query('SELECT 1', []);
  } finally {
    restore();
  }
  const dbCall = calls.find((c) => c.url.includes('/v1/db/query'));
  assert.ok(dbCall, 'expected a /v1/db/query platform call');
  assert.equal(dbCall.slot, 'dev', 'sw.db must send X-Sw-Env-Slot: dev under dev --local/exec');
});

test('sw.fs.read stamps X-Sw-Env-Slot: dev for the local execution slot', async () => {
  const { ctx, calls, restore } = withCapture('dev');
  try {
    await ctx.fs.read('/notes.txt');
  } finally {
    restore();
  }
  const fsCall = calls.find((c) => c.url.includes('/v1/fs/'));
  assert.ok(fsCall, 'expected a /v1/fs/ platform call');
  assert.equal(fsCall.slot, 'dev', 'sw.fs must send X-Sw-Env-Slot: dev under dev --local/exec');
});

test('the slot header reflects PROJECT_ENV (prod slot sends prod)', async () => {
  // Proves the header is sourced from the execution slot, not hard-coded — the
  // promoted prod bundle would send 'prod'. The local runtime never binds prod,
  // but this nails down that 'dev' is a real consequence of PROJECT_ENV='dev'.
  const { ctx, calls, restore } = withCapture('prod');
  try {
    await ctx.db.query('SELECT 1', []);
  } finally {
    restore();
  }
  const dbCall = calls.find((c) => c.url.includes('/v1/db/query'));
  assert.equal(dbCall.slot, 'prod');
});

test('dev --local dispatch path: a user function calling sw.db.query emits X-Sw-Env-Slot: dev', async () => {
  // The end-to-end CLI path: dispatchRequest (what `somewhere dev --local` and
  // `somewhere exec` run) → buildPlatformContext(state.bindings) → handler →
  // platformFetch. state.bindings.PROJECT_ENV is hard-set to 'dev' by
  // prepareLocalProject, so the whole local loop tags its data calls as dev.
  const dir = mkdtempSync(join(tmpdir(), 'sw-slot-'));
  const fnPath = join(dir, 'api', 'wipe.mjs');
  mkdirSync(join(dir, 'api'), { recursive: true });
  writeFileSync(
    fnPath,
    'export default async function (req, sw) {\n' +
      "  const r = await sw.db.query('DELETE FROM widgets', []);\n" +
      '  return Response.json({ changes: r.changes });\n' +
      '}\n',
  );

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers((init && init.headers) || {});
    calls.push({ url: String(url), slot: headers.get('X-Sw-Env-Slot') });
    return new Response(JSON.stringify({ ok: true, data: { rows: [], meta: { changes: 0 } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const routes = compileRoutes([{ file: 'api/wipe.mjs', absPath: fnPath }]);
    const state = {
      projectId: 'proj_test',
      subdomain: 'swtest',
      cwd: dir,
      bindings: {
        PROJECT_ID: 'proj_test',
        SUBDOMAIN: 'swtest',
        TIER: 'free',
        PROJECT_API_KEY: 'smt_test_key',
        USER_ENV: '{}',
        PROJECT_SCOPES: '{}',
        PROJECT_ENV: 'dev', // exactly what prepareLocalProject sets
        PLATFORM_API_BASE: 'https://api.example.invalid',
      },
      missingEnvKeys: [],
      localEnvKeys: [],
      routes,
    };
    const req = new Request('https://swtest.example.invalid/api/wipe', { method: 'DELETE' });
    const { response, error } = await dispatchRequest(req, state);
    assert.ok(!error, 'handler should not throw: ' + (error && error.message));
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }

  const dbCall = calls.find((c) => c.url.includes('/v1/db/query'));
  assert.ok(dbCall, 'expected a /v1/db/query call from the dispatched function');
  assert.equal(dbCall.slot, 'dev', 'the local dispatch loop must tag sw.db calls as the dev slot');
});

test('missing PROJECT_ENV defaults the slot to dev (matches buildPlatformContext default)', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers((init && init.headers) || {});
    calls.push({ url: String(url), slot: headers.get('X-Sw-Env-Slot') });
    return new Response(JSON.stringify({ ok: true, data: { rows: [], meta: {} } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const ctx = buildPlatformContext(
      {
        PROJECT_ID: 'proj_test',
        PROJECT_API_KEY: 'smt_test_key',
        USER_ENV: '{}',
        PROJECT_SCOPES: '{}',
        PLATFORM_API_BASE: 'https://api.example.invalid',
        // PROJECT_ENV intentionally absent
      },
      new Request('https://swtest.example.invalid/api/x'),
    );
    await ctx.db.query('SELECT 1', []);
  } finally {
    globalThis.fetch = realFetch;
  }
  const dbCall = calls.find((c) => c.url.includes('/v1/db/query'));
  assert.equal(dbCall.slot, 'dev');
});
