/**
 * tsk_f250e561 — `somewhere status` must exit 0 on a healthy project.
 *
 * The blind run hit this on a healthy, deployed, Free-tier project:
 * `somewhere status --json` exited 1 carrying
 * `deployment_error: CLOUD_DEV_NOT_ENABLED`. That code is a PLAN ENTITLEMENT
 * fact — reaching the project database from a local dev session is a paid
 * feature — not a failure of the project. Exit 1 is reserved for a real
 * problem: deploy failed, project missing or unreachable, auth broken.
 *
 * Both directions are pinned here: a healthy-Free fixture exits 0, and a
 * genuinely-broken fixture still exits 1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planEntitlementFromError, planEntitlementLine } from '../dist/commands/status.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        CI: '1',
        NO_COLOR: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function credentialHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_status_exit_code',
    user: { email: 'free@example.com', username: 'free' },
  }) + '\n');
  return home;
}

/** A healthy, deployed project whose account's deploy_status read is refused
 *  with the given tool error. */
function fixtureServer(projectId, toolError) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && url.pathname === `/v1/projects/${projectId}`) {
        sendJson(res, { ok: true, data: {
          name: 'Healthy Free App',
          status: 'deployed',
          subdomain: 'healthy-free',
          slug: 'healthy-free',
          updated_at: new Date().toISOString(),
          local_dev_db_allowed: false,
          local_dev_db_required_plans: ['pro', 'scale'],
        } });
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/projects/${projectId}/urls`) {
        sendJson(res, { ok: true, data: {
          prod: 'https://healthy-free.somewhere.site',
          prod_fallback: 'https://healthy-free.somewhere.site',
        } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/hosted/status') {
        sendJson(res, { ok: false, error: 'NOT_FOUND', message: 'No workspace' }, 404);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/mcp') {
        const rpc = JSON.parse(body);
        if (rpc.method === 'initialize') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'status-exit-code-test', version: '1.0.0' },
            },
          });
          return;
        }
        if (rpc.method === 'notifications/initialized') {
          sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
          return;
        }
        if (rpc.method === 'tools/call') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify(toolError) }],
            },
          });
          return;
        }
      }
      sendJson(res, { ok: false, error: 'NOT_FOUND', message: `${req.method} ${url.pathname}` }, 404);
    });
  });
}

async function withFixture(projectId, toolError, fn) {
  const server = fixtureServer(projectId, toolError);
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

test('a healthy Free project exits 0 and states the plan entitlement as information', async () => {
  const home = credentialHome('sw-status-free-home-');
  await withFixture('proj-free', {
    error: 'CLOUD_DEV_NOT_ENABLED',
    message: 'Cloud dev is included on the Pro and Scale plans.',
  }, async (base) => {
    const env = {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_API_URL: `${base}/v1`,
      SOMEWHERE_MCP_URL: `${base}/mcp`,
    };

    const human = await run(['status', 'proj-free'], env);
    assert.equal(
      human.status,
      0,
      `healthy project must exit 0\nstdout:\n${human.stdout}\nstderr:\n${human.stderr}`,
    );
    assert.match(human.stdout, /Healthy Free App/);
    assert.match(human.stdout, /not included on this plan/);
    assert.match(human.stdout, /Pro and Scale plans/);
    assert.doesNotMatch(human.stderr, /Deploy status:/);

    const json = await run(['status', 'proj-free', '--json'], env);
    assert.equal(json.status, 0, `--json must exit 0\nstderr:\n${json.stderr}`);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.deployment_error, null, 'a plan fact is not a deployment error');
    assert.equal(parsed.deployment_entitlement.code, 'CLOUD_DEV_NOT_ENABLED');
    assert.equal(parsed.deployment_entitlement.deploy_affected, false);
    assert.equal(parsed.project.status, 'deployed');
  });
});

test('a genuinely broken deploy still exits 1', async () => {
  const home = credentialHome('sw-status-broken-home-');
  await withFixture('proj-broken', {
    error: 'DEPLOY_FAILED',
    message: 'The last deploy failed while compiling src/App.tsx.',
  }, async (base) => {
    const env = {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_API_URL: `${base}/v1`,
      SOMEWHERE_MCP_URL: `${base}/mcp`,
    };

    const human = await run(['status', 'proj-broken'], env);
    assert.equal(human.status, 1, 'a real failure must not report success to a script');
    assert.match(human.stderr, /DEPLOY_FAILED/);

    const json = await run(['status', 'proj-broken', '--json'], env);
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.stdout);
    assert.match(parsed.deployment_error, /DEPLOY_FAILED/);
    assert.equal(parsed.deployment_entitlement, null);
  });
});

test('an unreachable project still exits 1', async () => {
  const home = credentialHome('sw-status-missing-home-');
  await withFixture('proj-present', {
    error: 'CLOUD_DEV_NOT_ENABLED',
    message: 'Cloud dev is included on the Pro and Scale plans.',
  }, async (base) => {
    // The fixture only serves proj-present, so this project 404s.
    const result = await run(['status', 'proj-absent', '--json'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_API_URL: `${base}/v1`,
      SOMEWHERE_MCP_URL: `${base}/mcp`,
    });
    assert.equal(result.status, 1);
    assert.notEqual(JSON.parse(result.stdout).project_error, null);
  });
});

test('only plan-entitlement codes are read as information', () => {
  const note = planEntitlementFromError(
    new Error('CLOUD_DEV_NOT_ENABLED: Cloud dev is included on the Pro and Scale plans.'),
  );
  assert.deepEqual(note, {
    code: 'CLOUD_DEV_NOT_ENABLED',
    message: 'Cloud dev is included on the Pro and Scale plans.',
  });
  assert.match(planEntitlementLine(note), /^Cloud dev: not included on this plan — /);

  assert.equal(planEntitlementFromError(new Error('DEPLOY_FAILED: compile error')), null);
  assert.equal(planEntitlementFromError(new Error('UNAUTHORIZED: token expired')), null);
  assert.equal(planEntitlementFromError(new Error('fetch failed')), null);
  assert.equal(planEntitlementFromError(new Error('NOT_FOUND: no such project')), null);
});
