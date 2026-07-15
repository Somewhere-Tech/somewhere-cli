import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeConfig(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_platform_help_test',
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
