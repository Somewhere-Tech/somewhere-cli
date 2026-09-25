import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere promote` keeps production functions the preview does not include
// and lists them; `--prune` asks the platform to remove them (replace_functions).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const SESSION = 'draft_11111111-1111-4111-8111-111111111111';
const PREVIEW = 'rel_candidate_prune';

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sw-prune-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-prune-fixture-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_prune',
    user: { email: 'dev@example.com', username: 'dev' },
  }) + '\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_prune',
    name: 'prune',
    subdomain: 'prune',
  }, null, 2) + '\n');
  return { home, dir };
}

/** A platform whose promote answers like the live one: kept or removed, by flag. */
async function promoteAgainstPlatform(args) {
  const { home, dir } = fixture();
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/promote') {
        const parsed = JSON.parse(body);
        bodies.push(parsed);
        const orphans = ['api/legacy-webhook', 'api/old-report'];
        sendJson(res, 200, {
          ok: true,
          data: {
            version: 7,
            files_promoted: 2,
            has_functions: true,
            ...(parsed.replace_functions === true
              ? { removed_functions: orphans }
              : { preserved_functions: orphans }),
          },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const result = await run(['promote', SESSION, PREVIEW, '--yes', ...args], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });
    return { result, bodies };
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

test('default promote sends no replace_functions and lists the production functions it kept', async () => {
  const { result, bodies } = await promoteAgainstPlatform([]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(bodies.length, 1);
  assert.equal(Object.hasOwn(bodies[0], 'replace_functions'), false);
  assert.match(
    result.stdout,
    /Kept 2 production function\(s\) the preview did not include: api\/legacy-webhook, api\/old-report \(pass --prune to remove them\)/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Removed \d+ production function/);

  const json = await promoteAgainstPlatform(['--json']);
  assert.equal(json.result.status, 0, json.result.stderr);
  assert.equal(Object.hasOwn(json.bodies[0], 'replace_functions'), false);
  const parsed = JSON.parse(json.result.stdout);
  assert.deepEqual(parsed.preserved_functions, ['api/legacy-webhook', 'api/old-report']);
  assert.equal(parsed.removed_functions, undefined);
});

test('promote --prune sends replace_functions: true and lists the production functions it removed', async () => {
  const { result, bodies } = await promoteAgainstPlatform(['--prune']);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].replace_functions, true);
  assert.match(
    result.stdout,
    /Removed 2 production function\(s\) the preview did not include: api\/legacy-webhook, api\/old-report\./,
  );
  assert.doesNotMatch(result.stdout, /Kept \d+ production function/);

  const json = await promoteAgainstPlatform(['--prune', '--json']);
  assert.equal(json.result.status, 0, json.result.stderr);
  assert.equal(json.bodies[0].replace_functions, true);
  const parsed = JSON.parse(json.result.stdout);
  assert.deepEqual(parsed.removed_functions, ['api/legacy-webhook', 'api/old-report']);
  assert.equal(parsed.preserved_functions, undefined);
});
