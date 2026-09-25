import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliApiError } from '../dist/lib/client.js';
import { platformErrorEnvelope } from '../dist/lib/output.js';
import { platformToolErrorFromText } from '../dist/lib/platform-tools.js';

// Base44 head-to-head 2026-09-25, item 14: every --json failure said CLI_ERROR,
// even when the platform answered with its own precise code. A refusal must
// reach the agent verbatim; only a failure that began in the CLI says CLI_ERROR.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: {
        ...process.env,
        SOMEWHERE_MCP_URL: 'http://127.0.0.1:1/mcp',
        ...env,
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function fixture() {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-platform-home-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_json_platform_test',
    user: { email: 'json@example.com', username: 'json' },
  }) + '\n');
  const dir = mkdtempSync(join(tmpdir(), 'sw-json-platform-dir-'));
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_json_platform',
    name: 'json-platform',
    subdomain: 'json-platform',
  }) + '\n');
  writeFileSync(join(dir, 'script.js'), 'export default async function () { return 1; }\n');
  return { HOME, dir };
}

const REFUSAL = {
  ok: false,
  error: 'SCHEMA_DEPLOY_REFUSED',
  message: 'The schema change drops column notes.body, which holds data.',
  hint: 'Add a migration that copies the data first, then deploy again.',
};

function sendJson(res, payload) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

// Platform tools (usage, email) travel over MCP: a JSON-RPC server whose every
// tool answers with the same refusal envelope the API routes use.
function answerMcp(req, res) {
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
          serverInfo: { name: 'json-platform-errors', version: '1.0.0' },
        },
      });
      return;
    }
    if (rpc.method === 'tools/call') {
      sendJson(res, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ ...REFUSAL, request_id: 'req_json_platform_1', trace_id: 'trace_json_platform_1' }) }],
        },
      });
      return;
    }
    sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
  });
}

async function withRefusingServer(fn) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/mcp')) {
      answerMcp(req, res);
      return;
    }
    res.statusCode = 409;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Request-Id', 'req_json_platform_1');
    res.setHeader('X-Trace-Id', 'trace_json_platform_1');
    res.end(JSON.stringify(REFUSAL));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`, `http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

const COMMANDS = [
  ['usage', '--json'],
  ['env', 'list', '--json'],
  ['env', 'set', 'SOME_KEY', 'value', '--json'],
  ['errors', '--json'],
  ['run', 'script.js', '--json'],
  ['project', 'view', '--json'],
  ['fs', 'ls', 'docs', '--json'],
  ['email', 'send', 'person@example.com', '-p', 'proj_json_platform', '--subject', 'Hi', '--text', 'Hello', '--json'],
];

test('--json passes the platform refusal through verbatim on every command', async () => {
  const { HOME, dir } = fixture();
  await withRefusingServer(async (apiUrl, mcpUrl) => {
    for (const args of COMMANDS) {
      const result = await run(args, {
        cwd: dir,
        env: {
          HOME,
          USERPROFILE: HOME,
          SOMEWHERE_API_URL: apiUrl,
          SOMEWHERE_MCP_URL: mcpUrl,
          SOMEWHERE_RUNNER_URL: apiUrl.replace(/\/v1$/, ''),
        },
      });
      const label = `somewhere ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      assert.notEqual(result.status, 0, label);
      const body = JSON.parse(result.stdout);
      assert.equal(body.ok, false, label);
      assert.equal(body.error, REFUSAL.error, label);
      assert.equal(body.message, REFUSAL.message, label);
      assert.equal(body.hint, REFUSAL.hint, label);
      assert.equal(body.request_id, 'req_json_platform_1', label);
      assert.equal(body.trace_id, 'trace_json_platform_1', label);
    }
  });
});

test('--json still says CLI_ERROR for a failure that began in the CLI', async () => {
  const { HOME, dir } = fixture();
  await withRefusingServer(async (apiUrl) => {
    const result = await run(['run', 'missing.js', '--json'], {
      cwd: dir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });
    assert.notEqual(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.deepEqual(body, { ok: false, error: 'CLI_ERROR', message: 'File not found: missing.js' });
  });
});

test('platformErrorEnvelope keeps API refusals and ignores local errors', () => {
  const api = new CliApiError('CODE_TIMEOUT', 'The function ran past its time limit.', 504, undefined, 'Move slow work to a job.', {
    requestId: 'req_1',
    traceId: 'trace_1',
    retry: false,
  });
  assert.deepEqual(platformErrorEnvelope(api), {
    code: 'CODE_TIMEOUT',
    message: 'The function ran past its time limit.',
    extra: { hint: 'Move slow work to a job.', request_id: 'req_1', trace_id: 'trace_1', retry: false },
  });
  const local = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  assert.equal(platformErrorEnvelope(local), null);
  assert.equal(platformErrorEnvelope(new Error('bad flag')), null);
  assert.equal(platformErrorEnvelope('string'), null);
});

test('a platform tool refusal keeps its own code, message and fix', () => {
  const err = platformToolErrorFromText('email_send', JSON.stringify({
    ok: false,
    error: 'RESERVED_SENDER_DOMAIN',
    message: 'from uses a reserved domain.',
    hint: 'Omit from to send from the managed sender.',
    request_id: 'req_tool_1',
  }));
  // The flattened human message is unchanged for existing callers.
  assert.equal(err.message, 'RESERVED_SENDER_DOMAIN: from uses a reserved domain. Next: Omit from to send from the managed sender.');
  assert.deepEqual(platformErrorEnvelope(err), {
    code: 'RESERVED_SENDER_DOMAIN',
    message: 'from uses a reserved domain.',
    extra: { hint: 'Omit from to send from the managed sender.', request_id: 'req_tool_1' },
  });
  // Plain text from a tool carries no platform code.
  assert.equal(platformErrorEnvelope(platformToolErrorFromText('x', 'something broke')), null);
});
