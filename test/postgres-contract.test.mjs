import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere postgres` against a local HTTP server standing in for /v1/postgres/*.
// Every fixture reply is copied from worker/src/routes/postgres.ts — the same
// field names, the same status codes, the same `note` sentence — so this file
// fails if the CLI drifts from the route rather than agreeing with a paraphrase
// of it. No paid network call is ever made: only the platform reaches Neon, and
// the platform here is this fixture server.

const NEON_KEY = 'napi_fixture_secret_value';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const postgresModule = new URL('../dist/commands/postgres.js', import.meta.url).href;
const configModule = new URL('../dist/lib/config.js', import.meta.url).href;

/** routes/postgres.ts RETAINED_RELEASE_NOTE, verbatim. */
const RETAINED_RELEASE_NOTE =
  'Takes effect on the next deploy. Releases already deployed keep the connection details they were built with — ' +
  'this does not revoke access for them. Rotate the credential in your provider account if you need existing releases cut off.';

function harness(t) {
  const home = mkdtempSync(join(tmpdir(), 'cli-postgres-contract-'));
  const requests = [];
  let reply = { status: 200, body: { ok: true, data: {} } };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({
      path: req.url,
      method: req.method,
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    });
    if (reply.drop) {
      // The request arrived and the answer never did — the create case where
      // the database may already exist.
      req.socket.destroy();
      return;
    }
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });

  const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  async function run(args, { env = {}, stdin, cwd } = {}) {
    await listening;
    const script = `
      import { Command } from 'commander';
      import { registerPostgres } from ${JSON.stringify(postgresModule)};
      import { saveConfig } from ${JSON.stringify(configModule)};
      saveConfig({ token: 'smt_fixture_only', user: { email: 'fixture@example.test' } });
      // Imports resolve against the repo root; the project-inference lookup
      // reads process.cwd() at call time, so move afterwards.
      process.chdir(process.env.FIXTURE_CWD);
      const program = new Command();
      registerPostgres(program);
      await program.parseAsync(['node', 'somewhere', 'postgres', ...JSON.parse(process.env.FIXTURE_ARGS)]);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FIXTURE_CWD: cwd ?? home,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
        SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
        SOMEWHERE_NEON_API_KEY: '',
        FIXTURE_ARGS: JSON.stringify(args),
        ...env,
      },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const status = await new Promise((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
    });
    return { status, stdout, stderr, output: stdout + stderr };
  }

  return {
    home,
    requests,
    run,
    ok(data, status = 200) {
      reply = { status, body: { ok: true, data } };
    },
    fail(status, error, message) {
      reply = { status, body: { ok: false, error, message } };
    },
    drop() {
      reply = { drop: true };
    },
  };
}

test('connect posts {project_id, api_key} and never echoes the key', async (t) => {
  const h = harness(t);
  h.ok({ connected: true }, 201);

  const result = await h.run(['connect', '--project', 'fixture-project'], {
    env: { SOMEWHERE_NEON_API_KEY: NEON_KEY },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1), {
    path: '/v1/postgres/connect',
    method: 'POST',
    auth: 'Bearer smt_fixture_only',
    body: { project_id: 'fixture-project', api_key: NEON_KEY },
  });
  assert.match(result.stdout, /Neon account connected to fixture-project/);
  assert.doesNotMatch(result.output, /napi_/, 'the key must never reach the terminal');
  // connect stores a key and binds no database — the route sends no note and
  // no requires_redeploy, so the CLI must not invent one.
  assert.doesNotMatch(result.stdout, /next deploy/i);
});

test('connect sends provider_project_id for a project-scoped key', async (t) => {
  const h = harness(t);
  h.ok({ connected: true }, 201);

  const result = await h.run(['connect', '--project', 'fixture-project', '--neon-project', 'np_scoped'], {
    env: { SOMEWHERE_NEON_API_KEY: NEON_KEY },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1).body, {
    project_id: 'fixture-project',
    api_key: NEON_KEY,
    provider_project_id: 'np_scoped',
  });
});

test('connect reads the key from stdin when the environment has none', async (t) => {
  const h = harness(t);
  h.ok({ connected: true }, 201);

  const result = await h.run(['connect', '--project', 'fixture-project'], { stdin: `${NEON_KEY}\n` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(h.requests.at(-1).body.api_key, NEON_KEY);
  assert.doesNotMatch(result.output, /napi_/);
});

test('connect refuses the key as an argument and sends nothing', async (t) => {
  const h = harness(t);
  const result = await h.run(['connect', NEON_KEY, '--project', 'fixture-project']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Do not pass the Neon API key as an argument/);
  assert.equal(h.requests.length, 0, 'an argv key must never be sent');
});

test('connect with no key anywhere names the accepted sources and sends nothing', async (t) => {
  const h = harness(t);
  const result = await h.run(['connect', '--project', 'fixture-project']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No Neon API key supplied/);
  assert.match(result.stderr, /SOMEWHERE_NEON_API_KEY/);
  assert.equal(h.requests.length, 0);
});

test('attach maps the positional to provider_project_id and --branch to branch_id', async (t) => {
  const h = harness(t);
  h.ok({
    attached: true,
    provider_project_id: 'np_fixture',
    branch_id: 'br_fixture',
    database: 'appdb',
    role: 'app_user',
    host: 'ep-redacted.us-east-2.aws.neon.tech',
    requires_redeploy: true,
    note: RETAINED_RELEASE_NOTE,
  }, 201);

  const result = await h.run([
    'attach', 'np_fixture',
    '--project', 'fixture-project',
    '--database', 'appdb',
    '--role', 'app_user',
    '--branch', 'br_fixture',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(h.requests.at(-1).path, '/v1/postgres/attach');
  assert.deepEqual(h.requests.at(-1).body, {
    project_id: 'fixture-project',
    provider_project_id: 'np_fixture',
    database: 'appdb',
    role: 'app_user',
    branch_id: 'br_fixture',
  });
  assert.match(result.stdout, /Attached Neon project np_fixture/);
  assert.match(result.stdout, /appdb/);
  assert.match(result.stdout, /app_user/);
  assert.match(result.stdout, /br_fixture/);
  assert.match(result.stdout, /ep-redacted\.us-east-2\.aws\.neon\.tech/);
  // The route's own sentence, not a local paraphrase of it.
  assert.match(result.stdout, /Releases already deployed keep the connection details they were built with/);
});

test('attach omits unset options so the platform resolves them', async (t) => {
  const h = harness(t);
  h.ok({ attached: true, provider_project_id: 'np_fixture', requires_redeploy: true, note: RETAINED_RELEASE_NOTE }, 201);

  const result = await h.run(['attach', 'np_fixture', '--project', 'fixture-project']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1).body, {
    project_id: 'fixture-project',
    provider_project_id: 'np_fixture',
  });
  // Pooling is the platform's default; not passing the flag must not assert one.
  assert.equal('pooled' in h.requests.at(-1).body, false);
});

test('attach --no-pooled asks for a direct connection', async (t) => {
  const h = harness(t);
  h.ok({ attached: true, provider_project_id: 'np_fixture', requires_redeploy: true, note: RETAINED_RELEASE_NOTE }, 201);

  const result = await h.run(['attach', 'np_fixture', '--project', 'fixture-project', '--no-pooled']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1).body, {
    project_id: 'fixture-project',
    provider_project_id: 'np_fixture',
    pooled: false,
  });
});

test('attach surfaces an ambiguous target instead of choosing one', async (t) => {
  const h = harness(t);
  h.fail(409, 'POSTGRES_DATABASE_AMBIGUOUS', 'That branch has 2 databases (appdb, analytics). Pass database to choose one.');

  const result = await h.run(['attach', 'np_fixture', '--project', 'fixture-project']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POSTGRES_DATABASE_AMBIGUOUS: That branch has 2 databases \(appdb, analytics\)/);
});

test('a failed attach never becomes a create', async (t) => {
  const h = harness(t);
  h.fail(409, 'POSTGRES_NOT_CONNECTED', 'Connect a database provider account first.');

  const result = await h.run(['attach', 'np_missing', '--project', 'fixture-project']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POSTGRES_NOT_CONNECTED: Connect a database provider account first\./);
  assert.equal(h.requests.length, 1, 'exactly one call — no fallback');
  assert.equal(h.requests[0].path, '/v1/postgres/attach');
});

test('create refuses to spend money unattended without --yes', async (t) => {
  const h = harness(t);
  const result = await h.run(['create', '--project', 'fixture-project']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass --yes to create a Neon project in a non-interactive shell/);
  assert.match(result.stderr, /Neon bills you/);
  assert.equal(h.requests.length, 0);
});

test('create posts {project_id, name, region} and names who is billed', async (t) => {
  const h = harness(t);
  h.ok({
    created: true,
    attached: true,
    provider_project_id: 'np_created',
    region: 'aws-us-east-2',
    host: 'ep-redacted.us-east-2.aws.neon.tech',
    requires_redeploy: true,
    note: RETAINED_RELEASE_NOTE,
  }, 201);

  const result = await h.run(['create', '--project', 'fixture-project', '--name', 'my-db', '--region', 'aws-us-east-2', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1), {
    path: '/v1/postgres/create',
    method: 'POST',
    auth: 'Bearer smt_fixture_only',
    body: { project_id: 'fixture-project', name: 'my-db', region: 'aws-us-east-2' },
  });
  assert.match(result.stdout, /Created Neon project np_created/);
  assert.match(result.stdout, /aws-us-east-2/);
  assert.match(result.stdout, /Neon bills you for it/);
  assert.match(result.stdout, /Releases already deployed keep the connection details/);
});

test('POSTGRES_CREATE_UNCERTAIN is preserved, never retried, and says do not retry', async (t) => {
  const h = harness(t);
  h.fail(
    409,
    'POSTGRES_CREATE_UNCERTAIN',
    'The create request did not return a readable result, so a database may or may not have been created. ' +
      'Check the provider account before trying again — this will not be retried automatically.',
  );

  const human = await h.run(['create', '--project', 'fixture-project', '--yes']);
  assert.equal(human.status, 1);
  assert.equal(h.requests.length, 1, 'an uncertain create must never be retried');
  assert.match(human.stderr, /POSTGRES_CREATE_UNCERTAIN: The create request did not return a readable result/);
  assert.match(human.stdout, /Do NOT run create again/);
  assert.match(human.stdout, /somewhere postgres status/);
  assert.match(human.stdout, /somewhere postgres attach/);

  const json = await h.run(['create', '--project', 'fixture-project', '--yes', '--json']);
  assert.equal(json.status, 1);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'POSTGRES_CREATE_UNCERTAIN');
  assert.equal(envelope.outcome, 'unknown');
  assert.ok(envelope.guidance.some((line) => /Do NOT run create again/.test(line)));
});

test('a create whose response never arrives is unknown, not a retryable failure', async (t) => {
  const h = harness(t);
  h.drop();

  const human = await h.run(['create', '--project', 'fixture-project', '--yes']);
  assert.equal(human.status, 1);
  assert.equal(h.requests.length, 1, 'a lost response must never be retried');
  assert.match(human.stderr, /may or may not have been created/);
  assert.match(human.stderr, /outcome is unknown, not failed/);
  assert.doesNotMatch(human.output, /Created Neon project|was created/);
  assert.match(human.stdout, /Do NOT run create again/);
  // The generic transport advice — "check your network and retry" — is exactly
  // the wrong thing to say about provisioning.
  assert.doesNotMatch(human.output, /Check your network and retry/);

  const json = await h.run(['create', '--project', 'fixture-project', '--yes', '--json']);
  assert.equal(json.status, 1);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.outcome, 'unknown');
  assert.ok(envelope.guidance.some((line) => /Do NOT run create again/.test(line)));
  // The transport code is kept: the route never answered, so its verdict is
  // not ours to assert.
  assert.notEqual(envelope.error, 'POSTGRES_CREATE_UNCERTAIN');
});

test('a definite create rejection is never dressed up as an unknown outcome', async (t) => {
  const h = harness(t);
  // 4xx is the server saying it did not act. Sending someone hunting through
  // their Neon account for a database that was never requested is its own harm.
  for (const [status, code, message] of [
    [400, 'VALIDATION_ERROR', 'project_id is required (string).'],
    [401, 'API_KEY_INVALID', 'The supplied developer key is not valid.'],
    [403, 'PROJECT_OWNER_REQUIRED', 'Owner access is required to create a database.'],
    [403, 'POSTGRES_PROVIDER_UNAUTHORIZED', 'The stored database credential was refused when trying to create the database.'],
    [409, 'POSTGRES_NOT_CONNECTED', 'Connect a database provider account first.'],
  ]) {
    h.fail(status, code, message);
    const result = await h.run(['create', '--project', 'fixture-project', '--yes']);
    assert.equal(result.status, 1, code);
    assert.match(result.stderr, new RegExp(`${code}: `), code);
    assert.doesNotMatch(result.output, /may or may not have been created|Do NOT run create again/, code);

    const json = await h.run(['create', '--project', 'fixture-project', '--yes', '--json']);
    const envelope = JSON.parse(json.stdout);
    assert.equal(envelope.error, code);
    assert.equal(envelope.outcome, undefined, `${code} must not be labelled uncertain`);
    assert.equal(envelope.guidance, undefined, code);
  }
});

test('a 5xx after create is ambiguous, because a gateway can lose a committed POST', async (t) => {
  const h = harness(t);
  for (const [status, code, message] of [
    [500, 'INTERNAL_ERROR', 'Unexpected error.'],
    [502, 'POSTGRES_PROVIDER_ERROR', 'The database provider could not create the database (status 500).'],
    [503, 'POSTGRES_PROVIDER_UNREACHABLE', 'The database provider could not be reached.'],
    [504, 'GATEWAY_TIMEOUT', 'The upstream did not respond in time.'],
  ]) {
    h.fail(status, code, message);
    const human = await h.run(['create', '--project', 'fixture-project', '--yes']);
    assert.equal(human.status, 1, code);
    assert.equal(h.requests.at(-1).path, '/v1/postgres/create', code);
    assert.match(human.stderr, /may or may not have been created/, code);
    assert.match(human.stdout, /Do NOT run create again/, code);
    // The platform's own message is specific and is preserved, not replaced.
    assert.ok(human.stderr.includes(message), `${code} must keep the platform message`);
    // Ambiguity is never dressed up as a completed creation.
    assert.doesNotMatch(human.output, /Created Neon project|was created/, code);

    const json = await h.run(['create', '--project', 'fixture-project', '--yes', '--json']);
    const envelope = JSON.parse(json.stdout);
    // The error's own code survives — POSTGRES_CREATE_UNCERTAIN is the route's
    // verdict to give, and here the route gave a different one.
    assert.equal(envelope.error, code, code);
    assert.equal(envelope.outcome, 'unknown', code);
    assert.ok(envelope.guidance.some((line) => /Do NOT run create again/.test(line)), code);
  }
});

test('a 5xx on attach or disconnect stays an ordinary failure', async (t) => {
  const h = harness(t);
  // Only create can leave a paid resource behind. Nothing else earns the
  // reconciliation copy, and handing it out everywhere would dilute it.
  h.fail(502, 'POSTGRES_PROVIDER_ERROR', 'The database provider could not read the connection details (status 500).');
  const attach = await h.run(['attach', 'np_fixture', '--project', 'fixture-project']);
  assert.equal(attach.status, 1);
  assert.match(attach.stderr, /POSTGRES_PROVIDER_ERROR: The database provider could not read the connection details/);
  assert.doesNotMatch(attach.output, /may or may not have been created|Do NOT run create again/);

  const disconnect = await h.run(['disconnect', '--project', 'fixture-project', '--yes']);
  assert.equal(disconnect.status, 1);
  assert.doesNotMatch(disconnect.output, /may or may not have been created|Do NOT run create again/);
});

test('status reads the route field names and prints no credential, even a leaked one', async (t) => {
  const h = harness(t);
  h.ok({
    connected: true,
    attached: true,
    status: 'attached',
    auth_kind: 'api_key',
    provider: 'neon',
    provider_project_id: 'np_fixture',
    branch_id: 'br_fixture',
    database: 'appdb',
    role: 'app_user',
    host: 'ep-redacted.us-east-2.aws.neon.tech',
    last_error: 'connection refused on 2026-09-19',
    attached_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    // Must never be rendered: human output reads an allowlist of fields.
    dsn: 'postgres://app_user:leaked-password@ep-real.us-east-2.aws.neon.tech/appdb',
    api_key: NEON_KEY,
  });

  const result = await h.run(['status', '--project', 'fixture-project']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(h.requests.at(-1).method, 'GET');
  assert.equal(h.requests.at(-1).path, '/v1/postgres/status?project_id=fixture-project');
  assert.match(result.stdout, /Connected:\s+yes/);
  assert.match(result.stdout, /Attached:\s+yes/);
  assert.match(result.stdout, /neon/);
  assert.match(result.stdout, /np_fixture/);
  assert.match(result.stdout, /br_fixture/);
  assert.match(result.stdout, /appdb/);
  assert.match(result.stdout, /api_key/);
  assert.match(result.stdout, /Last error:\s+connection refused on 2026-09-19/);
  assert.doesNotMatch(result.output, /postgres:\/\/|leaked-password|napi_/);
});

test('status on a project with no row matches the route and says how to connect', async (t) => {
  const h = harness(t);
  h.ok({ connected: false, attached: false, auth_kind: null });

  const result = await h.run(['status', '--project', 'fixture-project']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Connected:\s+no/);
  assert.match(result.stdout, /Attached:\s+no/);
  assert.match(result.stdout, /somewhere postgres connect/);
  assert.match(result.stdout, /neon\.com\/docs\/manage\/api-keys/);
});

test('disconnect needs --yes, removes only our attachment, and claims no revocation', async (t) => {
  const h = harness(t);

  const unconfirmed = await h.run(['disconnect', '--project', 'fixture-project']);
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /Pass --yes to disconnect in a non-interactive shell/);
  assert.equal(h.requests.length, 0);

  h.ok({
    disconnected: true,
    detached: true,
    cleared_pending_create: false,
    key_removed: false,
    database_deleted: false,
    requires_redeploy: true,
    note: RETAINED_RELEASE_NOTE,
  });
  const result = await h.run(['disconnect', '--project', 'fixture-project', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1), {
    path: '/v1/postgres/disconnect',
    method: 'POST',
    auth: 'Bearer smt_fixture_only',
    body: { project_id: 'fixture-project' },
  });
  assert.match(result.stdout, /Neon database was NOT deleted/);
  assert.match(result.stdout, /this does not revoke access for them/);
  assert.match(result.stdout, /Rotate the credential in your provider account/);
  assert.doesNotMatch(result.stdout, /revoked immediately|access is now cut off/i);
  // key_removed:false must not be reported as a key removal, and the default
  // must not silently send forget_key.
  assert.doesNotMatch(result.stdout, /API key was deleted/);
  assert.match(result.stdout, /Neon API key was kept/);
});

test('a disconnect that only cleared a stuck create does not claim a detach', async (t) => {
  const h = harness(t);
  h.ok({
    disconnected: true,
    detached: false,
    cleared_pending_create: true,
    key_removed: false,
    database_deleted: false,
    unresolved_provider_project_id: 'np_orphan',
    unresolved_note:
      'A database may exist at your provider as project np_orphan. ' +
      'Attach it here, or delete it in your provider account — it will keep billing until you do.',
    requires_redeploy: false,
    note: RETAINED_RELEASE_NOTE,
  });

  const result = await h.run(['disconnect', '--project', 'fixture-project', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cleared an unresolved create for fixture-project/);
  assert.match(result.stdout, /No attached database was removed/);
  assert.doesNotMatch(result.stdout, /attachment removed/);
  // The recovery handle must survive in normal human output: after this the
  // platform no longer stores it.
  assert.match(result.stdout, /Unresolved:\s+np_orphan/);
  assert.match(result.stdout, /it will keep billing until you do/);
  // requires_redeploy:false — nothing was detached, so no release changes.
  assert.doesNotMatch(result.stdout, /Takes effect on the next deploy/);
});

test('disconnect with nothing attached and no pending create says exactly that', async (t) => {
  const h = harness(t);
  h.ok({
    disconnected: true,
    detached: false,
    cleared_pending_create: false,
    key_removed: false,
    database_deleted: false,
    requires_redeploy: false,
    note: RETAINED_RELEASE_NOTE,
  });

  const result = await h.run(['disconnect', '--project', 'fixture-project', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Postgres record cleared for fixture-project\. Nothing was attached\./);
  assert.doesNotMatch(result.stdout, /Takes effect on the next deploy|Unresolved:/);
});

test('--json keeps the disconnect recovery fields exactly as the route sent them', async (t) => {
  const h = harness(t);
  const payload = {
    disconnected: true,
    detached: false,
    cleared_pending_create: true,
    key_removed: true,
    database_deleted: false,
    unresolved_provider_project_id: 'np_orphan',
    unresolved_note:
      'A database may exist at your provider as project np_orphan. ' +
      'Attach it here, or delete it in your provider account — it will keep billing until you do.',
    requires_redeploy: false,
    note: RETAINED_RELEASE_NOTE,
  };
  h.ok(payload);

  const result = await h.run(['disconnect', '--project', 'fixture-project', '--yes', '--forget-key', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), payload);
});

test('an interrupted or superseded create keeps its recovery message and is not retried', async (t) => {
  const h = harness(t);
  // Both name a provider project the developer is paying for. They are
  // ordinary typed errors: the route already said what to do, so the CLI
  // neither masks the message nor bolts its own do-not-retry copy on top.
  for (const [code, message] of [
    [
      'POSTGRES_CREATE_SUPERSEDED',
      'The database was created (provider project np_superseded) but this project changed while it was being created, ' +
        'so it was not attached. Nothing here was overwritten. Attach that provider project directly if you still want it, ' +
        'or delete it in your provider account — it will keep billing until you do.',
    ],
    [
      'POSTGRES_CREATE_IN_PROGRESS',
      'A create for this project is unresolved (started 2026-09-20T00:00:00.000Z): a database named "my-db" may have been created. ' +
        'Provider project np_inflight. If it is still running, wait. If the request was interrupted, check your provider account — ' +
        'attach the database directly if it exists, or disconnect to clear this state once you have reconciled. ' +
        'It will not be retried or cleared automatically.',
    ],
  ]) {
    h.fail(409, code, message);
    const human = await h.run(['create', '--project', 'fixture-project', '--yes']);
    assert.equal(human.status, 1, code);
    assert.equal(h.requests.length, 1, `${code} must not be retried`);
    assert.ok(human.stderr.includes(message), `${code} message must reach the developer whole`);
    assert.doesNotMatch(human.output, /Do NOT run create again/, `${code} carries its own guidance`);

    const json = await h.run(['create', '--project', 'fixture-project', '--yes', '--json']);
    const envelope = JSON.parse(json.stdout);
    assert.equal(envelope.error, code, code);
    assert.equal(envelope.message, message, code);
    assert.equal(envelope.outcome, undefined, code);
    h.requests.length = 0;
  }
});

test('disconnect --forget-key deletes the stored key and says so', async (t) => {
  const h = harness(t);
  h.ok({
    disconnected: true,
    detached: true,
    cleared_pending_create: false,
    key_removed: true,
    database_deleted: false,
    requires_redeploy: true,
    note: RETAINED_RELEASE_NOTE,
  });

  const result = await h.run(['disconnect', '--project', 'fixture-project', '--yes', '--forget-key']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1).body, { project_id: 'fixture-project', forget_key: true });
  assert.match(result.stdout, /Neon API key was deleted too/);
  assert.doesNotMatch(result.stdout, /Neon API key was kept/);
  // Forgetting our copy of the key is still not a deletion of their database.
  assert.match(result.stdout, /Neon database was NOT deleted/);
});

test('disconnect on a project with nothing attached reports the route error', async (t) => {
  const h = harness(t);
  h.fail(409, 'POSTGRES_NOT_CONNECTED', 'No database is connected to this project.');

  const result = await h.run(['disconnect', '--project', 'fixture-project', '--yes']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POSTGRES_NOT_CONNECTED: No database is connected to this project\./);
});

test('every subcommand infers the linked project and reports its absence the same way', async (t) => {
  const h = harness(t);
  const linked = mkdtempSync(join(tmpdir(), 'cli-postgres-linked-'));
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  writeFileSync(join(linked, '.somewhere.json'), JSON.stringify({ project_id: 'linked-project' }));

  const invocations = [
    ['connect'],
    ['attach', 'np_fixture'],
    ['create', '--yes'],
    ['status'],
    ['disconnect', '--yes'],
  ];

  for (const args of invocations) {
    h.ok({ connected: true, attached: true, disconnected: true });
    const result = await h.run(args, { cwd: linked, env: { SOMEWHERE_NEON_API_KEY: NEON_KEY } });
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    const request = h.requests.at(-1);
    const sent = request.method === 'GET' ? request.path : JSON.stringify(request.body);
    assert.match(sent, /linked-project/, `${args[0]} did not infer the linked project`);

    const unlinked = await h.run(args, { env: { SOMEWHERE_NEON_API_KEY: NEON_KEY } });
    assert.equal(unlinked.status, 1, args[0]);
    assert.match(unlinked.stderr, /No project\. Pass --project <slug-or-id> or run from a linked directory\./, args[0]);
  }
});

test('--json prints the route response verbatim and nothing else', async (t) => {
  const h = harness(t);
  const payloads = {
    connect: { connected: true },
    attach: {
      attached: true,
      provider_project_id: 'np_fixture',
      branch_id: 'br_fixture',
      database: 'appdb',
      role: 'app_user',
      host: 'ep-redacted.us-east-2.aws.neon.tech',
      requires_redeploy: true,
      note: RETAINED_RELEASE_NOTE,
    },
    create: {
      created: true,
      attached: true,
      provider_project_id: 'np_created',
      region: 'aws-us-east-2',
      host: 'ep-redacted.us-east-2.aws.neon.tech',
      requires_redeploy: true,
      note: RETAINED_RELEASE_NOTE,
    },
    status: { connected: true, attached: false, auth_kind: 'api_key', provider: 'neon' },
    disconnect: {
      disconnected: true,
      detached: true,
      key_removed: false,
      database_deleted: false,
      requires_redeploy: true,
      note: RETAINED_RELEASE_NOTE,
    },
  };
  const invocations = [
    ['connect'],
    ['attach', 'np_fixture'],
    ['create', '--yes'],
    ['status'],
    ['disconnect', '--yes'],
  ];

  for (const args of invocations) {
    h.ok(payloads[args[0]]);
    const result = await h.run([...args, '--project', 'fixture-project', '--json'], {
      env: { SOMEWHERE_NEON_API_KEY: NEON_KEY },
    });
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), payloads[args[0]], args[0]);
  }

  h.fail(403, 'PROJECT_OWNER_REQUIRED', 'Owner access is required to attach a database.');
  const failed = await h.run(['attach', 'np_fixture', '--project', 'fixture-project', '--json']);
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout), {
    ok: false,
    error: 'PROJECT_OWNER_REQUIRED',
    message: 'Owner access is required to attach a database.',
  });
});
