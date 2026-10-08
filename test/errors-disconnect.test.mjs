import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// tsk_d0c55c3c: collapse only classified client disconnects in human output.
test('errors collapses recognized disconnects while preserving ambiguous outcomes and raw JSON', async () => {
  const base = { endpoint: '/api/poll', method: 'GET', status_code: 499, source: 'function', kind: 'refusal', created_at: new Date().toISOString() };
  const explicit = { ...base, id: 'explicit', error_code: 'CLIENT_DISCONNECTED', error_message: 'Caller closed connection' };
  const legacy = { ...base, id: 'legacy', error_code: 'HTTP_499', error_message: 'CLIENT_DISCONNECTED: GET /api/poll — caller left' };
  const keep = [
    { ...base, id: 'ordinary499', error_code: 'HTTP_499', error_message: 'App chose this outcome' },
    { ...legacy, id: 'noKind', kind: null },
    { ...legacy, id: 'noSource', source: null },
    { ...legacy, id: 'api', source: 'api' },
    { ...legacy, id: 'exception499', kind: 'exception' },
    { ...legacy, id: 'nearPrefix', error_message: 'CLIENT_DISCONNECTEDISH: real failure' },
    { ...legacy, id: 'failure500', status_code: 500, kind: 'exception', error_message: 'Handler failed after client left' },
  ];
  let rows = [explicit, legacy, ...keep];
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/errors/recent?project_id=fixture&limit=20');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: { errors: rows } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = mkdtempSync(join(tmpdir(), 'sw-disconnect-config-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-disconnect-app-'));
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: '', username: '' } }));
  const cli = join(process.cwd(), 'dist/index.js');
  const run = flags => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'errors', 'fixture', ...flags], { cwd: dir, env: { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  try {
    let out = await run([]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /2 client disconnects collapsed.*--json/);
    assert.doesNotMatch(out.stdout, /Caller closed connection/);
    assert.match(out.stdout, /App chose this outcome/);
    assert.match(out.stdout, /Handler failed after client left/);
    assert.match(out.stdout, /CLIENT_DISCONNECTEDISH/);
    assert.match(out.stdout, /3 exceptions, 4 refused on purpose/);
    out = await run(['--json']);
    assert.deepEqual(JSON.parse(out.stdout), rows);
    out = await run(['--exceptions', '--json']);
    assert.deepEqual(JSON.parse(out.stdout), rows.filter(row => row.kind !== 'refusal'));
    out = await run(['--exceptions']);
    assert.doesNotMatch(out.stdout, /collapsed/);
    assert.match(out.stdout, /3 exceptions/);
    rows = [explicit, legacy];
    out = await run([]);
    assert.match(out.stdout, /2 client disconnects collapsed.*--json/);
    assert.doesNotMatch(out.stdout, /No errors|Nothing broke|exception/);
    rows = [explicit]; out = await run([]);
    assert.match(out.stdout, /1 client disconnect collapsed/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(config, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
  }
});
