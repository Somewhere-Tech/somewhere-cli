// tsk_fc1afab0: no implicit live deploy or account use. The live deploy test
// and the round-trip script run only with BOTH SOMEWHERE_LIVE_DEPLOY_TEST=1 and
// SOMEWHERE_TEST_TOKEN, and never pick up the signed-in ~/.somewhere login.
// Every case here is a refusal: the case with both set would deploy to the
// real platform, so it is not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveDeployCredential } from '../scripts/live-test-gate.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the gate needs both the opt-in and the test token, from the environment only', () => {
  assert.equal(liveDeployCredential({}).ok, false);
  assert.equal(liveDeployCredential({ SOMEWHERE_TEST_TOKEN: 'smt_x' }).ok, false, 'a token alone is not an opt-in');
  assert.equal(liveDeployCredential({ SOMEWHERE_LIVE_DEPLOY_TEST: '1' }).ok, false, 'an opt-in alone has no credential');
  assert.equal(liveDeployCredential({ SOMEWHERE_LIVE_DEPLOY_TEST: 'true', SOMEWHERE_TEST_TOKEN: 'smt_x' }).ok, false, 'only "1" opts in');
  assert.equal(liveDeployCredential({ SOMEWHERE_LIVE_DEPLOY_TEST: '1', SOMEWHERE_TEST_TOKEN: '  ' }).ok, false);
  assert.deepEqual(liveDeployCredential({ SOMEWHERE_LIVE_DEPLOY_TEST: '1', SOMEWHERE_TEST_TOKEN: ' smt_x ' }), { ok: true, token: 'smt_x' });
  assert.match(liveDeployCredential({ SOMEWHERE_LIVE_DEPLOY_TEST: '1' }).reason, /never the signed-in ~\/\.somewhere\/config\.json/);
});

/** A HOME that looks signed in, so a fallback to it would be visible. */
function signedInHome() {
  const home = mkdtempSync(join(tmpdir(), 'sw-live-gate-home-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_signed_in_fixture', user: { email: 'dev@example.invalid' } }) + '\n');
  return home;
}

function childEnv(home, apiUrl, extra) {
  const env = { ...process.env };
  delete env.SOMEWHERE_LIVE_DEPLOY_TEST;
  delete env.SOMEWHERE_TEST_TOKEN;
  delete env.SOMEWHERE_CONFIG_DIR;
  delete env.NODE_TEST_CONTEXT;
  return { ...env, HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl, CI: '1', ...extra };
}

function runNode(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function withRecordingApi(fn) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 500;
    res.end('{"ok":false,"error":"FIXTURE_REFUSES"}');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, requests);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

const REFUSED = [
  ['signed in, nothing else', {}],
  ['signed in plus a test token, no opt-in', { SOMEWHERE_TEST_TOKEN: 'smt_test_fixture' }],
  ['signed in plus the opt-in, no test token', { SOMEWHERE_LIVE_DEPLOY_TEST: '1' }],
];

for (const [label, extra] of REFUSED) {
  test(`the live deploy test skips and makes no request: ${label}`, async () => {
    await withRecordingApi(async (apiUrl, requests) => {
      const result = await runNode(['--test', 'test/deploy-outcome-live.test.mjs'], childEnv(signedInHome(), apiUrl, extra));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /^# skipped 1$/m);
      assert.match(result.stdout, /^# pass 0$/m);
      assert.match(result.stdout, /SOMEWHERE_LIVE_DEPLOY_SKIPPED/);
      assert.deepEqual(requests, []);
    });
  });

  test(`the round-trip script refuses before any request: ${label}`, async () => {
    await withRecordingApi(async (apiUrl, requests) => {
      const result = await runNode(['scripts/e2e-roundtrip.mjs'], childEnv(signedInHome(), apiUrl, extra));
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /SOMEWHERE_LIVE_DEPLOY_SKIPPED/);
      assert.equal(result.stdout, '');
      assert.deepEqual(requests, []);
    });
  });
}
