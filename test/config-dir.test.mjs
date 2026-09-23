import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// SOMEWHERE_CONFIG_DIR selects the CLI config root without changing HOME, so a
// fixture identity never reads or writes the developer's own ~/.somewhere.
const cliBin = fileURLToPath(new URL('../bin/somewhere.js', import.meta.url));

test('SOMEWHERE_CONFIG_DIR is the only config root the CLI reads and writes', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: { user: { id: 'u1', email: 'fixture@example.test' } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const home = mkdtempSync(join(tmpdir(), 'sw-configdir-home-'));
    mkdirSync(join(home, '.somewhere'), { mode: 0o700 });
    writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_home_identity' }));
    const root = join(mkdtempSync(join(tmpdir(), 'sw-configdir-root-')), 'cfg');
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ token: 'smt_fixture_identity' }), { mode: 0o600 });

    const child = spawn(process.execPath, [cliBin, 'whoami', '--json'], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SOMEWHERE_CONFIG_DIR: root,
        SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}`,
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    const status = await new Promise((resolve) => child.on('close', resolve));
    const result = { status, stderr };
    assert.equal(result.status, 0, result.stderr);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((auth) => auth === 'Bearer smt_fixture_identity'), JSON.stringify(seen));
    assert.ok(existsSync(join(root, 'last-run.json')), 'last-run record lands in the explicit root');
    assert.equal(existsSync(join(home, '.somewhere', 'last-run.json')), false);
    assert.equal(existsSync(join(home, '.somewhere', 'device.json')), false);
    assert.equal(JSON.parse(readFileSync(join(home, '.somewhere', 'config.json'), 'utf8')).token, 'smt_home_identity');
  } finally {
    server.close();
  }
});
