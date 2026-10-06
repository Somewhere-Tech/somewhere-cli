/**
 * The one test in this suite that deploys for real — and the only one allowed
 * to (tsk_e929774b).
 *
 * Why it exists: test/json-output.test.mjs used to run `deploy --json` with no
 * API URL and no credential, so every `npm test` deployed anonymously to the
 * live platform, minting a temporary account and a project named after its
 * mkdtemp working directory. It asserted only that stdout parsed as JSON, so
 * the suite reported green on runs whose deploys were failing post-verify and
 * rolling back. A test that triggers a real deploy and cannot see it fail is
 * worse than no test.
 *
 * So the shape contract moved to a local stub, and the real-deploy assertion
 * moved here, with three rules:
 *
 *   1. It runs on an EXPLICITLY CREATED throwaway with a name that says what it
 *      is, never on whatever project the working directory happens to point at,
 *      and never via the anonymous path.
 *   2. It asserts the deploy OUTCOME — exit status, the release the payload says
 *      went live, and what the live URL actually serves.
 *   3. It requests immediate permanent erasure with `purge=1` and confirms the
 *      serving host returns 404, in a finally block, so a mid-test failure
 *      cannot leave production junk behind.
 *
 * It runs only with BOTH SOMEWHERE_LIVE_DEPLOY_TEST=1 and SOMEWHERE_TEST_TOKEN
 * set. Otherwise it skips with a named reason: it never falls back to an
 * anonymous deploy, and never to the signed-in ~/.somewhere/config.json, which
 * made a plain `npm test` deploy on the developer's own account (tsk_fc1afab0).
 *
 *   SOMEWHERE_LIVE_DEPLOY_TEST=1 SOMEWHERE_TEST_TOKEN=<test account key> \
 *     node --test test/deploy-outcome-live.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveDeployCredential } from '../scripts/live-test-gate.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const API = (process.env.SOMEWHERE_API_URL || 'https://api.somewhere.tech/v1').replace(/\/$/, '');

// Both an explicit opt-in and an explicit test credential, from the
// environment only; the signed-in ~/.somewhere/config.json is never read
// (tsk_fc1afab0). Without both, this test skips and makes no request.
const gate = liveDeployCredential();
const credential = gate.ok ? { token: gate.token } : null;
const SKIP_REASON = gate.ok ? '' : gate.reason;

function run(args, { cwd, home }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'),
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

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${credential.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON body — status is what matters to the callers below */
  }
  return { status: res.status, payload };
}

/**
 * Delete is deliberately two-step on the platform: an unconfirmed DELETE mints
 * a code and changes nothing. Both steps run here, then the project is read
 * back to prove it is actually gone rather than merely requested.
 */
async function purge(projectId, subdomain) {
  const path = `/projects/${encodeURIComponent(projectId)}?purge=1`;
  const first = await api('DELETE', path, {});
  const code = first.payload?.data?.code ?? first.payload?.code;
  assert.ok(code, `expected a delete confirmation code, got ${first.status}: ${JSON.stringify(first.payload)}`);
  const second = await api('DELETE', path, { code });
  assert.ok(
    second.status >= 200 && second.status < 300,
    `delete confirm failed ${second.status}: ${JSON.stringify(second.payload)}`,
  );
  assert.equal(
    second.payload?.data?.purged ?? second.payload?.purged,
    true,
    `delete confirm did not accept purge=1: ${JSON.stringify(second.payload)}`,
  );
  const readBack = await api('GET', `/projects/${encodeURIComponent(projectId)}`);
  const queuedForPurge = readBack.status === 200
    && (readBack.payload?.deleted === true || readBack.payload?.data?.deleted === true);
  assert.ok(
    readBack.status === 404 || queuedForPurge,
    `purged throwaway ${projectId} is still live (HTTP ${readBack.status}): ${JSON.stringify(readBack.payload)}`,
  );

  const liveUrl = `https://${subdomain}.somewhere.site`;
  let hostStatus = 0;
  // Taking a project offline is asynchronous. The delete response is the
  // accepted purge, not proof that every serving route has observed it yet:
  // live measurements on 2026-09-02 reached 404 after roughly 45 seconds.
  // Keep the required host-level proof, with a bounded window that covers
  // normal propagation instead of turning a correct purge into a false red.
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(liveUrl, { headers: { 'Cache-Control': 'no-cache' } });
    hostStatus = response.status;
    if (hostStatus === 404) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  assert.equal(hostStatus, 404, `${liveUrl} still served after purge (HTTP ${hostStatus})`);
}

test(
  'a real deploy to an explicitly-created throwaway succeeds, and the throwaway is purged',
  { skip: credential ? false : SKIP_REASON, timeout: 300_000 },
  async () => {
    const suffix = randomBytes(4).toString('hex');
    const subdomain = `sw-cli-release-check-${suffix}`;

    const created = await api('POST', '/projects', {
      name: subdomain,
      subdomain,
      description: 'Throwaway created by the CLI test suite; deleted in the same run.',
    });
    assert.ok(
      created.status >= 200 && created.status < 300,
      `could not create the throwaway (${created.status}): ${JSON.stringify(created.payload)}`,
    );
    const projectId = created.payload?.data?.id ?? created.payload?.id;
    assert.ok(projectId, `no project id in create response: ${JSON.stringify(created.payload)}`);

    // The test key lives only in this temporary HOME: owner-only, removed in
    // the finally below, and at process exit if the test times out before the
    // finally runs. A hard kill (SIGKILL, power loss) runs no cleanup. The
    // deployed source tree below is kept for failure diagnosis.
    let home = null;
    const removeHome = () => {
      if (home) rmSync(home, { recursive: true, force: true });
      home = null;
    };
    process.once('exit', removeHome);
    try {
      home = mkdtempSync(join(tmpdir(), 'sw-deploy-outcome-home-'));
      mkdirSync(join(home, '.somewhere'), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(home, '.somewhere', 'config.json'),
        JSON.stringify({ token: credential.token, user: { email: '', username: '' } }) + '\n',
        { mode: 0o600 },
      );

      const cwd = mkdtempSync(join(tmpdir(), 'sw-deploy-outcome-tree-'));
      const marker = `deploy-outcome-${suffix}`;
      writeFileSync(join(cwd, 'index.html'), `<!doctype html><title>${marker}</title><h1>${marker}</h1>\n`);

      const result = await run(['deploy', '--json', '--project', projectId], { cwd, home });

      // THE assertions the old test was missing: the deploy has to have WORKED.
      // A post-verify failure and rollback exits non-zero with an error payload
      // — which the previous "did stdout parse as JSON" check happily passed.
      assert.equal(
        result.status,
        0,
        `deploy exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.error, undefined, `deploy reported an error: ${result.stdout}`);
      assert.equal(payload.status, 'success', `deploy did not report success: ${result.stdout}`);
      assert.equal(payload.partial, false, `deploy was partial: ${result.stdout}`);
      assert.equal(payload.project_id, projectId, `deploy went to the wrong project: ${result.stdout}`);
      assert.ok(payload.release_id, `deploy minted no release: ${result.stdout}`);
      assert.equal(
        payload.active_release_id,
        payload.release_id,
        `the deployed release is not the live one — a rollback looks exactly like this: ${result.stdout}`,
      );

      // And what a visitor actually gets, so the assertion does not rest on the
      // CLI agreeing with itself. A fresh subdomain can take a moment to answer.
      const liveUrl = `https://${subdomain}.somewhere.site`;
      let served = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await fetch(liveUrl, { headers: { 'Cache-Control': 'no-cache' } });
        served = await res.text();
        if (res.ok && served.includes(marker)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      assert.ok(
        served.includes(marker),
        `${liveUrl} did not serve the deployed tree; got:\n${served.slice(0, 500)}`,
      );

    } finally {
      removeHome();
      process.off('exit', removeHome);
      await purge(projectId, subdomain);
    }
  },
);
