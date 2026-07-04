import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, { cwd = repoRoot, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeConfig(home, token = 'smt_json_test') {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token,
    user: { email: 'json@example.com', username: 'json' },
  }) + '\n');
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('deploy --json emits only the raw deploy response object', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-deploy-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-json-deploy-fixture-'));
  writeConfig(HOME);
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_json_deploy',
    name: 'json-deploy',
    subdomain: 'json-deploy',
  }) + '\n');
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>json</body></html>\n');

  const deployData = {
    files: 1,
    url: 'https://json-deploy.somewhere.tech',
    has_functions: false,
    build_log: ['compiled'],
  };
  let deployBody = null;

  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployBody = JSON.parse(body);
        sendJson(res, 200, { ok: true, data: deployData });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['deploy', '--json'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), deployData);
    assert.equal(deployBody.project_id, 'proj_json_deploy');
    assert.doesNotMatch(result.stdout, /Live at/);
    assert.doesNotMatch(result.stdout, /Build/);
  });
});

test('logs --json emits JSONL and maps filters to /logs query params', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-logs-home-'));
  writeConfig(HOME);

  const logs = [
    {
      id: 'log_new',
      level: 'error',
      message: 'newest',
      source: 'function',
      data: { path: '/api/checkout' },
      created_at: '2026-07-03T10:00:00.000Z',
    },
    {
      id: 'log_old',
      level: 'info',
      message: 'older',
      source: 'function',
      data: { path: '/api/checkout' },
      created_at: '2026-07-03T09:59:00.000Z',
    },
  ];
  let seen = null;

  await withServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/logs') {
      seen = {
        projectId: url.searchParams.get('project_id'),
        limit: url.searchParams.get('limit'),
        functionRoute: url.searchParams.get('function'),
        after: url.searchParams.get('after'),
      };
      sendJson(res, 200, { ok: true, data: { logs, has_more: false, cursor: null } });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
  }, async (apiUrl) => {
    const result = await run([
      'logs',
      'proj_json_logs',
      '--json',
      '--tail',
      '2',
      '--since',
      '15m',
      '--endpoint',
      '/api/checkout',
    ], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const lines = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(lines, logs);
    assert.deepEqual(seen.projectId, 'proj_json_logs');
    assert.deepEqual(seen.limit, '2');
    assert.deepEqual(seen.functionRoute, '/api/checkout');
    const afterMs = new Date(seen.after).getTime();
    const ageMs = Date.now() - afterMs;
    assert.ok(ageMs >= 14 * 60_000 && ageMs <= 16 * 60_000, `unexpected --since age ${ageMs}`);
  });
});

test('whoami --json emits the raw whoami response object', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-whoami-home-'));
  writeConfig(HOME);

  const whoamiData = {
    user: {
      email: 'json@example.com',
      name: 'JSON User',
      username: 'json',
      effective_tier: 'builder',
    },
    stats: { api_keys: 2, projects: 3 },
  };

  await withServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/auth/whoami') {
      sendJson(res, 200, { ok: true, data: whoamiData });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
  }, async (apiUrl) => {
    const result = await run(['whoami', '--json'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), whoamiData);
    assert.doesNotMatch(result.stdout, /json@example\.com\s+\(/);
  });
});

test('project list --json emits the raw projects response object', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-project-home-'));
  writeConfig(HOME);

  const projectsData = {
    projects: [
      {
        name: 'alpha',
        status: 'deployed',
        subdomain: 'alpha',
        slug: 'alpha',
        updated_at: '2026-07-03T00:00:00.000Z',
      },
    ],
  };

  await withServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/projects') {
      sendJson(res, 200, { ok: true, data: projectsData });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
  }, async (apiUrl) => {
    const result = await run(['project', 'list', '--json'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), projectsData);
    assert.doesNotMatch(result.stdout, /alpha\.somewhere\.tech/);
  });
});
