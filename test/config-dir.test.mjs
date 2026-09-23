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

// The MCP bridge is launched by the host (Claude Code, Cursor), not by this
// CLI, so it only sees SOMEWHERE_CONFIG_DIR if the installed entry carries it.
// Without it the bridge would silently read the default ~/.somewhere login.
async function installHost(host, extraEnv) {
  const home = mkdtempSync(join(tmpdir(), 'sw-configdir-mcp-home-'));
  const child = spawn(process.execPath, [cliBin, 'mcp', 'install', host], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, SOMEWHERE_NO_NOTIFICATIONS: '1', ...extraEnv },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  const status = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(status, 0, stderr);
  return home;
}

test('mcp install carries SOMEWHERE_CONFIG_DIR into the host entry, and only when set', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'sw-configdir-mcp-root-')), 'cfg');
  const withOverride = { SOMEWHERE_CONFIG_DIR: root };
  const withoutOverride = { SOMEWHERE_CONFIG_DIR: '' };
  for (const [host, file] of [['claude-code', '.claude.json'], ['cursor', join('.cursor', 'mcp.json')]]) {
    const scoped = JSON.parse(readFileSync(join(await installHost(host, withOverride), file), 'utf8')).mcpServers.somewhere;
    assert.deepEqual(scoped, { command: 'somewhere', args: ['mcp'], env: { SOMEWHERE_CONFIG_DIR: root } }, host);
    const plain = JSON.parse(readFileSync(join(await installHost(host, withoutOverride), file), 'utf8')).mcpServers.somewhere;
    assert.deepEqual(plain, { command: 'somewhere', args: ['mcp'] }, `${host} default entry unchanged`);
  }
});
