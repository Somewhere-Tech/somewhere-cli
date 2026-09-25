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

function run(args, env, cwd = repoRoot) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
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
    assert.match(named.stdout, /queued \(not finished yet\)\. Job job_once/);
    assert.match(named.stdout, /Pass --wait/);
    assert.doesNotMatch(named.stdout, /ran once/);
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

function linkedDir(projectId) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-cron-linked-'));
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({
    project_id: projectId,
    name: 'Linked app',
    subdomain: 'linked-app',
  }) + '\n');
  return dir;
}

test('cron list and name resolution default to the linked project; --all stays explicit', async () => {
  const home = credentialHome('sw-cron-scope-home-');
  const calls = [];
  let refuse = false;
  await withFixture((params) => {
    calls.push({ name: params.name, arguments: params.arguments });
    if (refuse) return toolError('PROJECT_NOT_FOUND', 'Project not found.');
    if (params.name === 'cron_run') {
      return toolSuccess({ cron_id: 'cron_mine', job_id: 'job_1', status: 'queued', trigger: 'manual' });
    }
    return toolSuccess({ crons: [{ cron_id: 'cron_mine', name: 'Reminders', schedule: '0 * * * *', handler: '/api/remind' }] });
  }, async (url) => {
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url };
    const linked = linkedDir('proj_linked');
    const unlinked = mkdtempSync(join(tmpdir(), 'sw-cron-unlinked-'));

    const scoped = await run(['cron', 'list', '--json'], env, linked);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.equal(scoped.stderr, '');
    const explicit = await run(['cron', 'list', '--project', 'other-app', '--json'], env, linked);
    assert.equal(explicit.status, 0, explicit.stderr);
    const all = await run(['cron', 'list', '--all', '--json'], env, linked);
    assert.equal(all.status, 0, all.stderr);
    const named = await run(['cron', 'run', 'Reminders', '--json'], env, linked);
    assert.equal(named.status, 0, named.stderr);

    const accountWide = await run(['cron', 'list', '--json'], env, unlinked);
    assert.equal(accountWide.status, 0, accountWide.stderr);
    assert.match(accountWide.stderr, /No linked project: listing across all projects/);
    assert.equal(JSON.parse(accountWide.stdout).ok, true, 'stdout stays machine-readable');

    const callCount = calls.length;
    const both = await run(['cron', 'list', '--all', '--project', 'other-app'], env, linked);
    assert.equal(both.status, 1);
    assert.match(both.stderr, /--project <project> or --all, not both/);
    assert.equal(calls.length, callCount, 'a usage error never calls the platform');

    // A refused linked project is reported, never widened to the account.
    refuse = true;
    const refused = await run(['cron', 'list'], env, linked);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /PROJECT_NOT_FOUND|Project not found/);
  });

  assert.deepEqual(calls, [
    { name: 'cron_list', arguments: { project_id: 'proj_linked' } },
    { name: 'cron_list', arguments: { project_id: 'other-app' } },
    { name: 'cron_list', arguments: {} },
    { name: 'cron_list', arguments: { project_id: 'proj_linked' } },
    { name: 'cron_run', arguments: { cron_id: 'cron_mine' } },
    { name: 'cron_list', arguments: {} },
    { name: 'cron_list', arguments: { project_id: 'proj_linked' } },
  ]);
});

test('cron run --wait polls the job until it finishes and prints the result', async () => {
  const home = credentialHome('sw-cron-wait-home-');
  const calls = [];
  let polls = 0;
  await withFixture((params) => {
    calls.push(params.name);
    if (params.name === 'cron_run') {
      return toolSuccess({ cron_id: 'cron_daily', job_id: 'job_wait', status: 'queued', trigger: 'manual' });
    }
    assert.equal(params.name, 'job_get');
    assert.deepEqual(params.arguments, { job_id: 'job_wait' });
    polls += 1;
    // indeterminate is reported briefly during dispatch; --wait keeps polling.
    const status = polls === 1 ? 'queued' : polls === 2 ? 'indeterminate' : 'complete';
    return toolSuccess({
      job_id: 'job_wait',
      status,
      result: status === 'complete' ? { due: 1, sent: 1 } : null,
      error: null,
      created_at: '2026-09-25T00:25:37.000Z',
      started_at: polls > 1 ? '2026-09-25T00:25:37.200Z' : null,
      completed_at: status === 'complete' ? '2026-09-25T00:25:40.800Z' : null,
    });
  }, async (url) => {
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url };
    const human = await run(['cron', 'run', 'cron_daily', '--wait'], env);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /job job_wait complete/);
    assert.match(human.stdout, /Result: \{"due":1,"sent":1\}/);
    assert.match(human.stdout, /completed 2026-09-25T00:25:40.800Z/);

    polls = 0;
    const json = await run(['cron', 'run', 'cron_daily', '--wait', '--json'], env);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.job_id, 'job_wait');
    assert.equal(parsed.data.job.status, 'complete');
    assert.deepEqual(parsed.data.job.result, { due: 1, sent: 1 });
  });
  assert.deepEqual(calls, ['cron_run', 'job_get', 'job_get', 'job_get', 'cron_run', 'job_get', 'job_get', 'job_get']);
});

test('cron run --wait exits non-zero on a failed job and on timeout', async () => {
  const home = credentialHome('sw-cron-wait-fail-home-');
  let mode = 'failed';
  await withFixture((params) => {
    if (params.name === 'cron_run') {
      return toolSuccess({ cron_id: 'cron_daily', job_id: 'job_x', status: 'queued', trigger: 'manual' });
    }
    if (mode === 'failed') {
      return toolSuccess({ job_id: 'job_x', status: 'failed', result: null, error: 'boom', error_code: 'HANDLER_ERROR' });
    }
    return toolSuccess({ job_id: 'job_x', status: 'running', result: null, error: null });
  }, async (url) => {
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url };

    const failed = await run(['cron', 'run', 'cron_daily', '--wait'], env);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /did not succeed: job job_x failed/);
    assert.match(failed.stdout, /Error: HANDLER_ERROR: boom/);

    const failedJson = await run(['cron', 'run', 'cron_daily', '--wait', '--json'], env);
    assert.equal(failedJson.status, 1);
    const failedParsed = JSON.parse(failedJson.stdout);
    assert.equal(failedParsed.error, 'CRON_RUN_JOB_FAILED');
    assert.equal(failedParsed.data.job.error, 'boom');

    mode = 'running';
    const timedOut = await run(['cron', 'run', 'cron_daily', '--wait', '--timeout', '1', '--json'], env);
    assert.equal(timedOut.status, 1);
    const timedOutParsed = JSON.parse(timedOut.stdout);
    assert.equal(timedOutParsed.error, 'CRON_RUN_WAIT_TIMEOUT');
    assert.equal(timedOutParsed.data.job.status, 'running');
  });
});

test('cron run rejects --timeout without --wait before calling the platform', async () => {
  const home = credentialHome('sw-cron-timeout-usage-home-');
  const calls = [];
  await withFixture((params) => {
    calls.push(params.name);
    return toolSuccess({});
  }, async (url) => {
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url };
    const result = await run(['cron', 'run', 'cron_daily', '--timeout', '5', '--json'], env);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'USAGE_ERROR');
    const bad = await run(['cron', 'run', 'cron_daily', '--wait', '--timeout', 'soon', '--json'], env);
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).error, 'USAGE_ERROR');
  });
  assert.deepEqual(calls, []);
});
