import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function run(args, env) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(sourceRunner ?? process.execPath, sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env, SOMEWHERE_NO_NOTIFICATIONS: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
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

test('git connect deploys repository HEAD and reports commit, logs, and live URL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-git-home-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_git_test',
    user: { email: 'git@example.com', username: 'git' },
  }) + '\n');

  let connectionPolls = 0;
  let connectBody = null;
  let disconnected = false;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      assert.equal(req.headers.authorization, 'Bearer smt_git_test');
      if (req.method === 'GET' && url.pathname === '/v1/projects/proj-1') {
        return sendJson(res, { ok: true, data: { id: 'proj-1', name: 'Throwaway', subdomain: 'throwaway-github' } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/github/app/installations') {
        return sendJson(res, { ok: true, data: {
          app_configured: true,
          installations: [{ installation_id: 42, account_login: 'founder', account_type: 'User' }],
        } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/github/app/repos') {
        assert.equal(url.searchParams.get('installation_id'), '42');
        return sendJson(res, { ok: true, data: [{
          name: 'founder/throwaway-repo',
          private: true,
          default_branch: 'trunk',
        }] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/github/connect') {
        connectBody = JSON.parse(raw);
        return sendJson(res, { ok: true, data: {
          connected: true,
          project_id: 'proj-1',
          repo: 'founder/throwaway-repo',
          branch: 'trunk',
          initial_deploy: {
            status: 'deploying',
            commit_sha: 'abcdef1234567890',
            commit_message: 'ship throwaway',
          },
        } }, 202);
      }
      if (req.method === 'GET' && url.pathname === '/v1/github/connection') {
        connectionPolls += 1;
        return sendJson(res, { ok: true, data: {
          connected: true,
          project_id: 'proj-1',
          repo: 'founder/throwaway-repo',
          branch: 'trunk',
          last_commit_sha: 'abcdef1234567890',
          last_commit_message: 'ship throwaway',
          last_status: connectionPolls > 1 ? 'deployed' : 'deploying',
        } });
      }
      if (req.method === 'DELETE' && url.pathname === '/v1/github/connection') {
        disconnected = true;
        assert.equal(url.searchParams.get('project_id'), 'proj-1');
        return sendJson(res, { ok: true, data: { disconnected: true } });
      }
      return sendJson(res, { ok: false, error: 'NOT_FOUND', message: `${req.method} ${url.pathname}` }, 404);
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(
      ['git', 'connect', 'founder/throwaway-repo', '--project', 'proj-1', '--json'],
      { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(connectBody, {
      project_id: 'proj-1',
      repo: 'founder/throwaway-repo',
      branch: 'trunk',
      installation_id: 42,
      deploy_head: true,
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.commit_sha, 'abcdef1234567890');
    assert.equal(output.status, 'deployed');
    assert.equal(output.logs_url, 'https://somewhere.tech/dashboard/projects/proj-1?tab=logs');
    assert.equal(output.live_url, 'https://throwaway-github.somewhere.tech');
    assert.equal(result.stderr, '');

    const status = await run(
      ['git', 'status', '--project', 'proj-1', '--json'],
      { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(status.status, 0, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`);
    assert.equal(JSON.parse(status.stdout).last_status, 'deployed');

    const disconnect = await run(
      ['git', 'disconnect', '--project', 'proj-1', '--yes', '--json'],
      { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(disconnect.status, 0, `stdout:\n${disconnect.stdout}\nstderr:\n${disconnect.stderr}`);
    assert.deepEqual(JSON.parse(disconnect.stdout), { disconnected: true, project_id: 'proj-1' });
    assert.equal(disconnected, true);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
