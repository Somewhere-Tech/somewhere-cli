import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'sw-claim-handoff-'));
process.env.HOME = home;
const configDir = join(home, '.somewhere');
mkdirSync(configDir, { recursive: true });
const configPath = join(configDir, 'config.json');
const tempSidecarPath = join(configDir, 'temp-session.json');
let exchangeMode = 'ready';
let ackOk = true;
let exchangeGate;
let exchangeStarted;
let ackGate;
let ackStarted;
let calls = [];
let delivered;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = body ? JSON.parse(body) : {};
  calls.push({ url: req.url, body: parsed });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/auth/temp-handoff/exchange') {
    exchangeStarted?.();
    if (exchangeGate) await exchangeGate;
    if (exchangeMode === 'expired') {
      res.statusCode = 410;
      return res.end(JSON.stringify({ ok: false, error: 'CLAIM_CLI_HANDOFF_EXPIRED', message: 'Run `somewhere login` in this directory. Keep the existing project link and do not redeploy.' }));
    }
    return res.end(JSON.stringify({ ok: true, data: delivered }));
  }
  if (req.url === '/v1/auth/temp-handoff/ack') {
    ackStarted?.();
    if (ackGate) await ackGate;
    if (!ackOk) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ ok: false, error: 'TEMPORARY' }));
    }
    return res.end(JSON.stringify({ ok: true, data: { acknowledged: true } }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.SOMEWHERE_API_URL = `http://127.0.0.1:${server.address().port}/v1`;
const { recoverClaimHandoff } = await import('../dist/lib/claim-handoff.js?' + Date.now());

function writeConfig(config) { writeFileSync(configPath, JSON.stringify(config)); }
function readConfig() { return JSON.parse(readFileSync(configPath, 'utf8')); }
function encrypted(verifier, handoffId, projectId) {
  const payload = {
    token: 'smt_project_bound', refresh_token: 'smtr_project_bound', expires_at: '2026-09-18T00:00:00.000Z',
    email: 'owner@example.com', project_id: projectId, scope: { projects: [projectId] }, session_id: 'key-1',
  };
  const key = createHash('sha256').update(`claim-cli-handoff:v1:${verifier}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${handoffId}:${projectId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  return { status: 'ready', project_id: projectId, ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64') };
}

const projectId = '11111111-1111-4111-8111-111111111111';
const verifier = randomBytes(32).toString('base64url');
const handoffId = 'cch_fixture';
delivered = encrypted(verifier, handoffId, projectId);

test('same-project continuation saves permanent credential before acknowledgement', async () => {
  calls = [];
  ackOk = true;
  writeConfig({ token: 'smt_temp', user: { email: 'temporary', username: '' }, temporary: true, claim_handoff: { project_id: projectId, verifier, handoff_id: handoffId } });
  const result = await recoverClaimHandoff();
  assert.equal(result.kind, 'recovered');
  const config = readConfig();
  assert.equal(config.token, 'smt_project_bound');
  assert.equal(config.temporary, undefined);
  assert.equal(config.claim_handoff_ack, undefined);
  assert.deepEqual(calls.map((c) => c.url), ['/v1/auth/temp-handoff/exchange', '/v1/auth/temp-handoff/ack']);
});

test('lost acknowledgement keeps installed credential and retries only ACK', async () => {
  calls = [];
  ackOk = false;
  writeConfig({ token: 'smt_temp', user: { email: 'temporary', username: '' }, temporary: true, claim_handoff: { project_id: projectId, verifier, handoff_id: handoffId } });
  assert.equal((await recoverClaimHandoff()).kind, 'recovered');
  assert.equal(readConfig().token, 'smt_project_bound');
  assert.ok(readConfig().claim_handoff_ack);
  ackOk = true;
  calls = [];
  assert.equal((await recoverClaimHandoff()).kind, 'none');
  assert.deepEqual(calls.map((c) => c.url), ['/v1/auth/temp-handoff/ack']);
  assert.equal(readConfig().claim_handoff_ack, undefined);
});

test('expired handoff gives manual guidance without unlinking or replacing temp config', async () => {
  exchangeMode = 'expired';
  writeConfig({ token: 'smt_temp_original', user: { email: 'temporary', username: '' }, temporary: true, claim_handoff: { project_id: projectId, verifier, handoff_id: handoffId } });
  const result = await recoverClaimHandoff();
  assert.equal(result.kind, 'manual');
  assert.match(result.message, /somewhere login/);
  assert.match(result.message, /Keep the existing project link/);
  assert.equal(readConfig().token, 'smt_temp_original');
  exchangeMode = 'ready';
});

test('permanent login and --temporary sidecar are never overwritten by handoff recovery', async () => {
  calls = [];
  writeConfig({ token: 'smt_permanent', user: { email: 'permanent@example.com', username: '' } });
  writeFileSync(tempSidecarPath, JSON.stringify({ token: 'smt_temp_sidecar', project: { project_id: projectId, name: 'Temp', subdomain: 'temp' } }));
  assert.equal((await recoverClaimHandoff()).kind, 'none');
  assert.equal(readConfig().token, 'smt_permanent');
  assert.equal(JSON.parse(readFileSync(tempSidecarPath, 'utf8')).token, 'smt_temp_sidecar');
  assert.deepEqual(calls, []);
});

test('exchange response cannot overwrite a newer permanent login', async () => {
  calls = [];
  let releaseExchange;
  exchangeGate = new Promise((resolve) => { releaseExchange = resolve; });
  const started = new Promise((resolve) => { exchangeStarted = resolve; });
  writeConfig({ token: 'smt_temp_racing', user: { email: 'temporary', username: '' }, temporary: true, claim_handoff: { project_id: projectId, verifier, handoff_id: handoffId } });
  const recovery = recoverClaimHandoff();
  await started;
  writeConfig({ token: 'smt_new_permanent', refresh_token: 'smtr_new_permanent', user: { email: 'new@example.com', username: '' } });
  releaseExchange();
  assert.equal((await recovery).kind, 'none');
  assert.equal(readConfig().token, 'smt_new_permanent');
  assert.equal(readConfig().refresh_token, 'smtr_new_permanent');
  assert.deepEqual(calls.map((call) => call.url), ['/v1/auth/temp-handoff/exchange']);
  exchangeGate = undefined;
  exchangeStarted = undefined;
});

test('acknowledgement cleanup cannot overwrite a newer permanent login', async () => {
  calls = [];
  let releaseAck;
  ackGate = new Promise((resolve) => { releaseAck = resolve; });
  const started = new Promise((resolve) => { ackStarted = resolve; });
  writeConfig({
    token: 'smt_delivered_old',
    refresh_token: 'smtr_delivered_old',
    user: { email: 'old@example.com', username: '' },
    claim_handoff_ack: { handoff_id: handoffId, verifier },
  });
  const recovery = recoverClaimHandoff();
  await started;
  writeConfig({ token: 'smt_newer_login', refresh_token: 'smtr_newer_login', user: { email: 'newer@example.com', username: '' } });
  releaseAck();
  assert.equal((await recovery).kind, 'none');
  assert.equal(readConfig().token, 'smt_newer_login');
  assert.equal(readConfig().refresh_token, 'smtr_newer_login');
  assert.equal(readConfig().claim_handoff_ack, undefined);
  assert.deepEqual(calls.map((call) => call.url), ['/v1/auth/temp-handoff/ack']);
  ackGate = undefined;
  ackStarted = undefined;
});

test('fresh exchange acknowledgement cannot overwrite a login made after installation', async () => {
  calls = [];
  let releaseAck;
  ackGate = new Promise((resolve) => { releaseAck = resolve; });
  const started = new Promise((resolve) => { ackStarted = resolve; });
  writeConfig({ token: 'smt_temp_before_ack', user: { email: 'temporary', username: '' }, temporary: true, claim_handoff: { project_id: projectId, verifier, handoff_id: handoffId } });
  const recovery = recoverClaimHandoff();
  await started;
  assert.equal(readConfig().token, 'smt_project_bound', 'delivered credential installed before ACK');
  writeConfig({ token: 'smt_login_during_ack', refresh_token: 'smtr_login_during_ack', user: { email: 'during-ack@example.com', username: '' } });
  releaseAck();
  assert.equal((await recovery).kind, 'recovered');
  assert.equal(readConfig().token, 'smt_login_during_ack');
  assert.equal(readConfig().refresh_token, 'smtr_login_during_ack');
  assert.deepEqual(calls.map((call) => call.url), [
    '/v1/auth/temp-handoff/exchange',
    '/v1/auth/temp-handoff/ack',
  ]);
  ackGate = undefined;
  ackStarted = undefined;
});

test.after(async () => { await new Promise((resolve) => server.close(resolve)); });
