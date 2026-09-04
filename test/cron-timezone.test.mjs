// tsk_e40578e0 — `cron create --help` documented every expression as UTC and
// exposed no way to say otherwise, while the platform had accepted an optional
// IANA timezone since #33. These fixtures pin the flag, the help copy, and the
// exact request body in both directions: named zone forwarded verbatim, omitted
// zone absent so the platform default (UTC) still decides.
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

function credentialHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_cron_timezone_test',
    user: { email: 'cron@example.com', username: 'cron' },
  }) + '\n');
  return home;
}

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

function sendJson(res, payload) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function withFixture(callTool, fn) {
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
            serverInfo: { name: 'cron-timezone-test', version: '1.0.0' },
          },
        });
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
        return;
      }
      if (rpc.method === 'tools/call') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: callTool(rpc.params) });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

function toolSuccess(data) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
}

test('cron create --help documents the timezone flag, its IANA example, and the UTC default', async () => {
  const home = credentialHome('sw-cron-tz-help-');
  const help = await run(['cron', 'create', '--help'], { HOME: home, USERPROFILE: home });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--timezone <iana>/);
  assert.match(help.stdout, /America\/Los_Angeles/);
  assert.match(help.stdout, /Omit for UTC/);
  // The old copy called every expression UTC full stop, which is what hid the flag.
  assert.doesNotMatch(help.stdout, /5-field UTC cron expression/);
});

test('a named timezone is forwarded verbatim and omitting it leaves the field absent', async () => {
  const home = credentialHome('sw-cron-tz-body-');
  const calls = [];
  await withFixture((params) => {
    calls.push({ name: params.name, arguments: params.arguments });
    return toolSuccess({ cron_id: 'cron_new' });
  }, async (url) => {
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url };

    const zoned = await run([
      'cron', 'create', '0 9 * * *', '/api/daily-digest',
      '--project', 'platform', '--timezone', 'America/Los_Angeles',
    ], env);
    assert.equal(zoned.status, 0, zoned.stderr);

    const plain = await run([
      'cron', 'create', '0 9 * * *', '/api/daily-digest', '--project', 'platform',
    ], env);
    assert.equal(plain.status, 0, plain.stderr);
  });

  // Forwarded exactly as typed — no client-side offset conversion, no normalizing.
  assert.deepEqual(calls[0], {
    name: 'cron_create',
    arguments: {
      project_id: 'platform',
      schedule: '0 9 * * *',
      handler: '/api/daily-digest',
      timezone: 'America/Los_Angeles',
    },
  });
  // Other direction: no flag, no field, so the platform default still applies.
  assert.deepEqual(calls[1], {
    name: 'cron_create',
    arguments: {
      project_id: 'platform',
      schedule: '0 9 * * *',
      handler: '/api/daily-digest',
    },
  });
  assert.ok(!('timezone' in calls[1].arguments));
});

test('platform timezone validation errors reach the user unchanged', async () => {
  const home = credentialHome('sw-cron-tz-error-');
  await withFixture(() => ({
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: 'timezone must be an IANA time zone name, e.g. America/Los_Angeles.',
      }),
    }],
  }), async (url) => {
    const result = await run([
      'cron', 'create', '0 9 * * *', '/api/daily-digest',
      '--project', 'platform', '--timezone', 'Mars/Olympus', '--json',
    ], { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    // The CLI does not validate zone names itself, so the platform's own
    // wording is what the user reads — verbatim, not a CLI paraphrase.
    assert.match(parsed.message, /timezone must be an IANA time zone name/);
    assert.match(parsed.message, /America\/Los_Angeles/);
  });
});
