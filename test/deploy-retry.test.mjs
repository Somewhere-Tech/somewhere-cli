import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function run(args, { cwd = repoRoot, env }) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(sourceRunner ?? process.execPath, sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args], {
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

function writeConfig(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_retry_test',
    user: { email: 'retry@example.com', username: 'retry' },
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
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('deploy retries once after a timeout-class upload failure', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-deploy-retry-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-deploy-retry-fixture-'));
  writeConfig(HOME);
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_retry',
    name: 'retry',
    subdomain: 'retry',
  }) + '\n');
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>retry</body></html>\n');

  let deployCalls = 0;

  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/deploy') {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
        return;
      }

      deployCalls++;
      JSON.parse(body);
      if (deployCalls === 1) {
        setTimeout(() => {
          sendJson(res, 200, {
            ok: true,
            data: { files: 1, url: 'https://retry.somewhere.tech', has_functions: false },
          });
        }, 250);
        return;
      }

      sendJson(res, 200, {
        ok: true,
        data: { files: 1, url: 'https://retry.somewhere.tech', has_functions: false },
      });
    });
  }, async (apiUrl) => {
    const result = await run(['deploy'], {
      cwd: fixtureDir,
      env: {
        HOME,
        USERPROFILE: HOME,
        SOMEWHERE_API_URL: apiUrl,
        SOMEWHERE_DEPLOY_TIMEOUT_MS: '80',
      },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(deployCalls, 2);
    assert.match(result.stdout, /Deploy timed out after 1s; retrying once\./);
    assert.match(result.stdout, /Live at https:\/\/retry\.somewhere\.tech/);
  });
});
