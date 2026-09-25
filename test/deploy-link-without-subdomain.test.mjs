// A `.somewhere.json` holding only project_id (no subdomain) used to deploy
// successfully and then print "Deploy failed … reading 'trim'" and exit 1
// (pfb_c25665360473). The success path now reads the subdomain from the
// project record and prints the live URL. Both directions:
//   - link without subdomain: exit 0, the live URL from the project record;
//   - the lookup fails: still exit 0, no URL, no "Deploy failed";
//   - link with subdomain: exit 0, its URL, no project lookup.
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
const PROJECT = 'proj_link_no_subdomain';

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
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

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function deployWith(link, { projectRecord }) {
  const home = mkdtempSync(join(tmpdir(), 'sw-link-nosub-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-link-nosub-fixture-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_link_no_subdomain',
    user: { email: 'dev@example.com', username: 'dev' },
  }) + '\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify(link) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>link without subdomain</body></html>\n');
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push(`${req.method} ${req.url.split('?')[0]}`);
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        // The live release response: project_id, no url, no subdomain.
        return sendJson(res, 200, { ok: true, data: {
          project_id: PROJECT, version: 1, release_id: 'rel_1', active_release_id: 'rel_1',
          base_release_id: null, files_deployed: 1, has_functions: false, warnings: [],
          status: 'success', release_publish: true,
        } });
      }
      if (req.method === 'GET' && req.url.split('?')[0] === `/v1/projects/${PROJECT}` && projectRecord) {
        return sendJson(res, 200, { ok: true, data: { id: PROJECT, name: 'nosub', subdomain: 'nosub-app' } });
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await run(['deploy'], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    });
    return { ...result, requests };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a link file without subdomain deploys and prints the live URL from the project record', async () => {
  const r = await deployWith({ project_id: PROJECT }, { projectRecord: true });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.doesNotMatch(out, /Deploy failed|reading 'trim'/);
  assert.match(out, /Live at https:\/\/nosub-app\.somewhere\.site/);
  assert.ok(r.requests.includes(`GET /v1/projects/${PROJECT}`), JSON.stringify(r.requests));
});

test('a failed project lookup still reports the successful deploy', async () => {
  const r = await deployWith({ project_id: PROJECT }, { projectRecord: false });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.doesNotMatch(out, /Deploy failed|reading 'trim'/);
  assert.match(out, /Deployed — check the dashboard for the live URL\./);
});

test('a link file with subdomain prints its URL without a project lookup', async () => {
  const r = await deployWith({ project_id: PROJECT, name: 'nosub', subdomain: 'linked-app' }, { projectRecord: true });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.match(out, /Live at https:\/\/linked-app\.somewhere\.site/);
  assert.ok(!r.requests.includes(`GET /v1/projects/${PROJECT}`), JSON.stringify(r.requests));
});
