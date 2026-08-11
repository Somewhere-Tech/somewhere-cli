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
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function cliInvocation(args) {
  const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
  return sourceRunner
    ? { command: sourceRunner, args: [sourceIndex, ...args] }
    : { command: process.execPath, args: [distIndex, ...args] };
}

function run(args, env) {
  return new Promise((resolvePromise) => {
    const invocation = cliInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
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
    token: 'smt_platform_tools_test',
    user: { email: 'tools@example.com', username: 'tools' },
  }) + '\n');
}

function sendJson(res, payload) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('generic and Tier-1 commands are thin adapters over the full MCP tool surface', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-platform-tools-home-'));
  writeConfig(home);
  const calls = [];
  const urls = [];
  const tools = [
    { name: 'tasks_get', description: 'Get one task', inputSchema: { type: 'object' } },
    { name: 'tasks_list', description: 'List tasks', inputSchema: { type: 'object' } },
    { name: 'feedback', description: 'Project feedback', inputSchema: { type: 'object' } },
    { name: 'project_grep', description: 'Search source', inputSchema: { type: 'object' } },
    { name: 'usage_summary', description: 'Usage totals', inputSchema: { type: 'object' } },
  ];

  const server = createServer((req, res) => {
    urls.push(req.url);
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
            serverInfo: { name: 'test-platform-tools', version: '1.0.0' },
          },
        });
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
        return;
      }
      if (rpc.method === 'tools/list') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: { tools } });
        return;
      }
      if (rpc.method === 'tools/call') {
        calls.push({ name: rpc.params.name, arguments: rpc.params.arguments });
        const data = rpc.params.name === 'tasks_list'
          ? []
          : rpc.params.name === 'feedback'
            ? { feedback: [] }
            : rpc.params.name === 'project_grep'
              ? { matches: [], truncated: false, files_searched: 3 }
              : rpc.params.name === 'usage_summary'
                ? { period: '7d', totals: { deploys: 1 } }
                : { id: 'tsk_1', title: 'Test task' };
        sendJson(res, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] },
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
    const listed = await run(['call', '--list', '--json'], env);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).count, tools.length);

    const commands = [
      ['call', 'tasks_get', '{"project_id":"platform","task_id":"tsk_1"}', '--json'],
      ['tasks', 'list', '--project', 'platform', '--limit', '2', '--json'],
      ['feedback', 'list', '--project', 'platform', '--json'],
      ['grep', 'TODO', '--project', 'platform', '--max-results', '4', '--json'],
      ['usage', 'platform', '--period', '7d', '--json'],
    ];
    for (const command of commands) {
      const result = await run(command, env);
      assert.equal(result.status, 0, `${command.join(' ')}\n${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).ok, true);
    }

    assert.deepEqual(calls, [
      { name: 'tasks_get', arguments: { project_id: 'platform', task_id: 'tsk_1' } },
      { name: 'tasks_list', arguments: { project_id: 'platform', limit: 2 } },
      { name: 'feedback', arguments: { project_id: 'platform' } },
      { name: 'project_grep', arguments: { project_id: 'platform', pattern: 'TODO', env: 'prod', max_results: 4 } },
      { name: 'usage_summary', arguments: { project_id: 'platform', period: '7d' } },
    ]);
    assert.ok(urls.every((url) => url?.includes('groups=all')));
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
