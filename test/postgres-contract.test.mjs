import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere postgres` against a local HTTP server standing in for /v1/postgres/*.
// No paid network call is ever made: the Neon account is reached only by the
// platform, and the platform here is this fixture server.

const NEON_KEY = 'napi_fixture_secret_value';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const postgresModule = new URL('../dist/commands/postgres.js', import.meta.url).href;
const configModule = new URL('../dist/lib/config.js', import.meta.url).href;

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
    setReply(next) {
      reply = next;
    },
    ok(data) {
      reply = { status: 200, body: { ok: true, data } };
    },
    fail(status, error, message) {
      reply = { status, body: { ok: false, error, message } };
    },
  };
}

test('connect posts {project_id, api_key} and never echoes the key', async (t) => {
  const h = harness(t);
  h.ok({ project_id: 'fixture-project', connected: true, account: { email: 'dev@example.test' } });

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
  assert.match(result.stdout, /dev@example\.test/);
  assert.doesNotMatch(result.output, /napi_/, 'the key must never reach the terminal');
  // connect stores a key and binds no database — it must not claim a redeploy is due.
  assert.doesNotMatch(result.stdout, /Deploy again/);
});

test('connect reads the key from stdin when the environment has none', async (t) => {
  const h = harness(t);
  h.ok({ project_id: 'fixture-project', connected: true });

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

test('connect with no key anywhere explains the three accepted sources and sends nothing', async (t) => {
  const h = harness(t);
  const result = await h.run(['connect', '--project', 'fixture-project']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No Neon API key supplied/);
  assert.match(result.stderr, /SOMEWHERE_NEON_API_KEY/);
  assert.equal(h.requests.length, 0);
});

test('attach binds an existing project, forwards its options, and asks for a redeploy', async (t) => {
  const h = harness(t);
  h.ok({
    project_id: 'fixture-project',
    attached: true,
    neon_project_id: 'np_fixture',
    host: 'ep-…redacted….us-east-2.aws.neon.tech',
    requires_redeploy: true,
  });

  const result = await h.run([
    'attach', 'np_fixture',
    '--project', 'fixture-project',
    '--database', 'appdb',
    '--role', 'app_user',
    '--branch', 'main',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1).body, {
    project_id: 'fixture-project',
    neon_project_id: 'np_fixture',
    database: 'appdb',
    role: 'app_user',
    branch: 'main',
  });
  assert.equal(h.requests.at(-1).path, '/v1/postgres/attach');
  assert.match(result.stdout, /Attached Neon project np_fixture/);
  assert.match(result.stdout, /ep-…redacted…/);
  assert.match(result.stdout, /Deploy again for sw\.postgres/);
});

test('attach omits unset options and honors requires_redeploy:false', async (t) => {
  const h = harness(t);
  h.ok({ project_id: 'fixture-project', attached: true, neon_project_id: 'np_fixture', requires_redeploy: false });

  const result = await h.run(['attach', 'np_fixture', '--project', 'fixture-project']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1).body, { project_id: 'fixture-project', neon_project_id: 'np_fixture' });
  assert.doesNotMatch(result.stdout, /Deploy again/);
});

test('a failed attach never becomes a create', async (t) => {
  const h = harness(t);
  h.fail(404, 'PROJECT_NOT_FOUND', 'No Neon project np_missing in the connected account.');

  const result = await h.run(['attach', 'np_missing', '--project', 'fixture-project']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PROJECT_NOT_FOUND: No Neon project np_missing/);
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
    project_id: 'fixture-project',
    created: true,
    neon_project_id: 'np_created',
    host: 'ep-…redacted….us-east-2.aws.neon.tech',
    requires_redeploy: true,
  });

  const result = await h.run(['create', '--project', 'fixture-project', '--name', 'my-db', '--region', 'aws-us-east-2', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1), {
    path: '/v1/postgres/create',
    method: 'POST',
    auth: 'Bearer smt_fixture_only',
    body: { project_id: 'fixture-project', name: 'my-db', region: 'aws-us-east-2' },
  });
  assert.match(result.stdout, /Created Neon project np_created/);
  assert.match(result.stdout, /Neon bills you for it/);
  assert.match(result.stdout, /Deploy again for sw\.postgres/);
});

test('POSTGRES_CREATE_UNCERTAIN is preserved, never retried, and says do not retry', async (t) => {
  const h = harness(t);
  h.fail(409, 'POSTGRES_CREATE_UNCERTAIN', 'Neon did not return a readable result for this create.');

  const human = await h.run(['create', '--project', 'fixture-project', '--yes']);
  assert.equal(human.status, 1);
  assert.equal(h.requests.length, 1, 'an uncertain create must never be retried');
  assert.match(human.stderr, /POSTGRES_CREATE_UNCERTAIN: Neon did not return a readable result/);
  assert.match(human.stdout, /Do NOT run create again/);
  assert.match(human.stdout, /somewhere postgres status/);
  assert.match(human.stdout, /somewhere postgres attach/);

  const json = await h.run(['create', '--project', 'fixture-project', '--yes', '--json']);
  assert.equal(json.status, 1);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'POSTGRES_CREATE_UNCERTAIN');
  assert.ok(Array.isArray(envelope.guidance) && envelope.guidance.some((line) => /Do NOT run create again/.test(line)));
});

test('status reads GET ?project_id= and prints no credential, even one the server leaks', async (t) => {
  const h = harness(t);
  h.ok({
    project_id: 'fixture-project',
    connected: true,
    attached: true,
    neon_project_id: 'np_fixture',
    host: 'ep-…redacted….us-east-2.aws.neon.tech',
    status: 'ready',
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
  assert.match(result.stdout, /np_fixture/);
  assert.match(result.stdout, /ready/);
  assert.doesNotMatch(result.output, /postgres:\/\/|leaked-password|napi_/);
});

test('status on an unconnected project says how to connect and that OAuth is unavailable', async (t) => {
  const h = harness(t);
  h.ok({ project_id: 'fixture-project', connected: false, attached: false });

  const result = await h.run(['status', '--project', 'fixture-project']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Connected:\s+no/);
  assert.match(result.stdout, /somewhere postgres connect/);
  assert.match(result.stdout, /OAuth to registered commercial partners/);
});

test('disconnect needs --yes, removes only our attachment, and claims no immediate revocation', async (t) => {
  const h = harness(t);

  const unconfirmed = await h.run(['disconnect', '--project', 'fixture-project']);
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /Pass --yes to disconnect in a non-interactive shell/);
  assert.equal(h.requests.length, 0);

  h.ok({ project_id: 'fixture-project', disconnected: true });
  const result = await h.run(['disconnect', '--project', 'fixture-project', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.requests.at(-1), {
    path: '/v1/postgres/disconnect',
    method: 'POST',
    auth: 'Bearer smt_fixture_only',
    body: { project_id: 'fixture-project' },
  });
  assert.match(result.stdout, /Neon database was NOT deleted/);
  assert.match(result.stdout, /Not an immediate revocation/);
  assert.match(result.stdout, /until you redeploy, or revoke the credential in Neon/);
  assert.doesNotMatch(result.stdout, /revoked immediately|access is now cut off/i);
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
    h.ok({ project_id: 'linked-project', connected: true, attached: true });
    const result = await h.run(args, {
      cwd: linked,
      env: { SOMEWHERE_NEON_API_KEY: NEON_KEY },
    });
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    const request = h.requests.at(-1);
    const sent = request.method === 'GET' ? request.path : JSON.stringify(request.body);
    assert.match(sent, /linked-project/, `${args[0]} did not infer the linked project`);

    const unlinked = await h.run(args, { env: { SOMEWHERE_NEON_API_KEY: NEON_KEY } });
    assert.equal(unlinked.status, 1, args[0]);
    assert.match(unlinked.stderr, /No project\. Pass --project <slug-or-id> or run from a linked directory\./, args[0]);
  }
});

test('--json prints the response envelope and nothing else', async (t) => {
  const h = harness(t);
  const payloads = {
    connect: { project_id: 'fixture-project', connected: true, account: { email: 'dev@example.test' } },
    attach: { project_id: 'fixture-project', attached: true, neon_project_id: 'np_fixture', requires_redeploy: true },
    create: { project_id: 'fixture-project', created: true, neon_project_id: 'np_created' },
    status: { project_id: 'fixture-project', connected: true, attached: false },
    disconnect: { project_id: 'fixture-project', disconnected: true },
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

  h.fail(409, 'POSTGRES_NOT_CONNECTED', 'No Neon API key is stored for this project.');
  const failed = await h.run(['status', '--project', 'fixture-project', '--json']);
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout), {
    ok: false,
    error: 'POSTGRES_NOT_CONNECTED',
    message: 'No Neon API key is stored for this project.',
  });
});
