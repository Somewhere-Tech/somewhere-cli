import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'index.js');
const schemaSource = [
  "import { schema, table, id, text, owner } from 'somewhere/db';",
  'export default schema({ notes: table({ id: id(), body: text() }, { scope: owner() }) });',
  '',
].join('\n');

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sw-apply-schema-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'sw-apply-schema-project-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  mkdirSync(join(cwd, 'db'));
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_apply_schema_fixture',
    user: { email: 'dev@example.com', username: 'dev' },
  }));
  writeFileSync(join(cwd, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_apply_schema',
    name: 'apply schema fixture',
    subdomain: 'apply-schema-fixture',
  }));
  writeFileSync(join(cwd, 'db', 'schema.ts'), schemaSource);
  return { home, cwd };
}

async function stub(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, body });
    const reply = handler({ method: req.method, url: req.url, body });
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const address = server.address();
  return {
    requests,
    apiUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolveServer) => server.close(resolveServer)),
  };
}

function run(args, { cwd, home, apiUrl }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SOMEWHERE_API_URL: apiUrl,
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

test('apply-schema sends the schema source unchanged and prints an additive success', async (t) => {
  const api = await stub(() => ({
    status: 200,
    body: {
      ok: true,
      data: { applied: true, report_lines: ['Added table notes.', 'Declared owner access.'] },
    },
  }));
  t.after(api.close);
  const project = fixture();
  const result = await run(['db', 'apply-schema'], {
    ...project,
    apiUrl: api.apiUrl,
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(api.requests, [{
    method: 'POST',
    url: '/v1/db/schema/apply',
    body: {
      project_id: 'proj_apply_schema',
      schema_source: schemaSource,
      target: 'production',
    },
  }]);
  assert.match(result.stdout, /Database schema applied/);
  assert.match(result.stdout, /Added table notes/);
  assert.match(result.stdout, /Declared owner access/);
});

test('apply-schema preserves the planner refusal and has no confirmation bypass', async (t) => {
  const plannerMessage = 'Removing table notes requires removedTable("notes") in db/schema.ts. Nothing changed.';
  const api = await stub(() => ({
    status: 409,
    body: {
      ok: false,
      error: 'SCHEMA_DEPLOY_REFUSED',
      message: plannerMessage,
    },
  }));
  t.after(api.close);
  const project = fixture();
  const result = await run(['db', 'apply-schema'], {
    ...project,
    apiUrl: api.apiUrl,
  });

  assert.equal(result.status, 1);
  assert.equal(api.requests.length, 1);
  assert.equal('confirm_destructive' in api.requests[0].body, false);
  assert.match(result.stderr, new RegExp(plannerMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stdout + result.stderr, /--confirm-destructive/);
});

test('apply-schema prints an already-current result as a no-op', async (t) => {
  const api = await stub(() => ({
    status: 200,
    body: { ok: true, data: { applied: false, report_lines: ['Schema is already current.'] } },
  }));
  t.after(api.close);
  const project = fixture();
  const result = await run(['db', 'apply-schema'], {
    ...project,
    apiUrl: api.apiUrl,
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal('confirm_destructive' in api.requests[0].body, false);
  assert.match(result.stdout, /already matches/);
  assert.match(result.stdout, /Schema is already current/);
});

test('apply-schema help exposes source-marker safety, not a force flag', async () => {
  const project = fixture();
  const result = await run(['db', 'apply-schema', '--help'], {
    ...project,
    apiUrl: 'http://127.0.0.1:1/v1',
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /confirm-destructive|force/i);
});

test('a missing schema path fails before any platform request and names the path', async (t) => {
  const api = await stub(() => {
    throw new Error('request should not be made');
  });
  t.after(api.close);
  const project = fixture();
  const result = await run(['db', 'apply-schema', 'db/missing.ts'], {
    ...project,
    apiUrl: api.apiUrl,
  });

  assert.equal(result.status, 1);
  assert.equal(api.requests.length, 0);
  assert.match(result.stderr, /Could not read db\/missing\.ts/);
});
