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
    { name: 'cron_list', description: 'List scheduled triggers', inputSchema: { type: 'object' } },
    { name: 'cron_create', description: 'Create a scheduled trigger', inputSchema: { type: 'object' } },
    { name: 'cron_update', description: 'Update a scheduled trigger', inputSchema: { type: 'object' } },
    { name: 'cron_delete', description: 'Delete a scheduled trigger', inputSchema: { type: 'object' } },
    { name: 'email_send', description: 'Send transactional email', inputSchema: { type: 'object' } },
    { name: 'email_test_inbox', description: 'Read test inbox', inputSchema: { type: 'object' } },
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
        if (rpc.params.name === 'email_test_inbox' && rpc.params.arguments.address === 'old@platform.test.somewhere.site') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Unknown tool: email_test_inbox' }],
            },
          });
          return;
        }
        if (rpc.params.name === 'email_test_inbox' && rpc.params.arguments.address === 'real@example.com') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({
                error: 'VALIDATION_ERROR',
                message: "address must belong to this project's test inbox: <anything>@platform.test.somewhere.site.",
              }) }],
            },
          });
          return;
        }
        const data = rpc.params.name === 'tasks_list'
          ? []
          : rpc.params.name === 'feedback'
            ? { feedback: [] }
            : rpc.params.name === 'project_grep'
              ? { matches: [], truncated: false, files_searched: 3 }
              : rpc.params.name === 'usage_summary'
                ? { period: '7d', totals: { deploys: 1 } }
                : rpc.params.name === 'cron_list'
                  ? { crons: [] }
                  : rpc.params.name.startsWith('cron_')
                    ? { id: 'cron_1' }
                    : rpc.params.name === 'email_send'
                      ? { id: 'email_1' }
                    : rpc.params.name === 'email_test_inbox'
                      ? {
                          address: 'robot@platform.test.somewhere.site',
                          messages: [{
                            id: 'testmail_1',
                            to: 'robot@platform.test.somewhere.site',
                            subject: 'Sign in',
                            html: '<a href="https://platform.somewhere.site/auth?token=magic">Sign in</a>',
                            text: 'Sign in',
                            magic_link: 'https://platform.somewhere.site/auth?token=magic',
                            created_at: '2026-09-03T20:00:00.000Z',
                          }],
                          limit: 20,
                        }
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
      ['cron', 'list', '--project', 'platform', '--json'],
      ['cron', 'create', '0 8 * * *', '/api/digest', '--project', 'platform', '--name', 'Daily digest', '--payload', '{"kind":"digest"}', '--json'],
      ['cron', 'update', 'cron_1', '--disable', '--json'],
      ['cron', 'delete', 'cron_1', '--json'],
      ['email', 'send', 'alice@example.com', '--project', 'platform', '--from', 'hello@example.com', '--subject', 'Welcome', '--text', 'You are in.', '--json'],
      ['email', 'test-inbox', 'robot@platform.test.somewhere.site', '--project', 'platform', '--json'],
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
      { name: 'cron_list', arguments: { project_id: 'platform' } },
      { name: 'cron_create', arguments: { project_id: 'platform', schedule: '0 8 * * *', handler: '/api/digest', name: 'Daily digest', payload: { kind: 'digest' } } },
      { name: 'cron_update', arguments: { cron_id: 'cron_1', enabled: false } },
      { name: 'cron_delete', arguments: { cron_id: 'cron_1' } },
      { name: 'email_send', arguments: { project_id: 'platform', to: 'alice@example.com', from: 'hello@example.com', subject: 'Welcome', text: 'You are in.' } },
      { name: 'email_test_inbox', arguments: { project_id: 'platform', address: 'robot@platform.test.somewhere.site' } },
    ]);

    const inboxHuman = await run([
      'email', 'test-inbox', 'robot@platform.test.somewhere.site', '--project', 'platform',
    ], env);
    assert.equal(inboxHuman.status, 0, inboxHuman.stderr);
    assert.match(inboxHuman.stdout, /Test inbox robot@platform\.test\.somewhere\.site — 1 message/);
    assert.match(inboxHuman.stdout, /magic_link: https:\/\/platform\.somewhere\.site\/auth\?token=magic/);

    const wrongInbox = await run([
      'email', 'test-inbox', 'real@example.com', '--project', 'platform', '--json',
    ], env);
    assert.equal(wrongInbox.status, 1);
    assert.deepEqual(JSON.parse(wrongInbox.stdout), {
      ok: false,
      error: 'VALIDATION_ERROR',
      message: "address must belong to this project's test inbox: <anything>@platform.test.somewhere.site.",
    });

    const oldPlatformInbox = await run([
      'email', 'test-inbox', 'old@platform.test.somewhere.site', '--project', 'platform', '--json',
    ], env);
    assert.equal(oldPlatformInbox.status, 1);
    assert.deepEqual(JSON.parse(oldPlatformInbox.stdout), {
      ok: false,
      error: 'EMAIL_TEST_INBOX_NOT_AVAILABLE',
      message: 'Test inbox is not available on this platform version yet.',
    });

    const callCount = calls.length;
    const badCron = await run([
      'cron', 'create', '0 8 * * *', '/api/digest', '--project', 'platform', '--payload', '[]',
    ], env);
    assert.equal(badCron.status, 1);
    assert.match(badCron.stderr, /Payload must be a JSON object/);

    const badEmail = await run([
      'email', 'send', 'alice@example.com', '--project', 'platform', '--from', 'hello@example.com', '--subject', 'Welcome',
    ], env);
    assert.equal(badEmail.status, 1);
    assert.match(badEmail.stderr, /Pass --text <body>, --html <body>, or both/);
    assert.equal(calls.length, callCount, 'invalid commands must not call the platform');
    assert.ok(urls.every((url) => url?.includes('groups=all')));
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
