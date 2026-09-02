import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function cliInvocation(args) {
  const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
  return sourceRunner
    ? { command: sourceRunner, args: [sourceIndex, ...args] }
    : { command: process.execPath, args: [distIndex, ...args] };
}

function run(args, { cwd = repoRoot, env }) {
  return new Promise((resolvePromise) => {
    const invocation = cliInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
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

function runFollow(args, { cwd = repoRoot, env, stop }) {
  return new Promise((resolvePromise) => {
    const invocation = cliInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => child.kill('SIGTERM'),
      process.env.SOMEWHERE_TEST_SOURCE_RUNNER ? 20_000 : 9000,
    );
    stop(() => setTimeout(() => child.kill('SIGTERM'), 100));
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      resolvePromise({ status, signal, stdout, stderr });
    });
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

async function closedApiUrl() {
  const server = createServer((_req, res) => res.end('closed'));
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return `http://127.0.0.1:${port}/v1`;
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

test('browser --json reports an unhealthy linked-directory URL as EYES passed:false', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-browser-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-json-browser-fixture-'));
  writeConfig(HOME);
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_linked_browser',
    name: 'linked-browser',
    subdomain: 'linked-browser',
  }) + '\n');
  let browserBody = null;

  await withServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/browser/test') {
        browserBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: {
            passed: true,
            final_url: 'https://third-party.test/missing',
            console_errors: ['resource failed'],
            page_errors: [],
            failed_requests: [{ status: 404, url: 'https://third-party.test/missing.js' }],
          },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['browser', 'https://third-party.test/missing', '--json'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(browserBody, { url: 'https://third-party.test/missing' });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.passed, false);
    assert.equal(payload.failed_requests.length, 1);
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

test('logs --follow --json suppresses overlapping log IDs across poll cycles', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-logs-follow-home-'));
  writeConfig(HOME);

  const log1 = {
    id: 'log_1',
    level: 'info',
    message: 'initial',
    source: 'function',
    created_at: '2026-07-03T10:00:00.000Z',
  };
  const log2 = {
    id: 'log_2',
    level: 'info',
    message: 'second',
    source: 'function',
    created_at: '2026-07-03T10:00:01.000Z',
  };
  const log3 = {
    id: 'log_3',
    level: 'warn',
    message: 'third',
    source: 'function',
    created_at: '2026-07-03T10:00:02.000Z',
  };
  const batches = [
    [log1],
    [log1, log2],
    [log2, log3],
  ];
  const afters = [];
  let requests = 0;
  let stopFollow = () => {};

  await withServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/logs') {
      afters.push(url.searchParams.get('after'));
      const logs = batches[Math.min(requests, batches.length - 1)];
      requests += 1;
      sendJson(res, 200, { ok: true, data: { logs, has_more: false, cursor: null } });
      if (requests >= batches.length) stopFollow();
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
  }, async (apiUrl) => {
    const result = await runFollow(['logs', 'proj_json_logs', '--json', '--follow'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      stop: (fn) => {
        stopFollow = fn;
      },
    });

    assert.ok(requests >= 3, `expected at least three /logs requests; got ${requests}`);
    assert.ok(
      result.signal === 'SIGTERM' || result.status !== 0,
      `follower did not terminate as expected\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const lines = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.id), ['log_1', 'log_2', 'log_3']);
    assert.equal(new Set(lines.map((line) => line.id)).size, lines.length);
    assert.deepEqual(afters.slice(1, 3), [log1.created_at, log2.created_at]);
  });
});

test('rollback --json emits JSON errors for API failures', async () => {
  const cases = [
    {
      status: 500,
      error: 'ROLLBACK_FAILED',
      message: 'Rollback API failed.',
    },
    {
      status: 409,
      error: 'NO_ROLLBACK_TARGET',
      message: 'No deploys to roll back to.',
    },
  ];

  for (const apiError of cases) {
    const HOME = mkdtempSync(join(tmpdir(), 'sw-json-rollback-api-home-'));
    writeConfig(HOME);

    await withServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/promote/rollback') {
        sendJson(res, apiError.status, {
          ok: false,
          error: apiError.error,
          message: apiError.message,
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    }, async (apiUrl) => {
      const result = await run(['rollback', 'proj_json_rollback', '--json', '--yes'], {
        env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      });

      assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        error: apiError.error,
        message: apiError.message,
      });
      assert.equal(result.stderr.trim(), '');
      assert.doesNotMatch(result.stdout, /Rollback failed|✗/);
    });
  }
});

test('rollback --json emits JSON errors for network failures', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-rollback-network-home-'));
  writeConfig(HOME);
  const apiUrl = await closedApiUrl();

  const result = await run(['rollback', 'proj_json_rollback', '--json', '--yes'], {
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
  });

  assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'NETWORK_ERROR');
  assert.match(body.message, /Could not reach POST .*\/promote\/rollback/);
  assert.equal(result.stderr.trim(), '');
  assert.doesNotMatch(result.stdout, /Rollback failed|✗/);
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

test('api accepts explicit --json and emits the parsed response', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-api-home-'));
  writeConfig(HOME);

  await withServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/projects') {
      sendJson(res, 200, { ok: true, data: { projects: [{ id: 'proj_api' }] } });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
  }, async (apiUrl) => {
    const result = await run(['api', 'GET', '/v1/projects', '--json'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { projects: [{ id: 'proj_api' }] });
  });
});

test('rollback replaces stale snapshot wording while preserving JSON', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-rollback-snapshot-home-'));
  writeConfig(HOME);

  await withServer((req, res) => {
    sendJson(res, 404, {
      ok: false,
      error: 'NOT_FOUND',
      message: 'Version v6 has no restorable snapshot (it was edited in place before snapshots covered this path).',
    });
  }, async (apiUrl) => {
    const result = await run(['rollback', 'proj_snapshot', '--yes', '--json'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(payload.error, 'NOT_FOUND');
    assert.match(payload.message, /could not find a restorable previous production release/);
    assert.doesNotMatch(payload.message, /before snapshots covered this path/);
  });
});

/**
 * This case is about the JSON SHAPE every `--json` command emits on a terminal
 * path — it needs no live platform, and must never touch one.
 *
 * It used to run with no SOMEWHERE_API_URL at all, so `deploy`, `deploy-check`
 * and `browser` ran logged-out against api.somewhere.tech. `somewhere deploy`
 * is anonymous-when-logged-out, so every `npm test` minted a real temporary
 * account and a real project named after the mkdtemp working directory
 * (sw-json-contract-cwd-*). 14+ landed on production on 2026-09-01 alone, and
 * the case asserted nothing about what those deploys DID — it was a green
 * light over a red surface (tsk_e929774b).
 *
 * Everything now points at the local stub, which answers every route with a
 * JSON error. A command that reaches the network still takes a terminal path;
 * it just takes it against 127.0.0.1. For an assertion about a REAL deploy's
 * outcome, see test/deploy-outcome-live.test.mjs.
 */
test('every command advertising --json emits parseable JSON on an error or terminal path', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-contract-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'sw-json-contract-cwd-'));
  writeFileSync(join(cwd, 'already.env'), 'EXISTING=value\n');

  const cases = [
    ['whoami', '--json'],
    ['init', '--json'],
    ['project', 'create', 'contract', '--json'],
    ['project', 'list', '--json'],
    ['projects', '--json'],
    ['project', 'view', 'contract', '--json'],
    ['project', 'delete', 'contract', '--json'],
    ['deploy', '--json'],
    ['pull', '--json'],
    ['typecheck', '--json'],
    ['promote', '--json', '--yes'],
    ['rollback', 'contract', '--json', '--yes'],
    ['db', 'query', 'SELECT 1', '--json'],
    ['db', 'dump', '--json'],
    ['db', 'tables', '--json'],
    ['docs', 'not-a-topic', '--json'],
    ['logs', 'contract', '--json'],
    ['errors', 'contract', '--json'],
    ['env', 'list', '--json'],
    ['env', 'pull', '--json', '--out', 'already.env'],
    ['env', 'set', 'KEY', 'value', '--json'],
    ['env', 'delete', 'KEY', '--json'],
    ['run', 'missing-script.js', '--json'],
    ['status', 'contract', '--json'],
    ['exec', 'missing-function.ts', '--json'],
    ['browser', '--viewport', 'tablet', '--json'],
    ['deploy-check', '--json'],
    ['api', 'GET', '/projects', '--json'],
    ['check', '--json'],
  ];

  await withServer((req, res) => {
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: `stub: ${req.method} ${req.url}` });
  }, async (apiUrl) => {
    for (const args of cases) {
      const result = await run(args, {
        cwd,
        env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      });
      assert.doesNotThrow(
        () => JSON.parse(result.stdout),
        `${args.join(' ')} did not emit one JSON value\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.equal(
        result.stderr.trim(),
        '',
        `${args.join(' ')} leaked human output to stderr:\n${result.stderr}`,
      );
    }
  });
});

test('the --json contract case never reaches a remote platform', async () => {
  // The defect this guards is invisible in the assertions above: the case
  // passed just as green while it was deploying to production. So assert the
  // mechanism directly — every invocation in the case is pinned to the stub.
  const source = readFileSync(join(repoRoot, 'test', 'json-output.test.mjs'), 'utf8');
  const start = source.indexOf("test('every command advertising --json emits parseable JSON");
  assert.ok(start > 0, 'the --json contract case is still in this file');
  const body = source.slice(start, source.indexOf('\ntest(', start + 1));
  assert.ok(
    body.includes('SOMEWHERE_API_URL: apiUrl'),
    'the --json contract case must run every command against the local stub, never a remote platform',
  );
  assert.ok(
    /await withServer\(/.test(body),
    'the --json contract case must be wrapped in withServer',
  );
});

test('logs --follow keeps polling when the initial query has no matches', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-empty-follow-home-'));
  writeConfig(HOME);

  const appeared = {
    id: 'log_after_empty',
    level: 'info',
    message: 'arrived later',
    created_at: '2026-07-09T12:00:00.000Z',
  };
  let requests = 0;
  let stopFollow = () => {};

  await withServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/logs') {
      requests += 1;
      sendJson(res, 200, {
        ok: true,
        data: { logs: requests === 1 ? [] : [appeared] },
      });
      if (requests >= 2) stopFollow();
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
  }, async (apiUrl) => {
    const result = await runFollow(['logs', 'proj_empty', '--json', '--follow', '--since', '15m'], {
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      stop: (fn) => {
        stopFollow = fn;
      },
    });

    assert.ok(requests >= 2, `expected follow-up poll, got ${requests} request(s)`);
    const lines = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(lines, [appeared]);
  });
});

test('init --link --project links an exact existing project non-interactively', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-init-link-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'sw-json-init-link-cwd-'));
  writeConfig(HOME);
  const project = {
    id: 'proj_link_exact',
    name: 'Existing App',
    slug: 'existing-app',
    subdomain: 'existing-app',
  };

  await withServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/projects') {
      sendJson(res, 200, { ok: true, data: { projects: [project] } });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
  }, async (apiUrl) => {
    const result = await run(['init', '--link', '--project', 'existing-app', '--json'], {
      cwd,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), project);
    assert.deepEqual(
      JSON.parse(readFileSync(join(cwd, '.somewhere.json'), 'utf8')),
      { project_id: project.id, name: project.name, subdomain: project.subdomain },
    );
  });
});

test('init creates the happy-path starter in an empty directory and preserves existing source', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-json-init-scaffold-home-'));
  writeConfig(HOME);
  const project = {
    id: 'proj_init_scaffold',
    name: 'Scaffold App',
    slug: 'scaffold-app',
    subdomain: 'scaffold-app',
  };

  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/projects') {
        sendJson(res, 200, { ok: true, data: project });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const empty = mkdtempSync(join(tmpdir(), 'sw-json-init-scaffold-empty-'));
    const created = await run(['init', '--name', project.name, '--json'], {
      cwd: empty,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });
    assert.equal(created.status, 0, `stdout:\n${created.stdout}\nstderr:\n${created.stderr}`);
    assert.deepEqual(JSON.parse(created.stdout), project);
    const authHandler = readFileSync(join(empty, 'api/auth/[...path].ts'), 'utf8');
    assert.match(
      authHandler,
      /from '@somewhere-tech\/sdk\/server'/,
    );
    assert.match(authHandler, /return somewhereAuth\(req, sw\)/);
    assert.doesNotMatch(authHandler, /loginWithCookie|signupWithCookie|logoutWithCookie/);
    assert.equal(
      JSON.parse(readFileSync(join(empty, 'package.json'), 'utf8'))
        .dependencies['@somewhere-tech/sdk'],
      '^0.7.2',
    );

    const existing = mkdtempSync(join(tmpdir(), 'sw-json-init-scaffold-existing-'));
    writeFileSync(join(existing, 'app.ts'), 'export const mine = true;\n');
    const preserved = await run(['init', '--name', project.name, '--json'], {
      cwd: existing,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });
    assert.equal(preserved.status, 0, `stdout:\n${preserved.stdout}\nstderr:\n${preserved.stderr}`);
    assert.equal(readFileSync(join(existing, 'app.ts'), 'utf8'), 'export const mine = true;\n');
    assert.throws(() => readFileSync(join(existing, 'package.json')), /ENOENT/);
  });
});

test('deploy prints a warning once when it also appears in the build log', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-warning-dedupe-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-warning-dedupe-fixture-'));
  writeConfig(HOME);
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_warning',
    name: 'warning',
    subdomain: 'warning',
  }) + '\n');
  writeFileSync(join(fixtureDir, 'index.html'), '<html></html>\n');
  const warning = 'Functions are still finishing propagation.';

  await withServer((req, res) => {
    req.resume();
    req.on('end', () => sendJson(res, 200, {
      ok: true,
      data: {
        files: 1,
        url: 'https://warning.somewhere.tech',
        has_functions: false,
        build_log: [`warning: ${warning}`],
        warnings: [warning],
      },
    }));
  }, async (apiUrl) => {
    const result = await run(['deploy'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.split(warning).length - 1, 1, result.stdout);
  });
});
