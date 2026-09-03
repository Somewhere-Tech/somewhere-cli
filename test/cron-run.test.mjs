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
    token: 'smt_cron_run_test',
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

function fixtureServer(callTool) {
  return createServer((req, res) => {
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
            serverInfo: { name: 'cron-run-test', version: '1.0.0' },
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
}

async function withFixture(callTool, fn) {
  const server = fixtureServer(callTool);
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

function toolSuccess(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
  };
}

function toolError(error, message) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error, message }) }],
  };
}

test('cron list and run use canonical cron_id fields and run a named task once', async () => {
  const home = credentialHome('sw-cron-run-home-');
  const calls = [];
  await withFixture((params) => {
    calls.push({ name: params.name, arguments: params.arguments });
    if (params.name === 'cron_list') {
      return toolSuccess({ crons: [{
        cron_id: 'cron_daily',
        name: 'Daily digest',
        schedule: '0 8 * * *',
        handler: '/api/digest',
        enabled: true,
      }] });
    }
    assert.equal(params.name, 'cron_run');
    return toolSuccess({
      cron_id: 'cron_daily',
      job_id: 'job_once',
      status: 'queued',
      trigger: 'manual',
    });
  }, async (url) => {
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url };

    const listed = await run(['cron', 'list', '--project', 'platform'], env);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /cron_daily/);

    const named = await run(['cron', 'run', 'Daily digest', '--project', 'platform'], env);
    assert.equal(named.status, 0, named.stderr);
    assert.match(named.stdout, /ran once, see history/);
    assert.match(named.stdout, /cron_daily\s+Job job_once\s+queued\s+trigger: manual/);

    const direct = await run(['cron', 'run', 'cron_daily', '--json'], env);
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(JSON.parse(direct.stdout).data.job_id, 'job_once');
  });

  assert.deepEqual(calls, [
    { name: 'cron_list', arguments: { project_id: 'platform' } },
    { name: 'cron_list', arguments: { project_id: 'platform' } },
    { name: 'cron_run', arguments: { cron_id: 'cron_daily' } },
    { name: 'cron_run', arguments: { cron_id: 'cron_daily' } },
  ]);
});

test('cron run maps rollout 404 and 403 responses to a typed availability error', async () => {
  for (const upstream of [
    { code: 'NOT_FOUND', message: 'POST /v1/cron/cron_daily/run' },
    { code: 'FORBIDDEN', message: 'Cron run is disabled on this serving release.' },
  ]) {
    const home = credentialHome(`sw-cron-run-${upstream.code.toLowerCase()}-`);
    await withFixture(() => toolError(upstream.code, upstream.message), async (url) => {
      const result = await run(['cron', 'run', 'cron_daily', '--json'], {
        HOME: home,
        USERPROFILE: home,
        SOMEWHERE_MCP_URL: url,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        error: 'CRON_RUN_NOT_AVAILABLE',
        message: 'Cron run is not available on this platform version yet.',
      });
      assert.doesNotMatch(result.stdout, /\bat\s+\S+\.ts:\d+/);
    });
  }
});

test('cron run preserves a real missing-task error and types unresolved names', async () => {
  const home = credentialHome('sw-cron-run-errors-home-');
  let listMode = 'missing';
  await withFixture((params) => {
    if (params.name === 'cron_run') return toolError('NOT_FOUND', 'Scheduled task not found.');
    if (listMode === 'missing') return toolSuccess({ crons: [] });
    return toolSuccess({ crons: [
      { cron_id: 'cron_a', name: 'Duplicate' },
      { cron_id: 'cron_b', name: 'Duplicate' },
    ] });
  }, async (url) => {
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url };

    const missingId = await run(['cron', 'run', 'cron_missing', '--json'], env);
    assert.equal(missingId.status, 1);
    assert.equal(JSON.parse(missingId.stdout).error, 'NOT_FOUND');
    assert.doesNotMatch(missingId.stdout, /CRON_RUN_NOT_AVAILABLE/);

    const missingName = await run(['cron', 'run', 'Absent', '--json'], env);
    assert.equal(missingName.status, 1);
    assert.equal(JSON.parse(missingName.stdout).error, 'CRON_NOT_FOUND');

    listMode = 'ambiguous';
    const ambiguous = await run(['cron', 'run', 'Duplicate', '--json'], env);
    assert.equal(ambiguous.status, 1);
    assert.equal(JSON.parse(ambiguous.stdout).error, 'CRON_NAME_AMBIGUOUS');
  });
});
