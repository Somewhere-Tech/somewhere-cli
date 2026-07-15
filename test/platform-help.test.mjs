import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeConfig(home, token = 'smt_platform_help_test', refreshToken) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    user: { email: 'help@example.com', username: 'help' },
  }) + '\n');
}

function sendJson(res, payload) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('advisor, MCP docs topics, and catalog use the authenticated platform help surface', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-platform-help-home-'));
  writeConfig(home);
  const calls = [];
  const catalog = {
    categories: {
      db: { summary: 'Database tools', aliases: ['sql'], tools: ['db_query', 'db_migrate'] },
      help: { summary: 'Platform help', aliases: ['manual'], tools: ['catalog', 'docs', 'advisor'] },
    },
    total_tools: 5,
    next_step: 'Read docs before building.',
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      if (rpc.method === 'initialize') {
        sendJson(res, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'test-platform-help', version: '1.0.0' },
          },
        });
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
        return;
      }
      if (rpc.method === 'tools/call') {
        calls.push({
          name: rpc.params.name,
          arguments: rpc.params.arguments,
          authorization: req.headers.authorization,
          userAgent: req.headers['user-agent'],
        });
        const text = rpc.params.name === 'advisor'
          ? 'Use `sw.db.query` for this.'
          : rpc.params.name === 'docs'
            ? '# sw.db\n\nDatabase reference.'
            : JSON.stringify(catalog, null, 2);
        sendJson(res, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text }] },
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  const env = {
    HOME: home,
    USERPROFILE: home,
    SOMEWHERE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
  };

  try {
    const advisor = await run(['advisor', 'How should I store notes?', '--json'], env);
    assert.equal(advisor.status, 0, advisor.stderr);
    assert.deepEqual(JSON.parse(advisor.stdout), {
      question: 'How should I store notes?',
      answer: 'Use `sw.db.query` for this.',
    });

    const docs = await run(['docs', 'sw.db', '--json'], env);
    assert.equal(docs.status, 0, docs.stderr);
    assert.deepEqual(JSON.parse(docs.stdout), {
      topic: 'sw.db',
      content: '# sw.db\n\nDatabase reference.',
    });

    const catalogJson = await run(['catalog', '--json'], env);
    assert.equal(catalogJson.status, 0, catalogJson.stderr);
    assert.deepEqual(JSON.parse(catalogJson.stdout), catalog);

    const catalogHuman = await run(['catalog'], env);
    assert.equal(catalogHuman.status, 0, catalogHuman.stderr);
    assert.match(catalogHuman.stdout, /Platform tool catalog — 5 tools/);
    assert.match(catalogHuman.stdout, /db_query, db_migrate/);

    assert.deepEqual(calls.map((call) => [call.name, call.arguments]), [
      ['advisor', { question: 'How should I store notes?' }],
      ['docs', { topic: 'sw.db' }],
      ['catalog', {}],
      ['catalog', {}],
    ]);
    assert.ok(calls.every((call) => call.authorization === 'Bearer smt_platform_help_test'));
    assert.ok(calls.every((call) => call.userAgent?.includes('somewhere-cli')));
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('platform help refreshes an expired access key after an MCP 401 and retries once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-platform-help-refresh-home-'));
  writeConfig(home, 'smt_expired', 'smtr_valid');
  const mcpAuth = [];
  const apiCalls = [];

  const mcpServer = createServer((req, res) => {
    const authorization = req.headers.authorization;
    mcpAuth.push(authorization);
    if (authorization === 'Bearer smt_expired') {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'API_KEY_EXPIRED', message: 'expired' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      if (rpc.method === 'initialize') {
        sendJson(res, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'test-platform-help-refresh', version: '1.0.0' },
          },
        });
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
        return;
      }
      sendJson(res, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { content: [{ type: 'text', text: 'Refreshed advisor response.' }] },
      });
    });
  });

  const apiServer = createServer((req, res) => {
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
        res.statusCode = 201;
        res.end(JSON.stringify({
          ok: true,
          data: { key: 'smt_refreshed', refresh_token: 'smtr_rotated' },
        }));
        return;
      }
      if (req.headers.authorization === 'Bearer smt_refreshed') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, data: { user: { email: 'help@example.com' } } }));
        return;
      }
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'API_KEY_EXPIRED', message: 'expired' }));
    });
  });

  await Promise.all([
    new Promise((resolvePromise) => mcpServer.listen(0, '127.0.0.1', resolvePromise)),
    new Promise((resolvePromise) => apiServer.listen(0, '127.0.0.1', resolvePromise)),
  ]);
  const mcpPort = mcpServer.address().port;
  const apiPort = apiServer.address().port;

  try {
    const advisor = await run(['advisor', 'Can my session refresh?', '--json'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`,
      SOMEWHERE_API_URL: `http://127.0.0.1:${apiPort}`,
    });
    assert.equal(advisor.status, 0, advisor.stderr);
    assert.deepEqual(JSON.parse(advisor.stdout), {
      question: 'Can my session refresh?',
      answer: 'Refreshed advisor response.',
    });
    assert.deepEqual(apiCalls.map((call) => call.url), [
      '/auth/whoami',
      '/keys/cli-pair/refresh',
      '/auth/whoami',
    ]);
    assert.equal(apiCalls[1].body.refresh_token, 'smtr_valid');
    assert.equal(mcpAuth[0], 'Bearer smt_expired');
    assert.ok(mcpAuth.slice(1).every((auth) => auth === 'Bearer smt_refreshed'));
    const config = JSON.parse(readFileSync(join(home, '.somewhere', 'config.json'), 'utf8'));
    assert.equal(config.token, 'smt_refreshed');
    assert.equal(config.refresh_token, 'smtr_rotated');
  } finally {
    await Promise.all([
      new Promise((resolvePromise) => mcpServer.close(resolvePromise)),
      new Promise((resolvePromise) => apiServer.close(resolvePromise)),
    ]);
  }
});
