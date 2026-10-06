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
    token: 'smt_cron_runs_test',
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


// tsk_cf939691: `cron runs` shows scheduled and manual history from job_get's
// cron_id filter, and a past next run is labelled overdue, never "dispatched".
const PROJECT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PAST = '2020-01-01T00:05:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

function cronRow(overrides = {}) {
  return { cron_id: 'cron_digest', project_id: PROJECT, name: 'digest', schedule: '*/5 * * * *', timezone: 'UTC', handler: '/api/digest', enabled: true, next_run_at: FUTURE, ...overrides };
}

const scheduledJob = { job_id: 'job_sched', status: 'complete', trigger: 'scheduled', cron_id: 'cron_digest', cron_scheduled_at: '2020-01-01T00:00:00.000Z', started_at: '2020-01-01T00:00:41.000Z', completed_at: '2020-01-01T00:00:45.000Z', result: { sent: 2 }, error: null, error_code: null };
const manualJob = { job_id: 'job_manual', status: 'failed', trigger: 'manual', cron_id: 'cron_digest', cron_scheduled_at: null, started_at: '2019-12-31T23:59:00.000Z', completed_at: '2019-12-31T23:59:02.000Z', result: null, error: 'Handler threw', error_code: 'HANDLER_ERROR' };

function linkedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-cron-runs-app-'));
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: 'linked-proj', name: 'app', subdomain: 'app' }));
  return dir;
}

function fixture(cron, jobs, calls) {
  return (params) => {
    calls.push({ name: params.name, arguments: params.arguments });
    if (params.name === 'cron_list') return toolSuccess({ crons: cron ? [cron] : [] });
    if (params.name === 'job_get') return toolSuccess({ jobs });
    return toolError('UNEXPECTED', params.name);
  };
}

test('cron runs by name uses the linked project and shows scheduled and manual history', async () => {
  const home = credentialHome('sw-cron-runs-home-');
  const calls = [];
  await withFixture(fixture(cronRow(), [scheduledJob, manualJob], calls), async (url) => {
    const out = await run(['cron', 'runs', 'digest'], { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url }, linkedDir());
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /digest \(cron_digest\)\s+\*\/5 \* \* \* \* UTC/);
    assert.match(out.stdout, /Next run \(UTC\): 2999-01-01T00:00:00Z\n/);
    assert.doesNotMatch(out.stdout, /overdue|dispatch/i);
    const line = (id) => out.stdout.split('\n').find((l) => l.includes(id)) ?? '';
    assert.match(line('job_sched'), /scheduled\s+2020-01-01T00:00:00Z\s+complete\s+2020-01-01T00:00:41Z\s+2020-01-01T00:00:45Z\s+\{"sent":2\}/);
    assert.match(line('job_manual'), /manual\s+—\s+failed/);
    assert.match(line('job_manual'), /HANDLER_ERROR: Handler threw/);
  });
  assert.deepEqual(calls, [
    { name: 'cron_list', arguments: { project_id: 'linked-proj' } },
    { name: 'job_get', arguments: { cron_id: 'cron_digest', project_id: PROJECT } },
  ]);
});

test('cron runs by ID looks up the trigger account-wide, scopes history to its project, and forwards --limit', async () => {
  const home = credentialHome('sw-cron-runs-home-');
  const calls = [];
  await withFixture(fixture(cronRow(), [scheduledJob], calls), async (url) => {
    const out = await run(['cron', 'runs', 'cron_digest', '--limit', '5', '--json'], { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url }, linkedDir());
    assert.equal(out.status, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.cron.next_run_at, FUTURE);
    assert.deepEqual(parsed.data.jobs, [scheduledJob]);
  });
  assert.deepEqual(calls, [
    { name: 'cron_list', arguments: {} },
    { name: 'job_get', arguments: { cron_id: 'cron_digest', project_id: PROJECT, limit: 5 } },
  ]);
});

test('cron runs keeps an explicit --project when the ID is not in the listing', async () => {
  const home = credentialHome('sw-cron-runs-home-');
  const calls = [];
  await withFixture(fixture(null, [], calls), async (url) => {
    const out = await run(['cron', 'runs', 'cron_other', '--project', 'chosen-app'], { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url }, linkedDir());
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /cron_other/);
    assert.match(out.stdout, /No runs yet/);
    assert.doesNotMatch(out.stdout, /Next run/);
  });
  assert.deepEqual(calls, [
    { name: 'cron_list', arguments: { project_id: 'chosen-app' } },
    { name: 'job_get', arguments: { cron_id: 'cron_other', project_id: 'chosen-app' } },
  ]);
});

test('an overdue next run says whether that occurrence has a recorded run', async () => {
  const home = credentialHome('sw-cron-runs-home-');
  const env = (url) => ({ HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url });
  const recorded = { ...scheduledJob, job_id: 'job_due', status: 'running', cron_scheduled_at: PAST };
  await withFixture(fixture(cronRow({ next_run_at: PAST }), [recorded, scheduledJob], []), async (url) => {
    const out = await run(['cron', 'runs', 'cron_digest'], env(url));
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Next run \(UTC\): 2020-01-01T00:05:00Z \(overdue\)/);
    assert.match(out.stdout, /overdue occurrence has a recorded run: job job_due \(running\)/);
    assert.doesNotMatch(out.stdout, /dispatched/);
  });
  await withFixture(fixture(cronRow({ next_run_at: PAST }), [scheduledJob, manualJob], []), async (url) => {
    const out = await run(['cron', 'runs', 'cron_digest'], env(url));
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /No run is recorded for the overdue occurrence yet/);
  });
});

test('cron list shows the next run, marks a past one overdue, and a disabled trigger paused', async () => {
  const home = credentialHome('sw-cron-runs-home-');
  let out;
  await withFixture((params) => toolSuccess({ crons: [
    cronRow({ cron_id: 'cron_future' }),
    cronRow({ cron_id: 'cron_past', next_run_at: PAST }),
    cronRow({ cron_id: 'cron_off', enabled: false, next_run_at: PAST }),
  ] }), async (url) => {
    out = await run(['cron', 'list', '--project', 'platform'], { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url });
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /NEXT RUN \(UTC\)/);
  const line = (id) => out.stdout.split('\n').find((l) => l.includes(id)) ?? '';
  assert.match(line('cron_future'), /2999-01-01T00:00:00Z\s*$/);
  assert.match(line('cron_past'), /2020-01-01T00:05:00Z \(overdue\)/);
  assert.match(line('cron_off'), /paused\s*$/);
  assert.doesNotMatch(line('cron_off'), /overdue/);
});

test('cron runs rejects an invalid --limit before calling the platform', async () => {
  const home = credentialHome('sw-cron-runs-home-');
  const calls = [];
  await withFixture(fixture(cronRow(), [], calls), async (url) => {
    for (const bad of ['0', '101', '2.5', 'ten']) {
      const out = await run(['cron', 'runs', 'cron_digest', '--limit', bad], { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url });
      assert.notEqual(out.status, 0, bad);
      assert.match(out.stderr + out.stdout, /USAGE_ERROR: --limit must be a whole number from 1 to 100/);
    }
  });
  assert.equal(calls.length, 0);
});

test('cron runs --help explains triggers, UTC times and the overdue state', async () => {
  const out = await run(['cron', 'runs', '--help'], {});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /"scheduled"/);
  assert.match(out.stdout, /"manual"/);
  assert.match(out.stdout, /overdue/);
  assert.doesNotMatch(out.stdout, /dispatched/);
});
