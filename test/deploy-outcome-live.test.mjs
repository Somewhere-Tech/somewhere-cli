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
 * With no credential it skips with a named reason instead of falling back to
 * anonymous deploy — which is what made the old failure mode possible. CI has
 * no credential, so CI never creates anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const API = (process.env.SOMEWHERE_API_URL || 'https://api.somewhere.tech/v1').replace(/\/$/, '');

/**
 * A credential this test is allowed to deploy with. A TEMPORARY session is
 * deliberately refused: temp credentials are exactly what the anonymous path
 * mints, and honouring one here would re-open the hole this test closed.
 */
function resolveCredential() {
  if (process.env.SOMEWHERE_TEST_TOKEN) {
    return { token: process.env.SOMEWHERE_TEST_TOKEN, source: 'SOMEWHERE_TEST_TOKEN' };
  }
  const configPath = join(homedir(), '.somewhere', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!config?.token || config.temporary) return null;
    return { token: config.token, source: '~/.somewhere/config.json' };
  } catch {
    return null;
  }
}

const credential = resolveCredential();
const SKIP_REASON =
  'SOMEWHERE_LIVE_DEPLOY_SKIPPED: no signed-in somewhere credential ' +
  '(set SOMEWHERE_TEST_TOKEN, or run `somewhere login`). This test deploys to the real ' +
  'platform, so it never runs unauthenticated — it will not fall back to an anonymous deploy.';

function run(args, { cwd, home }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
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

    try {
      const home = mkdtempSync(join(tmpdir(), 'sw-deploy-outcome-home-'));
      mkdirSync(join(home, '.somewhere'), { recursive: true });
      writeFileSync(
        join(home, '.somewhere', 'config.json'),
        JSON.stringify({ token: credential.token, user: { email: '', username: '' } }) + '\n',
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
      await purge(projectId, subdomain);
    }
  },
);
