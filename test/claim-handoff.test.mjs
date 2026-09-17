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
let calls = [];
let delivered;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = body ? JSON.parse(body) : {};
  calls.push({ url: req.url, body: parsed });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/auth/temp-handoff/exchange') {
    if (exchangeMode === 'expired') {
      res.statusCode = 410;
      return res.end(JSON.stringify({ ok: false, error: 'CLAIM_CLI_HANDOFF_EXPIRED', message: 'Run `somewhere login` in this directory. Keep the existing project link and do not redeploy.' }));
    }
    return res.end(JSON.stringify({ ok: true, data: delivered }));
  }
  if (req.url === '/v1/auth/temp-handoff/ack') {
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

test.after(async () => { await new Promise((resolve) => server.close(resolve)); });
