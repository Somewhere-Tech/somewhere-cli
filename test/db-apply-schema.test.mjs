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

for (const args of [
  ['db', 'apply-schema'],
  ['db', 'apply-schema', 'db/missing.ts', '--project', 'another-project'],
  ['db', 'apply-schema', '--json'],
]) {
  test(`retired command refuses without any platform request: ${args.join(' ')}`, async (t) => {
    const api = await stub(() => { throw new Error('request should not be made'); });
    t.after(api.close);
    const result = await run(args, { ...fixture(), apiUrl: api.apiUrl });
    assert.equal(result.status, 1);
    assert.equal(api.requests.length, 0);
    const message = args.includes('--json') ? JSON.parse(result.stdout).message : result.stderr;
    assert.match(message, /db\/schema\.ts/);
    assert.match(message, /somewhere deploy.*app root.*complete app source.*preview/);
    assert.match(message, /Nothing was changed/);
    if (args.includes('--json')) assert.equal(JSON.parse(result.stdout).error, 'SCHEMA_APPLY_RETIRED');
    else assert.match(message, /SCHEMA_APPLY_RETIRED/);
  });
}

test('retirement remedy works before project linking or authentication', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sw-retired-unlinked-'));
  const result = await run(['db', 'apply-schema'], { cwd, home: cwd, apiUrl: 'http://127.0.0.1:1/v1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SCHEMA_APPLY_RETIRED/);
  assert.match(result.stderr, /complete app source/);
});

test('database help omits retired command while retaining database inspection and SQL export', async () => {
  const result = await run(['db', '--help'], { ...fixture(), apiUrl: 'http://127.0.0.1:1/v1' });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /apply-schema/);
  assert.match(result.stdout, /query/);
  assert.match(result.stdout, /dump/);
  assert.match(result.stdout, /tables/);
});
