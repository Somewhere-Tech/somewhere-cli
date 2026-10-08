import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// tsk_3c455b0d: platform-generated query diagnostics must not read as app failures.
test('errors labels generated diagnostics while preserving real app and API failures', async () => {
  const base = { method: 'POST', status_code: 500, error_code: 'INTERNAL_ERROR',
    error_message: 'DATABASE_ERROR: Network connection lost', kind: 'exception', created_at: new Date().toISOString() };
  const platform = { ...base, id: 'platform', source: 'api', endpoint: '/v1/db/query-observations', trace_id: 'trace-platform' };
  const app = { ...base, id: 'app', source: 'server', endpoint: '/api/save', stack: 'save.ts:12' };
  const functionRow = { ...base, id: 'function', source: 'function', endpoint: '/v1/db/query-observations' };
  const api = { ...base, id: 'api', source: 'api', endpoint: '/v1/db/query' };
  const read = { ...base, id: 'read', source: 'api', method: 'GET', endpoint: '/v1/db/query-observations' };
  const refused = { ...base, id: 'refused', source: 'api', status_code: 403, kind: 'refusal', endpoint: '/v1/db/query-observations' };
  const legacy = { ...base, id: 'legacy', endpoint: '/v1/db/query-observations' };
  let rows = [platform, app, functionRow, api, read, refused, legacy];
  const requests = [];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/errors/recent?project_id=fixture&limit=20') {
      requests.push(req.url);
      assert.equal(req.headers.authorization, 'Bearer smt_fixture');
      res.end(JSON.stringify({ ok: true, data: { errors: rows } }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', message: req.url }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = mkdtempSync(join(tmpdir(), 'sw-errors-origin-config-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-errors-origin-app-'));
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: '', username: '' } }));
  const cli = join(process.cwd(), 'dist/index.js');
  const run = flags => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'errors', 'fixture', ...flags], { cwd: dir, env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: config,
      SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  try {
    let out = await run([]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /platform diagnostic\s+500\s+POST \/v1\/db\/query-observations/);
    assert.match(out.stdout, /exception\s+500\s+POST \/api\/save/);
    assert.match(out.stdout, /5 exceptions, 1 refused on purpose, 1 platform diagnostic/);
    assert.match(out.stdout, /DATABASE_ERROR: Network connection lost/);

    out = await run(['--json']);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), [{ ...platform, diagnostic_origin: 'platform' }, app, functionRow, api, read, refused, legacy]);

    out = await run(['--exceptions', '--json']);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), [{ ...platform, diagnostic_origin: 'platform' }, app, functionRow, api, read, legacy]);

    rows = [platform];
    out = await run(['--exceptions']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /0 exceptions, 1 platform diagnostic/);
    assert.doesNotMatch(out.stdout, /No errors|Nothing broke/);

    rows = [refused];
    out = await run(['--exceptions']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Nothing broke.*1 request.*refused on purpose/);
    assert.equal(requests.length, 5);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(config, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
