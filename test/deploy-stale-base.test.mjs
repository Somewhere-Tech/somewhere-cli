import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatStaleBaseExplanation } from '../dist/commands/deploy.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: {
        ...process.env,
        ...env,
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeLogin(home, token = 'smt_stale_base') {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token,
    user: { email: 'dev@example.com', username: 'dev' },
  }) + '\n');
}

function writeTempLogin(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_temp_stale_base',
    temporary: true,
    claim_url: 'https://somewhere.tech/claim?token=swtc_stale_base',
    user: { email: '', username: '' },
  }) + '\n');
}

function writeProject(dir, extra = {}) {
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_stale_base',
    name: 'stale-base',
    subdomain: 'stale-base',
    ...extra,
  }, null, 2) + '\n');
}

function readProject(dir) {
  return JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8'));
}

function writeFixture(dir) {
  writeFileSync(join(dir, 'index.html'), '<html><body>stale base</body></html>\n');
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

test('stale-base refusal copy names files, source, time, and next steps', () => {
  const rendered = formatStaleBaseExplanation({
    current_version: 9,
    base_version: 7,
    changed_files: ['index.html', 'about.html'],
    last_change_source: 'dashboard',
    last_change_at: '2026-07-07T10:00:00.000Z',
  }, Date.parse('2026-07-07T12:05:00.000Z'));

  assert.equal(rendered, [
    'This project changed since your last deploy from this machine — 2 files edited via the dashboard editor 2 hours ago: index.html, about.html. Your deploy was NOT applied.',
    'Remote is now v9; this machine last deployed v7.',
    '',
    'Next steps:',
    '  Run `somewhere pull` to bring the latest deployed source into this directory, review it, then deploy again.',
    '  Run `somewhere deploy --force` to overwrite those remote changes intentionally.',
  ].join('\n'));
});

test('stale-base refusal copy maps internal sources to product-safe language', () => {
  for (const source of ['worker', 'd1', 'api']) {
    const rendered = formatStaleBaseExplanation({
      current_version: 9,
      base_version: 7,
      changed_files: ['index.html'],
      last_change_source: source,
      last_change_at: '2026-07-07T10:00:00.000Z',
    }, Date.parse('2026-07-07T10:01:00.000Z'));

    assert.match(rendered, /1 file edited via the platform 1 minute ago: index\.html/);
    assert.doesNotMatch(rendered, /worker|d1|api/i);
  }
});

test('deploy writes state, leaves first payload legacy, then sends base_version and source', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-state-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-state-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir);
  writeFixture(fixtureDir);

  const bodies = [];
  let version = 12;

  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        bodies.push(JSON.parse(body));
        sendJson(res, 200, {
          ok: true,
          data: {
            version: version++,
            files: 1,
            url: 'https://stale-base.somewhere.tech',
            has_functions: false,
          },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };

    const first = await run(['deploy', '--json'], { cwd: fixtureDir, env });
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    assert.equal('base_version' in bodies[0], false, 'first-ever deploy must stay on the legacy path');
    assert.equal('source' in bodies[0], false, 'first-ever deploy should not add source without saved state');

    let project = readProject(fixtureDir);
    assert.deepEqual(project.last_deploy, {
      project_id: 'proj_stale_base',
      last_deployed_version: 12,
      at: project.last_deploy.at,
    });
    assert.ok(Number.isFinite(new Date(project.last_deploy.at).getTime()), 'state timestamp should be ISO-like');

    const second = await run(['deploy', '--json'], { cwd: fixtureDir, env });
    assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.equal(bodies[1].base_version, 12);
    assert.equal(bodies[1].source, 'cli');

    project = readProject(fixtureDir);
    assert.equal(project.last_deploy.project_id, 'proj_stale_base');
    assert.equal(project.last_deploy.last_deployed_version, 13);
  });
});

test('pull updates last_deploy so the next deploy uses the pulled current version', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-pull-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-pull-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 7,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  let deployBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/deploy/source') {
        sendJson(res, 200, {
          ok: true,
          data: {
            project_id: 'proj_stale_base',
            env: 'dev',
            version: 9,
            static_files: { 'index.html': '<html><body>remote current</body></html>\n' },
            binary_files: {},
            functions: {},
            counts: { static_files: 1, binary_files: 0, functions: 0 },
          },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: { version: 10, files: 1, url: 'https://stale-base.somewhere.tech', has_functions: false },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };
    const pull = await run(['pull', '--force', '--json'], { cwd: fixtureDir, env });
    assert.equal(pull.status, 0, `stdout:\n${pull.stdout}\nstderr:\n${pull.stderr}`);
    assert.equal(readProject(fixtureDir).last_deploy.last_deployed_version, 9);

    const deploy = await run(['deploy', '--json'], { cwd: fixtureDir, env });
    assert.equal(deploy.status, 0, `stdout:\n${deploy.stdout}\nstderr:\n${deploy.stderr}`);
    assert.equal(deployBody.base_version, 9);
    assert.equal(deployBody.source, 'cli');
  });
});

test('pull with skipped files does not advance last_deploy', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-pull-skip-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-pull-skip-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 7,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/deploy/source') {
        sendJson(res, 200, {
          ok: true,
          data: {
            project_id: 'proj_stale_base',
            env: 'dev',
            version: 9,
            static_files: { 'index.html': '<html><body>remote current</body></html>\n' },
            binary_files: {},
            functions: {},
            counts: { static_files: 1, binary_files: 0, functions: 0 },
          },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['pull'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Skipped 1 existing file/);
    assert.equal(readProject(fixtureDir).last_deploy.last_deployed_version, 7);
    assert.equal(readFileSync(join(fixtureDir, 'index.html'), 'utf8'), '<html><body>stale base</body></html>\n');
  });
});

test('pull does not advance state when remote-deleted files remain locally', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-pull-delete-skip-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-pull-delete-skip-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 7,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFileSync(join(fixtureDir, 'old.html'), '<html><body>deleted remotely</body></html>\n');

  await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/deploy/source') {
        sendJson(res, 200, {
          ok: true,
          data: {
            project_id: 'proj_stale_base',
            env: 'dev',
            version: 9,
            static_files: { 'index.html': '<html><body>remote current</body></html>\n' },
            binary_files: {},
            functions: {},
            counts: { static_files: 1, binary_files: 0, functions: 0 },
          },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['pull'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Skipped removing 1 file deleted remotely/);
    assert.equal(readProject(fixtureDir).last_deploy.last_deployed_version, 7);
    assert.equal(existsSync(join(fixtureDir, 'old.html')), true);
  });
});

test('pull --force removes remote deletions before advancing state', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-pull-delete-force-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-pull-delete-force-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 7,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>old index</body></html>\n');
  writeFileSync(join(fixtureDir, 'old.html'), '<html><body>deleted remotely</body></html>\n');

  let deployBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/deploy/source') {
        sendJson(res, 200, {
          ok: true,
          data: {
            project_id: 'proj_stale_base',
            env: 'dev',
            version: 9,
            static_files: { 'index.html': '<html><body>remote current</body></html>\n' },
            binary_files: {},
            functions: {},
            counts: { static_files: 1, binary_files: 0, functions: 0 },
          },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: { version: 10, files: 1, url: 'https://stale-base.somewhere.tech', has_functions: false },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };
    const pull = await run(['pull', '--force', '--json'], { cwd: fixtureDir, env });
    assert.equal(pull.status, 0, `stdout:\n${pull.stdout}\nstderr:\n${pull.stderr}`);
    assert.equal(existsSync(join(fixtureDir, 'old.html')), false);
    assert.equal(readFileSync(join(fixtureDir, 'index.html'), 'utf8'), '<html><body>remote current</body></html>\n');
    assert.equal(readProject(fixtureDir).last_deploy.last_deployed_version, 9);

    const deploy = await run(['deploy', '--json'], { cwd: fixtureDir, env });
    assert.equal(deploy.status, 0, `stdout:\n${deploy.stdout}\nstderr:\n${deploy.stderr}`);
    assert.equal(deployBody.base_version, 9);
    assert.equal('old.html' in deployBody.files, false);
  });
});

test('pull --out updates only the output directory project state', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-pull-out-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-pull-out-fixture-'));
  const outDir = join(fixtureDir, 'pulled');
  mkdirSync(outDir);
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 7,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeProject(outDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 7,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/deploy/source') {
        sendJson(res, 200, {
          ok: true,
          data: {
            project_id: 'proj_stale_base',
            env: 'dev',
            version: 9,
            static_files: { 'index.html': '<html><body>remote current</body></html>\n' },
            binary_files: {},
            functions: {},
            counts: { static_files: 1, binary_files: 0, functions: 0 },
          },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['pull', '--out', outDir, '--json'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(readProject(fixtureDir).last_deploy.last_deployed_version, 7);
    assert.equal(readProject(outDir).last_deploy.last_deployed_version, 9);
    assert.equal(readFileSync(join(outDir, 'index.html'), 'utf8'), '<html><body>remote current</body></html>\n');
  });
});

test('409 STALE_BASE renders a refusal instead of falling through to a generic error', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-409-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-409-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 7,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  const bodies = [];
  const changedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        bodies.push(JSON.parse(body));
        sendJson(res, 409, {
          error: 'STALE_BASE',
          current_version: 9,
          base_version: 7,
          changed_files: ['index.html', 'about.html'],
          last_change_source: 'dashboard',
          last_change_at: changedAt,
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['deploy'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(bodies[0].base_version, 7);
    assert.equal(bodies[0].source, 'cli');
    assert.match(
      result.stderr,
      /This project changed since your last deploy from this machine — 2 files edited via the dashboard editor 2 hours ago: index\.html, about\.html\. Your deploy was NOT applied\./,
    );
    assert.match(result.stderr, /Run `somewhere pull`/);
    assert.match(result.stderr, /Run `somewhere deploy --force`/);
    assert.doesNotMatch(result.stderr, /\[STALE_BASE/);
  });
});

test('negative saved version is treated as absent and never sent as base_version', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-negative-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-negative-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: -1,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  let deployBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: { version: 1, files: 1, url: 'https://stale-base.somewhere.tech', has_functions: false },
        });
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
    assert.equal('base_version' in deployBody, false);
    assert.equal('source' in deployBody, false);
  });
});

test('project refs that are not the canonical linked project_id do not reuse saved state', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-wrong-project-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-wrong-project-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    project_id: 'proj_source_copy',
    name: 'copied-site',
    subdomain: 'copied-site',
    last_deploy: {
      project_id: 'proj_source_copy',
      last_deployed_version: 4,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  let deployBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: { version: 8, files: 1, url: 'https://target-site.somewhere.tech', has_functions: false },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['deploy', '--project', 'copied-site', '--json'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(deployBody.project_id, 'copied-site');
    assert.equal('base_version' in deployBody, false);
    assert.equal('source' in deployBody, false);
  });
});

test('deploy --force without --yes fails fast in non-TTY shells', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-force-nontty-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-force-nontty-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir);
  writeFixture(fixtureDir);

  const result = await run(['deploy', '--force'], {
    cwd: fixtureDir,
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: 'http://127.0.0.1:9/v1' },
  });

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /non-interactive shell/);
  assert.match(result.stderr, /somewhere deploy --force --yes/);
});

test('deploy --force --yes sends force:true with the saved base_version', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-force-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-force-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 4,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  let deployBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: { version: 5, files: 1, url: 'https://stale-base.somewhere.tech', has_functions: false },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['deploy', '--force', '--yes', '--json'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(deployBody.base_version, 4);
    assert.equal(deployBody.source, 'cli');
    assert.equal(deployBody.force, true);
    assert.equal(readProject(fixtureDir).last_deploy.last_deployed_version, 5);
  });
});

test('deploy with function_errors does not advance last_deploy state', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-fnerr-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-fnerr-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 7,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  let deployBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: {
            version: 99,
            files: 1,
            url: 'https://stale-base.somewhere.tech',
            has_functions: true,
            function_errors: [{ route: 'api/fail', error: 'boom' }],
          },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['deploy', '--json'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(deployBody.base_version, 7);
    assert.equal(readProject(fixtureDir).last_deploy.last_deployed_version, 7);
  });
});

test('deploy --temporary does not send or update saved stale-base state', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-temp-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-temp-fixture-'));
  writeTempLogin(HOME);
  writeProject(fixtureDir, {
    last_deploy: {
      project_id: 'proj_stale_base',
      last_deployed_version: 3,
      at: '2026-07-07T09:00:00.000Z',
    },
  });
  writeFixture(fixtureDir);

  let deployBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: { version: 9, files: 1, url: 'https://stale-base.somewhere.tech', has_functions: false },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['deploy', '--temporary', '--json'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal('base_version' in deployBody, false);
    assert.equal('source' in deployBody, false);
    assert.equal(readProject(fixtureDir).last_deploy.last_deployed_version, 3);
  });
});

test('promote writes the returned version to the linked project state', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-stale-promote-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-stale-promote-fixture-'));
  writeLogin(HOME);
  writeProject(fixtureDir);

  let promoteBody = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/promote') {
        promoteBody = JSON.parse(body);
        sendJson(res, 200, {
          ok: true,
          data: { version: 21, files_promoted: 2, has_functions: false },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  }, async (apiUrl) => {
    const result = await run(['promote', '--yes', '--json'], {
      cwd: fixtureDir,
      env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(promoteBody.project_id, 'proj_stale_base');
    const project = readProject(fixtureDir);
    assert.equal(project.last_deploy.project_id, 'proj_stale_base');
    assert.equal(project.last_deploy.last_deployed_version, 21);
    assert.ok(Number.isFinite(new Date(project.last_deploy.at).getTime()), 'promote state timestamp should be ISO-like');
  });
});
