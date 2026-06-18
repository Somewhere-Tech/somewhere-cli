import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Both BASE_URL (client.ts) and the config paths (config.ts) are resolved at
// module load, so set HOME + SOMEWHERE_API_URL BEFORE the first import.
const HOME = mkdtempSync(join(tmpdir(), 'sw-refresh-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(join(HOME, '.somewhere'), { recursive: true });
const CONFIG_PATH = join(HOME, '.somewhere', 'config.json');

function seedConfig(token, refreshToken) {
  const cfg = { token, user: { email: 'a@b.c', username: '' } };
  if (refreshToken) cfg.refresh_token = refreshToken;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

// A stub /v1 API: the protected route 401s API_KEY_EXPIRED for the old key and
// 200s for the refreshed key; /keys/cli-pair/refresh mints a new pair.
let mode = 'happy';
const requests = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = req.headers['authorization'];
    requests.push({ url: req.url, auth, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/keys/cli-pair/refresh') {
      if (mode === 'bad-refresh') {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, error: 'INVALID_REFRESH_TOKEN', message: 'gone' }));
        return;
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, data: { key: 'smt_new', refresh_token: 'smtr_new' } }));
      return;
    }

    // Protected route.
    if (auth === 'Bearer smt_new') {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, data: { whoami: 'ok' } }));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: 'API_KEY_EXPIRED', message: 'expired' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
process.env.SOMEWHERE_API_URL = `http://127.0.0.1:${port}`;

const { ApiClient, CliApiError } = await import('../dist/lib/client.js');

test('401 API_KEY_EXPIRED refreshes the key, persists it, and retries once', async () => {
  mode = 'happy';
  requests.length = 0;
  seedConfig('smt_old', 'smtr_old');

  const client = new ApiClient('smt_old');
  const out = await client.call('GET', '/whoami');
  assert.deepEqual(out, { whoami: 'ok' });

  // Order: protected(401) → refresh(201) → protected retry(200).
  assert.deepEqual(requests.map((r) => r.url), ['/whoami', '/keys/cli-pair/refresh', '/whoami']);
  assert.equal(requests[1].body.refresh_token, 'smtr_old');
  assert.equal(requests[2].auth, 'Bearer smt_new');

  // New creds persisted to ~/.somewhere/config.json.
  const cfg = readConfig();
  assert.equal(cfg.token, 'smt_new');
  assert.equal(cfg.refresh_token, 'smtr_new');
});

test('no refresh token → original API_KEY_EXPIRED propagates (no refresh attempt)', async () => {
  mode = 'happy';
  requests.length = 0;
  seedConfig('smt_old'); // no refresh_token

  const client = new ApiClient('smt_old');
  await assert.rejects(
    () => client.call('GET', '/whoami'),
    (err) => err instanceof CliApiError && err.code === 'API_KEY_EXPIRED',
  );
  // Never hit the refresh endpoint.
  assert.deepEqual(requests.map((r) => r.url), ['/whoami']);
});

test('expired/revoked refresh token surfaces a clear re-login message', async () => {
  mode = 'bad-refresh';
  requests.length = 0;
  seedConfig('smt_old', 'smtr_dead');

  const client = new ApiClient('smt_old');
  await assert.rejects(
    () => client.call('GET', '/whoami'),
    (err) =>
      err instanceof CliApiError &&
      err.code === 'SESSION_EXPIRED' &&
      /somewhere login/.test(err.message),
  );
});

test.after(() => server.close());
