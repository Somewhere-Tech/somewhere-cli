import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { relayIpv6Loopback } from '../dist/lib/frontend-dev.js';

// Base44 head-to-head 2026-09-25, item 8: the small CLI rough edges. Each case
// pins the fixed behaviour and the legitimate neighbour that must not change.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, SOMEWHERE_MCP_URL: 'http://127.0.0.1:1/mcp', ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function home() {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-rough-home-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_rough_test',
    user: { email: 'rough@example.com', username: 'rough' },
  }) + '\n');
  return HOME;
}

function linkedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-rough-linked-'));
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_linked',
    name: 'linked-app',
    subdomain: 'linked-app',
  }) + '\n');
  writeFileSync(join(dir, 'script.js'), 'export default async function () { return 1; }\n');
  return dir;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/** One fake platform: REST routes plus the MCP tool endpoint, recording every call. */
async function withPlatform(fn) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const parsed = body ? JSON.parse(body) : undefined;
      if (url.pathname.startsWith('/mcp')) {
        if (parsed.method === 'initialize') {
          sendJson(res, 200, { jsonrpc: '2.0', id: parsed.id, result: {
            protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rough', version: '1.0.0' },
          } });
          return;
        }
        if (parsed.method === 'tools/call') {
          calls.push({ tool: parsed.params.name, arguments: parsed.params.arguments });
          sendJson(res, 200, { jsonrpc: '2.0', id: parsed.id, result: {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { period: '30d', totals: { deploys: 27 } } }) }],
          } });
          return;
        }
        sendJson(res, 200, { jsonrpc: '2.0', id: parsed.id, result: {} });
        return;
      }
      calls.push({ method: req.method, path: url.pathname, body: parsed });
      if (req.method === 'GET' && url.pathname === '/v1/projects/proj_linked') {
        sendJson(res, 200, { ok: true, data: { id: 'proj_linked', name: 'linked-app', status: 'deployed' } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/env') {
        const warnings = parsed.key.startsWith('VITE_')
          ? [`${parsed.key} starts with VITE_/REACT_APP_, so it is compiled into your public browser code where any visitor can read it.`]
          : undefined;
        sendJson(res, 201, { ok: true, data: { key: parsed.key, set: true, ...(warnings ? { warnings } : {}) } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/run') {
        sendJson(res, 200, { ok: true, data: { result: 1, logs: [], duration_ms: 3 } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/fs/proj_linked/') {
        sendJson(res, 200, { ok: true, data: { path: '/', type: 'directory', entries: [], next_cursor: null } });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: `${req.method} ${url.pathname}` });
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({
      calls,
      env: {
        HOME: home(),
        SOMEWHERE_API_URL: `${base}/v1`,
        SOMEWHERE_MCP_URL: `${base}/mcp`,
        SOMEWHERE_RUNNER_URL: base,
      },
    });
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

test('project view with no argument reads the linked project; unlinked it asks for one', async () => {
  await withPlatform(async ({ calls, env }) => {
    const linked = await run(['project', 'view', '--json'], { cwd: linkedDir(), env });
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(JSON.parse(linked.stdout).id, 'proj_linked');
    assert.deepEqual(calls.map((c) => c.path), ['/v1/projects/proj_linked']);

    calls.length = 0;
    const unlinked = await run(['project', 'view', '--json'], { cwd: mkdtempSync(join(tmpdir(), 'sw-rough-bare-')), env });
    assert.notEqual(unlinked.status, 0);
    assert.deepEqual(JSON.parse(unlinked.stdout), {
      ok: false,
      error: 'CLI_ERROR',
      message: 'No project. Pass --project <slug-or-id> or run from a linked directory.',
    });
    assert.equal(calls.length, 0, 'no request for a project nobody named');
  });
});

test('usage with no argument reports the linked project; outside one, the account', async () => {
  await withPlatform(async ({ calls, env }) => {
    const linked = await run(['usage'], { cwd: linkedDir(), env });
    assert.equal(linked.status, 0, linked.stderr);
    assert.match(linked.stdout, /Deploys\s+27/);
    const unlinked = await run(['usage'], { cwd: mkdtempSync(join(tmpdir(), 'sw-rough-bare-')), env });
    assert.equal(unlinked.status, 0, unlinked.stderr);
    assert.deepEqual(calls, [
      { tool: 'usage_summary', arguments: { project_id: 'proj_linked', period: '30d' } },
      { tool: 'usage_summary', arguments: { period: '30d' } },
    ]);
  });
});

test('env set says "set" and prints the platform warning without --json', async () => {
  await withPlatform(async ({ env }) => {
    const cwd = linkedDir();
    const publicKey = await run(['env', 'set', 'VITE_API_BASE', 'https://example.com'], { cwd, env });
    assert.equal(publicKey.status, 0, publicKey.stderr);
    assert.match(publicKey.stdout, /VITE_API_BASE set/);
    assert.doesNotMatch(publicKey.stdout, /updated/);
    assert.match(publicKey.stdout, /compiled into your public browser code/);

    const serverKey = await run(['env', 'set', 'STRIPE_KEY', 'sk_test_x'], { cwd, env });
    assert.equal(serverKey.status, 0, serverKey.stderr);
    assert.match(serverKey.stdout, /STRIPE_KEY set/);
    assert.doesNotMatch(serverKey.stdout, /public browser code/);
  });
});

test('run --timeout above the limit says it was capped; within the limit it is silent', async () => {
  await withPlatform(async ({ calls, env }) => {
    const cwd = linkedDir();
    const capped = await run(['run', 'script.js', '--timeout', '60000'], { cwd, env });
    assert.equal(capped.status, 0, capped.stderr);
    assert.match(capped.stdout, /--timeout 60000 is above the 30000 ms limit for `somewhere run`; the script runs with 30000 ms\./);

    const cappedJson = await run(['run', 'script.js', '--timeout', '60000', '--json'], { cwd, env });
    assert.equal(cappedJson.status, 0, cappedJson.stderr);
    JSON.parse(cappedJson.stdout);
    assert.match(cappedJson.stderr, /above the 30000 ms limit/);

    const within = await run(['run', 'script.js', '--timeout', '5000'], { cwd, env });
    assert.equal(within.status, 0, within.stderr);
    assert.doesNotMatch(within.stdout + within.stderr, /limit/);

    assert.deepEqual(calls.map((c) => c.body.timeout_ms), [30000, 30000, 5000]);
  });
});

test('fs ls / lists the root; reading / as a file is still refused', async () => {
  await withPlatform(async ({ calls, env }) => {
    const cwd = linkedDir();
    const root = await run(['fs', 'ls', '/', '--json'], { cwd, env });
    assert.equal(root.status, 0, root.stdout + root.stderr);
    assert.equal(JSON.parse(root.stdout).path, '/');
    const bare = await run(['fs', 'ls', '--json'], { cwd, env });
    assert.equal(bare.status, 0, bare.stdout + bare.stderr);
    assert.deepEqual(calls.map((c) => c.path), ['/v1/fs/proj_linked/', '/v1/fs/proj_linked/']);

    const get = await run(['fs', 'get', '/', join(cwd, 'out.bin'), '--json'], { cwd, env });
    assert.notEqual(get.status, 0);
    assert.equal(JSON.parse(get.stdout).error, 'INVALID_REMOTE_PATH');
  });
});

test('preview help names no hand-typed plan list and points at pricing', async () => {
  const help = await run(['preview', '--help'], { cwd: repoRoot, env: { HOME: home() } });
  assert.equal(help.status, 0, help.stderr);
  const text = help.stdout.replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /Pro and Scale|Pro\/Scale/);
  assert.match(text, /https:\/\/somewhere\.tech\/pricing/);
});

test('email send help makes --from optional', async () => {
  const help = await run(['email', 'send', '--help'], { cwd: repoRoot, env: { HOME: home() } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout.replace(/\s+/g, ' '), /--from <sender> Sender on a verified project domain; omit to send from the project's managed sender/);
});

test('the IPv6 loopback reaches a server bound to 127.0.0.1, and nothing else is opened', async (t) => {
  const server = createServer((_req, res) => res.end('from-ipv4'));
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  const relay = await relayIpv6Loopback(port);
  try {
    if (!relay) {
      t.skip('this machine has no IPv6 loopback');
      return;
    }
    assert.equal(relay.address().address, '::1', 'loopback only, never a wildcard address');
    const body = await new Promise((resolvePromise, rejectPromise) => {
      httpRequest({ host: '::1', port, path: '/', family: 6 }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolvePromise(text));
      }).on('error', rejectPromise).end();
    });
    assert.equal(body, 'from-ipv4');
  } finally {
    await new Promise((resolvePromise) => (relay ? relay.close(() => resolvePromise()) : resolvePromise()));
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
