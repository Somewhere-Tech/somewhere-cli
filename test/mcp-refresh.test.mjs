import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function writeConfig(home, token, refreshToken, accessExpiresAt) {
  const dir = join(home, '.somewhere');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    token,
    refresh_token: refreshToken,
    ...(accessExpiresAt ? { access_expires_at: accessExpiresAt } : {}),
    user: { email: 'mcp-refresh@example.com', username: '' },
  }) + '\n');
}

function startBridge(home, mcpUrl, apiUrl) {
  const child = spawn(process.execPath, [distIndex, 'mcp'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_MCP_URL: mcpUrl,
      SOMEWHERE_API_URL: apiUrl,
      CI: '1',
      SOMEWHERE_NO_NOTIFICATIONS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const waiters = [];
  let stderr = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const nextMessage = (predicate, timeoutMs = 5_000) => {
    const queuedIndex = messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out waiting for MCP response; stderr=${stderr}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };

  return {
    child,
    nextMessage,
    stderr: () => stderr,
    send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
    },
  };
}

function makeServers({ revokedRefresh = false } = {}) {
  const mcpAuthorizations = [];
  const apiCalls = [];
  const mcp = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const authorization = req.headers.authorization;
      mcpAuthorizations.push(authorization);
      res.setHeader('Content-Type', 'application/json');
      if (authorization === 'Bearer smt_expired') {
        res.statusCode = 401;
        res.setHeader(
          'WWW-Authenticate',
          'Bearer realm="somewhere.tech", error="invalid_token"',
        );
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'API key expired' },
        }));
        return;
      }
      const rpc = JSON.parse(body);
      res.statusCode = 200;
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: rpc.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'refresh-test', version: '1.0.0' },
            }
          : { tools: [] },
      }));
    });
  });

  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      apiCalls.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/keys/cli-pair/refresh') {
        setTimeout(() => {
          if (revokedRefresh) {
            res.statusCode = 401;
            res.end(JSON.stringify({
              ok: false,
              error: 'INVALID_REFRESH_TOKEN',
              message: 'Refresh token revoked.',
            }));
            return;
          }
          res.statusCode = 201;
          res.end(JSON.stringify({
            ok: true,
            data: {
              key: 'smt_renewed',
              refresh_token: 'smtr_rotated',
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          }));
        }, 40);
        return;
      }
      if (req.headers.authorization === 'Bearer smt_renewed') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          ok: true,
          data: { user: { email: 'mcp-refresh@example.com' } },
        }));
        return;
      }
      res.statusCode = 401;
      res.end(JSON.stringify({
        ok: false,
        error: 'API_KEY_EXPIRED',
        message: 'Access key expired.',
      }));
    });
  });

  return { mcp, api, mcpAuthorizations, apiCalls };
}

test('stdio MCP expiry renews once, reconnects, retries concurrent calls, and continues', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-mcp-refresh-home-'));
  writeConfig(home, 'smt_expired', 'smtr_valid');
  const servers = makeServers();
  await Promise.all([listen(servers.mcp), listen(servers.api)]);
  const bridge = startBridge(
    home,
    `http://127.0.0.1:${servers.mcp.address().port}/mcp`,
    `http://127.0.0.1:${servers.api.address().port}`,
  );

  try {
    bridge.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-refresh-test', version: '1.0.0' },
      },
    });
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const [initialized, tools] = await Promise.all([
      bridge.nextMessage((message) => message.id === 1),
      bridge.nextMessage((message) => message.id === 2),
    ]);
    assert.equal(initialized.result.serverInfo.name, 'refresh-test');
    assert.deepEqual(tools.result.tools, []);

    assert.equal(
      servers.apiCalls.filter((call) => call.url === '/keys/cli-pair/refresh').length,
      1,
      'concurrent MCP 401s must share one refresh exchange',
    );
    assert.ok(
      servers.mcpAuthorizations.filter((value) => value === 'Bearer smt_expired').length >= 1,
    );
    assert.ok(
      servers.mcpAuthorizations.filter((value) => value === 'Bearer smt_renewed').length >= 2,
      'both failed calls must replay with the renewed key',
    );

    const saved = JSON.parse(
      readFileSync(join(home, '.somewhere', 'config.json'), 'utf8'),
    );
    assert.equal(saved.token, 'smt_renewed');
    assert.equal(saved.refresh_token, 'smtr_rotated');
    assert.equal(saved.access_expires_at, '2099-01-01T00:00:00.000Z');

    bridge.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const continued = await bridge.nextMessage((message) => message.id === 3);
    assert.deepEqual(continued.result.tools, []);
    assert.equal(bridge.child.exitCode, null, 'bridge remains alive after renewal');
  } finally {
    bridge.child.kill('SIGTERM');
    await Promise.all([close(servers.mcp), close(servers.api)]);
  }
});

test('stdio MCP renews before the recorded access expiry without replaying upstream', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-mcp-preemptive-home-'));
  writeConfig(
    home,
    'smt_expired',
    'smtr_valid',
    new Date(Date.now() + 30_000).toISOString(),
  );
  const servers = makeServers();
  await Promise.all([listen(servers.mcp), listen(servers.api)]);
  const bridge = startBridge(
    home,
    `http://127.0.0.1:${servers.mcp.address().port}/mcp`,
    `http://127.0.0.1:${servers.api.address().port}`,
  );

  try {
    bridge.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    const tools = await bridge.nextMessage((message) => message.id === 4);
    assert.deepEqual(tools.result.tools, []);
    assert.deepEqual(
      servers.mcpAuthorizations,
      ['Bearer smt_renewed'],
      'the expiring access key must be replaced before forwarding the MCP call',
    );
    assert.equal(
      servers.apiCalls.filter((call) => call.url === '/keys/cli-pair/refresh').length,
      1,
    );

    bridge.send({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    const continued = await bridge.nextMessage((message) => message.id === 5);
    assert.deepEqual(continued.result.tools, []);
    assert.equal(bridge.child.exitCode, null);
  } finally {
    bridge.child.kill('SIGTERM');
    await Promise.all([close(servers.mcp), close(servers.api)]);
  }
});

test('stdio MCP with a revoked refresh credential ends cleanly without leaking secrets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-mcp-revoked-home-'));
  writeConfig(
    home,
    'smt_expired',
    'smtr_revoked_secret',
    new Date(Date.now() + 30_000).toISOString(),
  );
  const servers = makeServers({ revokedRefresh: true });
  await Promise.all([listen(servers.mcp), listen(servers.api)]);
  const bridge = startBridge(
    home,
    `http://127.0.0.1:${servers.mcp.address().port}/mcp`,
    `http://127.0.0.1:${servers.api.address().port}`,
  );

  try {
    bridge.send({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} });
    const fatal = await bridge.nextMessage((message) => message.id === null && message.error);
    assert.equal(fatal.error.code, -32001);
    assert.match(fatal.error.message, /session|renew|login/i);
    const exitCode = await new Promise((resolve) => bridge.child.once('close', resolve));
    assert.equal(exitCode, 1);

    const output = `${JSON.stringify(fatal)}\n${bridge.stderr()}`;
    assert.doesNotMatch(output, /smt_expired|smtr_revoked_secret/);
    assert.equal(
      servers.apiCalls.filter((call) => call.url === '/keys/cli-pair/refresh').length,
      1,
    );
  } finally {
    if (bridge.child.exitCode === null) bridge.child.kill('SIGTERM');
    await Promise.all([close(servers.mcp), close(servers.api)]);
  }
});
