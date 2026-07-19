import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(
      sourceRunner ?? process.execPath,
      sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args],
      {
        cwd,
        env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `sw-pinned-${label}-home-`));
  const fixtureDir = mkdtempSync(join(tmpdir(), `sw-pinned-${label}-fixture-`));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: `smt_pinned_${label}`,
    user: { email: `${label}@example.com`, username: label },
  }) + '\n');
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: `proj_${label}`,
    name: label,
    subdomain: label,
  }) + '\n');
  writeFileSync(join(fixtureDir, 'index.html'), `<html><body>${label}</body></html>\n`);
  return { home, fixtureDir };
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

async function runDeployCase(label, responses) {
  const { home, fixtureDir } = writeFixture(label);
  const bodies = [];
  let result;

  await withServer((req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, data: { project_id: `proj_${label}`, notices: [] } });
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/deploy') {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
        return;
      }

      bodies.push(JSON.parse(body));
      const response = responses[bodies.length - 1];
      if (!response) {
        sendJson(res, 500, { ok: false, error: 'THIRD_REQUEST', message: 'Unexpected third request.' });
        return;
      }
      sendJson(res, response.status, response.payload);
    });
  }, async (apiUrl) => {
    result = await run(['deploy', '--json'], {
      cwd: fixtureDir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });
  });

  return { bodies, result };
}

const successResponse = {
  status: 200,
  payload: {
    ok: true,
    data: {
      version: 1,
      files: 1,
      url: 'https://pinned.somewhere.tech',
      has_functions: false,
    },
  },
};

const baseRequiredResponse = {
  status: 400,
  payload: {
    ok: false,
    error: 'BASE_RELEASE_REQUIRED',
    message: 'Pinned projects require a release base.',
    data: { active_release_id: 'rel-current' },
  },
};

test('pinned-release retry contract and endpoint coverage', async () => {
  const unpinned = await runDeployCase('unpinned', [successResponse]);
  assert.equal(unpinned.result.status, 0, unpinned.result.stderr);
  assert.equal(unpinned.bodies.length, 1, 'unpinned deploy should send exactly one request');
  assert.equal('base_release_id' in unpinned.bodies[0], false);

  const pinned = await runDeployCase('pinned', [baseRequiredResponse, successResponse]);
  assert.equal(pinned.result.status, 0, pinned.result.stderr);
  assert.equal(pinned.bodies.length, 2, 'pinned deploy should retry exactly once');
  assert.equal('base_release_id' in pinned.bodies[0], false, 'the first payload must remain unchanged');
  assert.deepEqual(pinned.bodies[1], {
    ...pinned.bodies[0],
    base_release_id: 'rel-current',
  });

  const staleResponse = {
    status: 409,
    payload: {
      ok: false,
      error: 'STALE_RELEASE_BASE',
      message: 'Another publish landed first.',
      data: { base_release_id: 'rel-current', active_release_id: 'rel-new' },
    },
  };
  const stale = await runDeployCase('stale', [baseRequiredResponse, staleResponse]);
  assert.equal(stale.result.status, 1);
  assert.equal(stale.bodies.length, 2, 'STALE_RELEASE_BASE must not trigger a third request');
  assert.deepEqual(JSON.parse(stale.result.stdout), {
    ok: false,
    error: 'STALE_RELEASE_BASE',
    message: 'Another publish landed first.',
  });

  const deploySource = readFileSync(new URL('../src/commands/deploy.ts', import.meta.url), 'utf8');
  assert.match(
    deploySource,
    /client\.call<T>\('POST', '\/deploy', requestBody[\s\S]+pinnedReleaseRetryBody\(err, body\)/,
    'production deploy should share its two-request budget with the pinned retry',
  );

  const devSource = readFileSync(new URL('../src/commands/dev.ts', import.meta.url), 'utf8');
  const wrappedDevPaths = [...devSource.matchAll(
    /callWithPinnedReleaseRetry\([\s\S]*?client\.call<[^>]+>\('POST', '([^']+)', requestBody/g,
  )].map((match) => match[1]);
  assert.deepEqual(wrappedDevPaths, ['/deploy', '/deploy/patch']);
});
