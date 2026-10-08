import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('run carries per-run strings and rejects malformed or excessive args before networking', async () => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/run');
    assert.equal(req.method, 'POST');
    let raw = ''; for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: { result: 'ok', logs: [], duration_ms: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'sw-run-args-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ token: 'smt_fixture', user: { email: '', username: '' } }));
  const source = 'export default async (sw, args) => args;';
  writeFileSync(join(dir, 'script.js'), source);
  const cli = join(process.cwd(), 'dist/index.js');
  const run = flags => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'run', 'script.js', '--project', 'p', '--json', ...flags], { cwd: dir, env: { ...process.env, SOMEWHERE_CONFIG_DIR: dir, SOMEWHERE_RUNNER_URL: `http://127.0.0.1:${server.address().port}`, SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1' } });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => { stderr += chunk; }); child.on('close', status => resolve({ status, stderr }));
  });
  try {
    assert.equal((await run(['--arg', 'empty=', '--arg', 'equals=a=b', '--arg', 'unicode=é'])).status, 0);
    assert.deepEqual(bodies[0].args, { empty: '', equals: 'a=b', unicode: 'é' });
    assert.equal(bodies[0].code, source);
    assert.equal(bodies[0].include_env, false);
    assert.equal(bodies[0].session_id, undefined);
    assert.equal((await run([])).status, 0);
    assert.equal(Object.hasOwn(bodies[1], 'args'), false);
    const limit = 'é'.repeat(8186);
    assert.equal((await run(['--arg', 'value=' + limit])).status, 0);
    assert.equal((await run(Array.from({ length: 64 }, (_, i) => ['--arg', `a${i}=`]).flat())).status, 0);
    const count = bodies.length;
    for (const flags of [['--arg', 'x=1', '--arg', 'x=2'], ['--arg', 'x'], ['--arg', '=x'], ['--arg', 'bad-name=x'], ...['__proto__', 'prototype', 'constructor'].map(name => ['--arg', `${name}=x`]), ['--arg', 'value=' + limit + 'é'], Array.from({ length: 65 }, (_, i) => ['--arg', `a${i}=`]).flat()]) {
      const output = await run(flags);
      assert.equal(output.status, 1, output.stderr);
      assert.match(output.stderr, /--arg/);
      assert.equal(bodies.length, count);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
