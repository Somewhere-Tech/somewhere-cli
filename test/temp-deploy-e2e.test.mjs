import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a LOCAL e2e against a stub server — the real backend
// (lane/worker-tempdeploy) is not deployed. Never point this at
// api.somewhere.tech.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    let mask = 0x80;
    while (mask > 0 && (byte & mask) === 0) { bits++; mask >>= 1; }
    break;
  }
  return bits;
}

// --- Stub /v1 API: pow/challenge, temp-create, projects, deploy. -----------
const DIFFICULTY = 8; // low, so the CLI's real solvePow finishes instantly
let tempCreateCalls = 0;
let projectsCalls = 0;
let deployCalls = 0;
let createdSubdomain = 'stub-project';

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && req.url === '/v1/auth/pow/challenge') {
      send(200, {
        ok: true,
        data: {
          nonce: 'tmpc_e2e_nonce',
          difficulty: DIFFICULTY,
          algorithm: 'sha256',
          input: 'tmpc_e2e_nonce:<suffix>',
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          ttl_seconds: 600,
        },
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/auth/temp-create') {
      tempCreateCalls++;
      const parsed = JSON.parse(body);
      const digest = createHash('sha256').update(`${parsed.nonce}:${parsed.suffix}`, 'utf8').digest();
      if (leadingZeroBits(digest) < DIFFICULTY) {
        send(400, { ok: false, error: 'INVALID_SOLUTION', message: 'proof-of-work did not verify' });
        return;
      }
      send(201, {
        ok: true,
        data: {
          access_token: 'smt_e2e_temp',
          key: 'smt_e2e_temp',
          key_prefix: 'smt_e2e',
          key_id: 'key_e2e',
          scopes: ['projects', 'deploy', 'promote', 'db', 'fs', 'logs', 'smoke', 'browser'],
          expires_at: new Date(Date.now() + 10_800_000).toISOString(),
          ttl_seconds: 10800,
          claim_token: 'swtc_e2e',
          claim_url: 'https://somewhere.tech/claim?token=swtc_e2e',
        },
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/projects') {
      projectsCalls++;
      const parsed = JSON.parse(body);
      createdSubdomain = parsed.subdomain;
      send(201, {
        ok: true,
        data: { id: 'proj_e2e_1', name: parsed.name, subdomain: parsed.subdomain },
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/deploy') {
      deployCalls++;
      send(200, {
        ok: true,
        data: { files: 1, url: `https://${createdSubdomain}.somewhere.tech`, has_functions: false },
      });
      return;
    }

    send(404, { ok: false, error: 'NOT_FOUND', message: `no stub route for ${req.method} ${req.url}` });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const apiUrl = `http://127.0.0.1:${port}/v1`;

// The mock HTTP server above lives IN THIS PROCESS's event loop. spawnSync
// would block that event loop until the child exits — the child's requests
// would sit unserviced and the whole test would hang. Use async spawn and
// await completion instead, so the server keeps handling requests while the
// child runs.
function run(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: env.cwd,
      env: { ...process.env, ...env.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('deploy while logged out — mint, auto-create project, claim relay, then silent reuse', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');

  const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };

  const first = await run(['deploy'], { cwd: fixtureDir, env });
  assert.equal(first.status, 0, `expected exit 0, got ${first.status}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  assert.match(first.stdout, /Live URL:/);
  assert.match(first.stdout, /Claim URL:/);
  assert.match(first.stdout, /Expires at:/);
  assert.match(first.stdout, /Next step: somewhere login to keep it\./);
  assert.ok(first.stdout.includes('https://somewhere.tech/claim?token=swtc_e2e'), 'claim URL present in stdout');

  const configPath = join(HOME, '.somewhere', 'config.json');
  assert.ok(existsSync(configPath), 'config.json written');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.temporary, true);
  assert.equal(config.token, 'smt_e2e_temp');
  assert.equal(config.claim_url, 'https://somewhere.tech/claim?token=swtc_e2e');

  const projectFilePath = join(fixtureDir, '.somewhere.json');
  assert.ok(existsSync(projectFilePath), '.somewhere.json written in the fixture dir');
  const projectFile = JSON.parse(readFileSync(projectFilePath, 'utf8'));
  assert.equal(projectFile.project_id, 'proj_e2e_1');

  assert.equal(tempCreateCalls, 1, 'exactly one temp-create call after the first deploy');
  assert.equal(projectsCalls, 1, 'exactly one project auto-create call');
  assert.equal(deployCalls, 1);

  // Second run in the SAME window (same HOME, same fixture dir with
  // .somewhere.json already present) must reuse the cached credential AND
  // the linked project silently — no second temp-create, no second project.
  const second = await run(['deploy'], { cwd: fixtureDir, env });
  assert.equal(second.status, 0, `expected exit 0, got ${second.status}\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  assert.match(second.stdout, /Live URL:/);
  assert.match(second.stdout, /Expires at: .* \(\d+h \d+m remaining\)/);
  assert.match(second.stdout, /Claim URL:/);
  assert.match(second.stdout, /Next step: somewhere login to keep it\./);

  assert.equal(tempCreateCalls, 1, 'still exactly ONE temp-create total — silent reuse');
  assert.equal(projectsCalls, 1, 'still exactly ONE project create total — .somewhere.json was reused');
  assert.equal(deployCalls, 2);
});

test('deploy --temporary reuses old temp configs without temp_expires_at and keeps fallback copy', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-home-oldconfig-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-oldconfig-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_e2e_old',
    name: 'old-temp',
    subdomain: 'old-temp',
  }) + '\n');

  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_old_temp',
    temporary: true,
    claim_url: 'https://somewhere.tech/claim?token=swtc_old',
    user: { email: '', username: '' },
  }) + '\n');

  const beforeTempCreateCalls = tempCreateCalls;
  const result = await run(['deploy', '--temporary'], {
    cwd: fixtureDir,
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /Live URL:/);
  assert.match(result.stdout, /Expires: about 3 hours after the temporary session was created/);
  assert.match(result.stdout, /https:\/\/somewhere\.tech\/claim\?token=swtc_old/);
  assert.equal(tempCreateCalls, beforeTempCreateCalls, 'missing temp_expires_at falls back without minting a new temp session');
});

test('deploy --json with no stored credential deploys and emits the anonymous contract', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-home-nohint-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-nohint-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html></html>\n');

  const result = await run(['deploy', '--json'], {
    cwd: fixtureDir,
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const config = JSON.parse(readFileSync(join(HOME, '.somewhere', 'config.json'), 'utf8'));
  const project = JSON.parse(readFileSync(join(fixtureDir, '.somewhere.json'), 'utf8'));
  assert.deepEqual(JSON.parse(result.stdout), {
    url: `https://${project.subdomain}.somewhere.tech`,
    claim_url: 'https://somewhere.tech/claim?token=swtc_e2e',
    expires_at: config.temp_expires_at,
  });
  assert.equal(result.stderr, '');
});

// --- `--temporary` means temporary, whatever the login state ---------------
//
// Being logged in used to override the flag ("Already logged in — deploying to
// your account."), which also dragged in account mode's linked-project
// requirement, so `--temporary` in an unlinked directory failed outright
// instead of doing the one thing it was asked to do (pfb_9bbc936e5001).

function realLoginHome(prefix) {
  const HOME = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_real_account',
    user: { email: 'dev@example.com', username: 'dev' },
  }) + '\n');
  return HOME;
}

test('--temporary while logged in and unlinked takes the temporary path, no link required', async () => {
  const HOME = realLoginHome('sw-temp-e2e-home-loggedin-');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-loggedin-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');

  const beforeTempCreate = tempCreateCalls;
  const beforeProjects = projectsCalls;
  const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };

  const first = await run(['deploy', '--temporary'], { cwd: fixtureDir, env });
  assert.equal(first.status, 0, `expected exit 0, got ${first.status}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  assert.doesNotMatch(first.stdout, /Already logged in/);
  assert.doesNotMatch(first.stdout + first.stderr, /No project linked/);
  // Where it went and how long it lives.
  assert.match(first.stdout, /Live URL:/);
  assert.match(first.stdout, /Claim URL:/);
  assert.match(first.stdout, /Expires at:/);
  assert.match(first.stdout, /Your account login is untouched/);
  assert.equal(tempCreateCalls, beforeTempCreate + 1, 'one temporary session minted');
  assert.equal(projectsCalls, beforeProjects + 1, 'the throwaway project was auto-created');

  // The account login survives it, and the directory keeps its own link state.
  const config = JSON.parse(readFileSync(join(HOME, '.somewhere', 'config.json'), 'utf8'));
  assert.equal(config.token, 'smt_real_account', 'real login untouched');
  assert.equal(config.temporary, undefined, 'real login was not downgraded to a temporary one');
  assert.equal(existsSync(join(fixtureDir, '.somewhere.json')), false,
    'a throwaway the account does not own is not written into the directory link');

  const sideCar = JSON.parse(readFileSync(join(HOME, '.somewhere', 'temp-session.json'), 'utf8'));
  assert.equal(sideCar.token, 'smt_e2e_temp');
  assert.equal(sideCar.project.project_id, 'proj_e2e_1');

  // A re-run in the same window redeploys the SAME throwaway.
  const second = await run(['deploy', '--temporary'], { cwd: fixtureDir, env });
  assert.equal(second.status, 0, `expected exit 0, got ${second.status}\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  assert.equal(tempCreateCalls, beforeTempCreate + 1, 'no second temporary session');
  assert.equal(projectsCalls, beforeProjects + 1, 'no second throwaway project');
});

test('logged in and linked with NO flag still deploys to the account, unchanged', async () => {
  const HOME = realLoginHome('sw-temp-e2e-home-account-');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-account-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_account_1',
    name: 'mine',
    subdomain: 'mine',
  }) + '\n');

  const beforeTempCreate = tempCreateCalls;
  const beforeProjects = projectsCalls;
  const result = await run(['deploy'], {
    cwd: fixtureDir,
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /Claim URL:/, 'the account path relays no claim URL');
  assert.match(result.stdout, /Live at /);
  assert.equal(tempCreateCalls, beforeTempCreate, 'no temporary session minted for an account deploy');
  assert.equal(projectsCalls, beforeProjects, 'no project auto-created for an account deploy');
  assert.equal(existsSync(join(HOME, '.somewhere', 'temp-session.json')), false);
});

test.after(() => server.close());
