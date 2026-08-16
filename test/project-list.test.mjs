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

function run(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('project list does not print obsolete deploy slot counts', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-project-list-home-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_project_list',
    user: { email: 'dev@example.com', username: 'dev' },
  }) + '\n');

  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/projects') {
      res.end(JSON.stringify({
        ok: true,
        data: {
          projects: [
            {
              name: 'alpha',
              status: 'deployed',
              subdomain: 'alpha',
              slug: 'alpha',
              updated_at: new Date().toISOString(),
            },
          ],
          deployed_count: 4,
        },
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/projects/alpha/urls') {
      res.end(JSON.stringify({
        ok: true,
        data: { prod_fallback: 'https://alpha.somewhere.site' },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', message: 'missing' }));
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(['projects'], {
      HOME,
      USERPROFILE: HOME,
      SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      CI: '1',
    });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /https:\/\/alpha\.somewhere\.site/);
    assert.doesNotMatch(result.stdout, /deploy slots used/);
    assert.doesNotMatch(result.stdout, /undefined/);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
