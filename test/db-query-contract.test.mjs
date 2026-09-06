import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Actual built command, local HTTP server, isolated credentials/home. The
// response contains canonical data/changes; legacy rows is never required.
test('db query displays canonical rows/writes and preserves JSON and errors', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cli-db-contract-'));
  const requests = [];
  let reply;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  async function command(json = false) {
    const script = `
      import { Command } from 'commander';
      import { registerDb } from './dist/commands/db.js';
      import { saveConfig } from './dist/lib/config.js';
      saveConfig({ token: 'smt_fixture_only', user: { email: 'fixture@example.test' } });
      const p = new Command(); registerDb(p);
      await p.parseAsync(['node', 'somewhere', 'db', 'query', 'SELECT fixture', '--project', 'fixture-project', ...JSON.parse(process.env.FIXTURE_ARGS)]);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: home, USERPROFILE: home,
        SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
        FIXTURE_ARGS: JSON.stringify(json ? ['--json'] : []), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    assert.deepEqual(requests.at(-1), { path: '/v1/db/query', method: 'POST', auth: 'Bearer smt_fixture_only',
      body: { project_id: 'fixture-project', sql: 'SELECT fixture' } });
    return { status, stdout, stderr };
  }
  const payload = (data, changes = 0, last_row_id = null) => ({ data, count: data.length, changes, last_row_id });
  for (const [name, value, expected] of [
    ['read', payload([{ id: '9007199254740993', body: 'canonical-row' }]), /9007199254740993.*canonical-row/],
    ['empty read', payload([]), /OK.*no rows returned/],
    ['write', payload([], 3, '9223372036854775807'), /3 rows affected/],
    ['RETURNING', payload([{ id: 7, body: 'returned-row' }], 1, 7), /7.*returned-row/],
    ['canonical precedence', { ...payload([{ body: 'canonical-row' }]), rows: [{ body: 'wrong-alias' }], rows_affected: 99 }, /canonical-row/],
  ]) {
    await t.test(name, async () => {
      reply = { body: { ok: true, data: value } };
      const result = await command();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, expected);
      assert.doesNotMatch(result.stdout, /wrong-alias|99 rows affected/);
      const json = await command(true);
      assert.equal(json.status, 0, json.stderr);
      assert.deepEqual(JSON.parse(json.stdout), value, 'JSON preserves canonical metadata and any transport fields');
    });
  }
  for (const invalid of [null, {}, { rows: [], rows_affected: 3 }, { ...payload([]), data: null }, { ...payload([]), changes: '3' }]) {
    reply = { body: { ok: true, data: invalid } };
    const result = await command();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid database query response/);
    assert.doesNotMatch(result.stdout, /OK|rows affected/);
  }
  reply = { status: 409, body: { ok: false, error: 'QUERY_REJECTED', message: 'fixture query refusal' } };
  const denied = await command();
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /fixture query refusal/);
});
