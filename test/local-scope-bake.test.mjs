/**
 * `somewhere dev --local` must declare tables the way deploy declares them.
 *
 * The structured query API — `sw.db.from` and friends — will not compose SQL
 * for a table whose INTENT the platform has not proven: user-owned, shared,
 * server-only, or membership-joined. Deploy bakes that intent into the function
 * bundle. The local loop read `GET /db/scopes` and kept only `owner_column`,
 * dropping the intent, so a `shared()` table that worked on the same deployed
 * project came back locally as:
 *
 *   sw.db.from on "catalog": this table has no declared intent, so the platform
 *   cannot prove how to access it safely.
 *
 * Worse, a non-owned table was baked into PROJECT_SCOPES with a null owner
 * column — a shape the runtime treats as a contradictory bundle, since an owner
 * scope is only ever valid alongside a `scoped` intent (tsk_a21bc829).
 *
 * These assert the local bake against that contract, on the response shape
 * /db/scopes actually returns.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { prepareLocalProject } = await import(pathToFileURL(join(root, 'dist/local/runtime.js')).href);

/** A project directory with one routable function, which is all the bake needs. */
function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-scope-bake-'));
  mkdirSync(join(dir, 'api'), { recursive: true });
  writeFileSync(
    join(dir, 'api', 'probe.ts'),
    'export default async function (req, sw) { return Response.json({ ok: true }); }\n',
  );
  return dir;
}

/** Stand in for the platform, answering the three calls the bake makes. */
function fakeClient(scopesResponse) {
  return {
    async call(_method, path) {
      if (path === '/env') return { keys: [] };
      if (path === '/db/scopes') return scopesResponse;
      return { id: 'proj_test', subdomain: 'swtest' };
    },
  };
}

/** The exact shape GET /db/scopes returns for a managed schema. */
const SCOPES = {
  scopes: [
    { table: 'catalog', owner_column: null, intent: 'shared', sensitive_columns: [] },
    { table: 'links', owner_column: 'user_id', intent: 'scoped', sensitive_columns: [] },
    { table: 'audit', owner_column: null, intent: 'server_only', sensitive_columns: [] },
  ],
  unscoped_user_tables: [],
  owner_identity_mode: 'visitor',
};

async function bake(scopesResponse) {
  const dir = projectDir();
  try {
    const state = await prepareLocalProject(fakeClient(scopesResponse), 'smt_test', 'proj_test', dir);
    return state.bindings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── APP_URL is the platform's, not the developer's (tsk_6a2a09bc5d) ────────
 * `somewhere dev` warned "Platform env keys with no local value (access will
 * throw): APP_URL. Add them to .env in this directory" on a project whose
 * source never mentions APP_URL. The developer did not write it — deploy does,
 * and it holds wherever the app is being served. Reporting it as one of THEIR
 * omissions sent a first-time user off to author a value for a variable that
 * is not theirs, and devalued every real warning beside it.
 *
 * Locally the value is knowable: the app is being served right here. */
function envClient(keys) {
  return {
    async call(_method, path) {
      if (path === '/env') return { keys: keys.map((key) => ({ key })) };
      if (path === '/db/scopes') return { scopes: [] };
      return { id: 'proj_test', subdomain: 'swtest-triage' };
    },
  };
}

async function envState(keys, opts) {
  const dir = projectDir();
  try {
    return await prepareLocalProject(envClient(keys), 'smt_test', 'proj_test', dir, opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('APP_URL is filled with the local origin and never reported as missing', async () => {
  const state = await envState(['APP_URL'], { localOrigin: 'http://localhost:8912' });
  assert.deepEqual(state.missingEnvKeys, []);
  assert.equal(JSON.parse(state.bindings.USER_ENV).APP_URL, 'http://localhost:8912');
});

test('with no local server APP_URL falls back to the project URL, still not missing', async () => {
  const state = await envState(['APP_URL'], {});
  assert.deepEqual(state.missingEnvKeys, []);
  assert.equal(
    JSON.parse(state.bindings.USER_ENV).APP_URL,
    'https://swtest-triage.somewhere.site',
  );
});

test("a key the developer really does own is still reported", async () => {
  // The warning exists for a reason and has to keep working — this only stops
  // it firing on a key the platform wrote.
  const state = await envState(['APP_URL', 'STRIPE_SECRET_KEY'], {
    localOrigin: 'http://localhost:8912',
  });
  assert.deepEqual(state.missingEnvKeys, ['STRIPE_SECRET_KEY']);
});

test('a project that does not have APP_URL does not get one invented', async () => {
  const state = await envState(['STRIPE_SECRET_KEY'], { localOrigin: 'http://localhost:8912' });
  assert.equal('APP_URL' in JSON.parse(state.bindings.USER_ENV), false);
});

test('every declared table reaches the local runtime with its intent', async () => {
  const bindings = await bake(SCOPES);
  assert.deepEqual(JSON.parse(bindings.PROJECT_TABLE_INTENTS), {
    catalog: 'shared',
    links: 'scoped',
    audit: 'server_only',
  });
});

test('only a user-owned table carries an owner column', async () => {
  const bindings = await bake(SCOPES);
  // A null owner column for a shared table is not "no owner" — it is a bundle
  // the runtime is entitled to reject, because an owner scope without a scoped
  // intent is a contradiction.
  assert.deepEqual(JSON.parse(bindings.PROJECT_SCOPES), { links: 'user_id' });
});

test('the owner-identity mode reaches the local runtime', async () => {
  const bindings = await bake(SCOPES);
  assert.equal(bindings.PROJECT_OWNER_IDENTITY_MODE, 'visitor');
});

test('nothing is baked when the project declares nothing', async () => {
  // Deploy bakes these only when there is something to say; an absent binding
  // IS the runtime's "nothing declared" default, and an empty map would be a
  // different statement.
  const bindings = await bake({ scopes: [], owner_identity_mode: 'authenticated' });
  assert.equal(JSON.parse(bindings.PROJECT_SCOPES) && Object.keys(JSON.parse(bindings.PROJECT_SCOPES)).length, 0);
  assert.equal('PROJECT_TABLE_INTENTS' in bindings, false);
  assert.equal('PROJECT_OWNER_IDENTITY_MODE' in bindings, false);
});

test('a platform that does not report intent still scopes an owned table', async () => {
  // Older platform responses carried owner_column alone. An owned table is
  // unambiguous there; a table with neither is left undeclared rather than
  // guessed at.
  const bindings = await bake({
    scopes: [
      { table: 'links', owner_column: 'user_id' },
      { table: 'catalog', owner_column: null },
    ],
  });
  assert.deepEqual(JSON.parse(bindings.PROJECT_SCOPES), { links: 'user_id' });
  assert.deepEqual(JSON.parse(bindings.PROJECT_TABLE_INTENTS), { links: 'scoped' });
});

test('a /db/scopes failure never stops the dev server', async () => {
  const dir = projectDir();
  try {
    const client = {
      async call(_method, path) {
        if (path === '/env') return { keys: [] };
        if (path === '/db/scopes') throw new Error('platform unreachable');
        return { id: 'proj_test', subdomain: 'swtest' };
      },
    };
    const state = await prepareLocalProject(client, 'smt_test', 'proj_test', dir);
    assert.deepEqual(JSON.parse(state.bindings.PROJECT_SCOPES), {});
    assert.equal('PROJECT_TABLE_INTENTS' in state.bindings, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
