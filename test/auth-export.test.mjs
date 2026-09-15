import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');
const syntheticHash = '$2b$12$012345678901234567890u0123456789012345678901234567890';

function run(args, { env, input = '' }) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(sourceRunner ?? process.execPath, sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        SOMEWHERE_TOKEN: '',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end(input);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeConfig(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_auth_export_fixture',
    user: { email: 'owner@example.test', username: 'owner' },
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

function collectRequest(req, callback) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => callback(body ? JSON.parse(body) : null));
}

test('auth export writes credentials only to a new mode-0600 file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-auth-export-home-'));
  const output = join(home, 'auth-export.json');
  const requests = [];
  writeConfig(home);

  await withServer((req, res) => collectRequest(req, (body) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/auth/export/request') {
      res.end(JSON.stringify({ ok: true, data: { status: 'approval_sent', expires_in_seconds: 600 } }));
      return;
    }
    res.end(JSON.stringify({
      ok: true,
      data: {
        format: 'somewhere.auth-password-export.v1',
        users: [{
          email: 'synthetic@example.test',
          password_hash: syntheticHash,
          hash_algorithm: 'bcrypt',
          display_name: 'Synthetic',
          email_verified: true,
        }],
      },
    }));
  }), async (apiUrl) => {
    const result = await run(['auth', 'export', 'project-a', '--output', output], {
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
      input: '482917\n',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /\$2b\$|synthetic@example/);
  });

  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).data.users[0].password_hash, syntheticHash);
  assert.deepEqual(requests, [
    {
      method: 'POST',
      url: '/v1/auth/export/request',
      authorization: 'Bearer smt_auth_export_fixture',
      body: { project_id: 'project-a' },
    },
    {
      method: 'POST',
      url: '/v1/auth/export/download',
      authorization: 'Bearer smt_auth_export_fixture',
      body: { project_id: 'project-a', code: '482917' },
    },
  ]);
});

test('auth export refuses overwrite before requesting approval', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-auth-export-existing-home-'));
  const output = join(home, 'auth-export.json');
  writeConfig(home);
  writeFileSync(output, 'keep me');
  let requests = 0;

  await withServer((_req, res) => {
    requests += 1;
    res.end();
  }, async (apiUrl) => {
    const result = await run(['auth', 'export', 'project-a', '--output', output], {
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
      input: '482917\n',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Refusing to overwrite existing path/);
  });

  assert.equal(requests, 0);
  assert.equal(readFileSync(output, 'utf8'), 'keep me');
});

test('auth export removes its reserved file on denial and never prints response data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-auth-export-denied-home-'));
  const output = join(home, 'auth-export.json');
  writeConfig(home);

  await withServer((req, res) => collectRequest(req, () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/auth/export/request') {
      res.end(JSON.stringify({ ok: true, data: { status: 'approval_sent', expires_in_seconds: 600 } }));
      return;
    }
    res.statusCode = 403;
    res.end(JSON.stringify({
      ok: false,
      error: 'INVALID_CODE',
      message: 'Invalid, expired, or already-used approval code.',
      data: { password_hash: syntheticHash },
    }));
  }), async (apiUrl) => {
    const result = await run(['auth', 'export', 'project-a', '--output', output], {
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
      input: '000000\n',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Invalid, expired, or already-used/);
    assert.doesNotMatch(result.stdout + result.stderr, /\$2b\$/);
  });

  assert.equal(existsSync(output), false);
});

test('auth export does not replay an ambiguously completed one-time download', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-auth-export-ambiguous-home-'));
  const output = join(home, 'auth-export.json');
  writeConfig(home);
  let downloadCalls = 0;

  await withServer((req, res) => collectRequest(req, () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/auth/export/request') {
      res.statusCode = 202;
      res.end(JSON.stringify({ ok: true, data: { status: 'pending', expires_in_seconds: 600 } }));
      return;
    }
    downloadCalls += 1;
    req.socket.destroy();
  }), async (apiUrl) => {
    const result = await run(['auth', 'export', 'project-a', '--output', output], {
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
      input: '482917\n',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /delivery is still pending/);
    assert.match(result.stdout + result.stderr, /outcome could not be confirmed/);
    assert.match(result.stdout + result.stderr, /request a new approval code/);
  });

  assert.equal(downloadCalls, 1, 'one-time approval download is never replayed');
  assert.equal(existsSync(output), false);
});
