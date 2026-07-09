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

function run(args, { env, input = '' }) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(sourceRunner ?? process.execPath, sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args], {
      env: {
        ...process.env,
        ...env,
        CI: '',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.end(input);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeConfig(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_project_delete',
    user: { email: 'delete@example.com', username: 'delete' },
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

function parseBody(body) {
  return body ? JSON.parse(body) : null;
}

test('project delete resolves names, submits the returned confirmation code, and deletes by canonical id', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-project-delete-home-'));
  writeConfig(HOME);

  const projectName = 'Founder Repro Delete';
  const project = {
    id: 'proj_delete_123',
    name: projectName,
    subdomain: 'founder-repro-delete',
    slug: 'founder-repro-delete',
    is_owner: true,
  };
  const requests = [];

  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({
        method: req.method,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: parseBody(body),
      });

      if (req.method === 'GET' && url.pathname === `/v1/projects/${encodeURIComponent(projectName)}`) {
        sendJson(res, 404, { ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects') {
        assert.equal(url.searchParams.get('q'), projectName);
        sendJson(res, 200, { ok: true, data: { projects: [project] } });
        return;
      }
      if (req.method === 'DELETE' && url.pathname === `/v1/projects/${project.id}`) {
        const parsed = parseBody(body);
        if (!parsed?.code) {
          sendJson(res, 400, {
            ok: false,
            error: 'CONFIRMATION_REQUIRED',
            code: '482917',
            message: `To confirm deletion of "${project.name}", call project_delete_confirm with this code.`,
          });
          return;
        }
        assert.equal(parsed.code, '482917');
        sendJson(res, 200, { ok: true, data: { deleted: true, note: 'offline' } });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['project', 'delete', projectName, '--json'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      input: `${projectName}\n`,
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { deleted: true, note: 'offline' });
  });

  assert.equal(
    requests.some((r) => r.pathname.endsWith('/request-delete')),
    false,
    'delete must not use the dashboard email-link route',
  );
  assert.deepEqual(
    requests
      .filter((r) => r.method === 'DELETE')
      .map((r) => ({ pathname: r.pathname, body: r.body })),
    [
      { pathname: `/v1/projects/${project.id}`, body: {} },
      { pathname: `/v1/projects/${project.id}`, body: { code: '482917' } },
    ],
  );
});

test('project delete surfaces the server error message without adding owner-only copy', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-project-delete-error-home-'));
  writeConfig(HOME);

  await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/projects/shared') {
        sendJson(res, 200, {
          ok: true,
          data: {
            id: 'proj_shared',
            name: 'Shared',
            subdomain: 'shared',
            slug: 'shared',
            is_owner: false,
          },
        });
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/v1/projects/proj_shared') {
        sendJson(res, 403, {
          ok: false,
          error: 'FORBIDDEN',
          message: 'Delete requires project ownership.',
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['project', 'delete', 'shared', '--json'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      input: 'Shared\n',
    });

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      error: 'FORBIDDEN',
      message: 'Delete requires project ownership.',
    });
    assert.doesNotMatch(result.stdout, /owner-only/);
    assert.doesNotMatch(result.stderr, /owner-only/);
  });
});
