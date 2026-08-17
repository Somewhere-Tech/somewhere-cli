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
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function run(args, { env }) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(
      sourceRunner ?? process.execPath,
      sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args],
      {
        env: { ...process.env, ...env, CI: '', SOMEWHERE_NO_NOTIFICATIONS: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.end('');
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeConfig(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(
    join(home, '.somewhere', 'config.json'),
    JSON.stringify({ token: 'smt_allowed_origins', user: { email: 'ao@example.com', username: 'ao' } }) + '\n',
  );
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('project allowed-origins list reads the allowlist', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-ao-list-'));
  writeConfig(HOME);
  const requests = [];
  await withServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, pathname: url.pathname });
    if (req.method === 'GET' && url.pathname === '/v1/projects/my-app/allowed-origins') {
      sendJson(res, 200, {
        ok: true,
        data: { project_id: 'p1', allowed_origins: ['https://a.example.com', 'https://b.example.com'], cors_mode: 'safe' },
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
  }, async (apiUrl) => {
    const result = await run(['project', 'allowed-origins', 'list', 'my-app', '--json'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).allowed_origins, ['https://a.example.com', 'https://b.example.com']);
  });
  assert.deepEqual(requests, [{ method: 'GET', pathname: '/v1/projects/my-app/allowed-origins' }]);
});

test('project allowed-origins set replaces the allowlist with the given origins', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-ao-set-'));
  writeConfig(HOME);
  let putBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'PUT' && url.pathname === '/v1/projects/my-app/allowed-origins') {
        putBody = body ? JSON.parse(body) : null;
        sendJson(res, 200, {
          ok: true,
          data: { updated: true, project_id: 'p1', allowed_origins: putBody.allowed_origins, cors_mode: 'safe' },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(
      ['project', 'allowed-origins', 'set', 'my-app', 'https://app.example.com', 'http://localhost:5173', '--json'],
      { env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } },
    );
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).allowed_origins, ['https://app.example.com', 'http://localhost:5173']);
  });
  assert.deepEqual(putBody, { allowed_origins: ['https://app.example.com', 'http://localhost:5173'] });
});

test('project allowed-origins clear sends an empty list', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-ao-clear-'));
  writeConfig(HOME);
  let putBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'PUT' && url.pathname === '/v1/projects/my-app/allowed-origins') {
        putBody = body ? JSON.parse(body) : null;
        sendJson(res, 200, { ok: true, data: { updated: true, project_id: 'p1', allowed_origins: [], cors_mode: 'safe' } });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['project', 'allowed-origins', 'clear', 'my-app', '--json'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).allowed_origins, []);
  });
  assert.deepEqual(putBody, { allowed_origins: [] });
});

test('project allowed-origins set surfaces a non-owner 403 clearly and exits non-zero', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-ao-403-'));
  writeConfig(HOME);
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'PUT' && url.pathname === '/v1/projects/my-app/allowed-origins') {
        sendJson(res, 403, {
          ok: false,
          error: 'FORBIDDEN',
          message: 'Only the project owner or a platform admin can change allowed origins.',
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['project', 'allowed-origins', 'set', 'my-app', 'https://app.example.com'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /owner or a platform admin/i);
    assert.match(result.stderr + result.stdout, /FORBIDDEN/);
  });
});
