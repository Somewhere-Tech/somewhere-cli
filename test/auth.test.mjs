import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function run(args, { env, input = '' }) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(sourceRunner ?? process.execPath, sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        SOMEWHERE_TOKEN: env.SOMEWHERE_TOKEN ?? '',
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

function writeConfig(home, config) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify(config) + '\n');
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

test('logout attempts server revocation and still unlinks config on failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-auth-logout-home-'));
  const configPath = join(home, '.somewhere', 'config.json');
  writeConfig(home, {
    token: 'smt_logout_test',
    refresh_token: 'smtr_logout_test',
    user: { email: 'logout@example.com', username: 'logout' },
  });
  const requests = [];

  await withServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      sendJson(res, 503, { ok: false, error: 'UNAVAILABLE', message: 'try later' });
    });
  }, async (apiUrl) => {
    const result = await run(['logout'], {
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Server revocation could not be confirmed/);
    assert.equal(existsSync(configPath), false);
  });

  assert.deepEqual(requests, [{
    method: 'POST',
    url: '/v1/auth/cli-logout',
    authorization: 'Bearer smt_logout_test',
    body: { refresh_token: 'smtr_logout_test' },
  }]);
});

test('auth set rejects a positional token without reading or validating it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-auth-set-argv-home-'));
  const requests = [];

  await withServer((req, res) => {
    requests.push(req.url);
    sendJson(res, 500, { ok: false, error: 'UNEXPECTED', message: 'must not be called' });
  }, async (apiUrl) => {
    const result = await run(['auth', 'set', 'smt_argv_secret'], {
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /visible in the process table/);
    assert.doesNotMatch(result.stdout + result.stderr, /smt_argv_secret/);
    assert.equal(existsSync(join(home, '.somewhere', 'config.json')), false);
  });

  assert.deepEqual(requests, []);
});

test('auth set reads a piped token and persists it after validation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-auth-set-stdin-home-'));
  const configPath = join(home, '.somewhere', 'config.json');

  await withServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer smt_stdin_secret');
    assert.equal(req.url, '/v1/auth/platform-me');
    sendJson(res, 200, {
      ok: true,
      data: { email: 'stdin@example.com', username: 'stdin' },
    });
  }, async (apiUrl) => {
    const result = await run(['auth', 'set'], {
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
      input: 'smt_stdin_secret\n',
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).token, 'smt_stdin_secret');
  });
});

test('auth print-token prints the stored smt_ token without decoration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-auth-print-token-home-'));
  writeConfig(home, {
    token: 'smt_print_token_test',
    user: { email: 'token@example.com', username: 'token' },
  });

  const result = await run(['auth', 'print-token'], {
    env: { HOME: home, USERPROFILE: home },
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(result.stdout, 'smt_print_token_test\n');
  assert.equal(result.stderr, '');
});
