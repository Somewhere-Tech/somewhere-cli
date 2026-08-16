import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        CI: '1',
        NO_COLOR: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('status prints the canonical serving host returned as prod_fallback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-status-output-home-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_status_output',
    user: { email: 'status@example.com', username: 'status' },
  }) + '\n');

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && url.pathname === '/v1/projects/proj-host') {
        sendJson(res, { ok: true, data: {
          name: 'Serving Fixture',
          status: 'deployed',
          subdomain: 'stale-slug',
          updated_at: new Date().toISOString(),
        } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects/proj-host/urls') {
        sendJson(res, { ok: true, data: {
          prod: null,
          prod_fallback: 'https://canonical-serving.somewhere.site',
        } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/hosted/status') {
        sendJson(res, { ok: false, error: 'NOT_FOUND', message: 'No workspace' }, 404);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/mcp') {
        const rpc = JSON.parse(body);
        if (rpc.method === 'initialize') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'status-output-test', version: '1.0.0' },
            },
          });
          return;
        }
        if (rpc.method === 'notifications/initialized') {
          sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
          return;
        }
        if (rpc.method === 'tools/call') {
          assert.equal(rpc.params.name, 'deploy_status');
          assert.deepEqual(rpc.params.arguments, { project_id: 'proj-host' });
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  data: { prod_version: 7, in_sync: true },
                }),
              }],
            },
          });
          return;
        }
      }
      sendJson(res, { ok: false, error: 'NOT_FOUND', message: `${req.method} ${url.pathname}` }, 404);
    });
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(['status', 'proj-host'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
      SOMEWHERE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /URL: https:\/\/canonical-serving\.somewhere\.site/);
    assert.doesNotMatch(result.stdout, /stale-slug\.somewhere\.tech/);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('status falls back to the project .site host when URL lookup fails', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-status-fallback-home-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_status_fallback',
    user: { email: 'status@example.com', username: 'status' },
  }) + '\n');

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && url.pathname === '/v1/projects/proj-host') {
        sendJson(res, { ok: true, data: {
          name: 'Serving Fixture',
          status: 'deployed',
          subdomain: 'fallback-slug',
          slug: 'fallback-slug',
          updated_at: new Date().toISOString(),
        } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects/proj-host/urls') {
        sendJson(res, { ok: false, error: 'TEMPORARY_URL_FAILURE', message: 'try again' }, 503);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/hosted/status') {
        sendJson(res, { ok: false, error: 'NOT_FOUND', message: 'No workspace' }, 404);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/mcp') {
        const rpc = JSON.parse(body);
        if (rpc.method === 'initialize') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'status-output-test', version: '1.0.0' },
            },
          });
          return;
        }
        if (rpc.method === 'notifications/initialized') {
          sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
          return;
        }
        if (rpc.method === 'tools/call') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  data: { prod_version: 7, in_sync: true },
                }),
              }],
            },
          });
          return;
        }
      }
      sendJson(res, { ok: false, error: 'NOT_FOUND', message: `${req.method} ${url.pathname}` }, 404);
    });
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(['status', 'proj-host'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
      SOMEWHERE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /URL: https:\/\/fallback-slug\.somewhere\.site/);
    assert.doesNotMatch(result.stdout, /fallback-slug\.somewhere\.tech/);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
