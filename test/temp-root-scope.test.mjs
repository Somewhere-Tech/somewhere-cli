// `deploy --temporary` beside a real login keeps one throwaway per project
// root (pfb_29428f76480e). Before, one account-global throwaway was reused for
// every directory, so a deploy from an unrelated directory silently replaced
// the first directory's app. Local stub server only; never api.somewhere.tech.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const DIFFICULTY = 8;

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

// Stub API: every temp-create mints a distinct credential, every project
// create returns a distinct id, and every deploy records (project, credential).
let mints = 0;
let projectSeq = 0;
const created = [];
const deploys = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, data) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status < 300 ? { ok: true, data } : { ok: false, ...data }));
    };
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.method === 'GET' && req.url === '/v1/auth/pow/challenge') {
      return send(200, { nonce: 'n', difficulty: DIFFICULTY, algorithm: 'sha256', input: 'n:<suffix>', expires_at: new Date(Date.now() + 600_000).toISOString(), ttl_seconds: 600 });
    }
    if (req.method === 'POST' && req.url === '/v1/auth/temp-create') {
      const parsed = JSON.parse(body);
      if (leadingZeroBits(createHash('sha256').update(`${parsed.nonce}:${parsed.suffix}`, 'utf8').digest()) < DIFFICULTY) {
        return send(400, { error: 'INVALID_SOLUTION', message: 'bad pow' });
      }
      mints++;
      return send(201, {
        access_token: `smt_temp_${mints}`, key: `smt_temp_${mints}`, key_prefix: 'smt_temp', key_id: `key_${mints}`,
        scopes: ['projects', 'deploy', 'browser'], expires_at: new Date(Date.now() + 10_800_000).toISOString(), ttl_seconds: 10800,
        claim_token: `swtc_${mints}`, claim_url: `https://somewhere.tech/claim?token=swtc_${mints}`,
      });
    }
    if (req.method === 'POST' && req.url === '/v1/projects') {
      const parsed = JSON.parse(body);
      projectSeq++;
      const project = { id: `proj_tmp_${projectSeq}`, name: parsed.name, subdomain: `${parsed.subdomain}-${projectSeq}` };
      created.push({ ...project, auth });
      return send(201, project);
    }
    if (req.method === 'POST' && req.url === '/v1/deploy') {
      const parsed = JSON.parse(body);
      deploys.push({ project: parsed.project_id, auth });
      return send(200, { files: 1, url: `https://${parsed.project_id}.somewhere.tech`, has_functions: false });
    }
    if (req.method === 'POST' && req.url === '/v1/auth/temp-handoff/register') {
      return send(201, { handoff_id: 'cch', expires_at: new Date(Date.now() + 10_800_000).toISOString() });
    }
    send(404, { error: 'NOT_FOUND', message: `no stub route for ${req.method} ${req.url}` });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
test.after(() => server.close());

function run(args, cwd, HOME) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd, env: { ...process.env, HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl, NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => done({ status, out }));
  });
}

function realLoginHome() {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-root-home-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_real_account', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  return HOME;
}
function app(parent, name) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), `<html><body>${name}</body></html>\n`);
  return dir;
}
const sidecar = (HOME) => JSON.parse(readFileSync(join(HOME, '.somewhere', 'temp-session.json'), 'utf8'));
const realConfig = (HOME) => JSON.parse(readFileSync(join(HOME, '.somewhere', 'config.json'), 'utf8'));
async function deployOk(args, cwd, HOME) {
  const r = await run(['deploy', ...args], cwd, HOME);
  assert.equal(r.status, 0, r.out);
  return deploys.at(-1);
}

test('two unrelated directories get two throwaways; the first app is never redeployed by the second', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-root-work-')));
  const a = app(work, 'alpha');
  const b = app(work, 'beta');
  const mintsBefore = mints;

  const first = await deployOk(['--temporary'], a, HOME);
  const second = await deployOk(['--temporary'], b, HOME);
  assert.notEqual(second.project, first.project, 'beta did not replace alpha');
  assert.equal(second.auth, first.auth, 'one temporary credential shared by both roots');
  assert.equal(mints, mintsBefore + 1);
  const deploysToAlpha = deploys.filter((d) => d.project === first.project);
  assert.equal(deploysToAlpha.length, 1, 'alpha was deployed exactly once: by alpha');

  const again = await deployOk(['--temporary'], a, HOME);
  assert.equal(again.project, first.project, 'same root reuses its own throwaway');
  const stored = sidecar(HOME);
  assert.deepEqual(Object.keys(stored.projects).sort(), [a, b].sort());
  assert.equal(stored.projects[a].project_id, first.project);
  assert.equal(stored.projects[b].project_id, second.project);
  assert.equal(stored.project, undefined, 'no unscoped project is written');
  assert.equal(realConfig(HOME).token, 'smt_real_account', 'real login untouched');
});

test('every spelling of one directory is one root; a subdirectory is its own root', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-root-work-')));
  const a = app(work, 'alpha');
  const link = join(work, 'alpha-link');
  symlinkSync(a, link, 'dir');
  const projectsBefore = projectSeq;

  const viaPath = await deployOk(['--temporary'], a, HOME);
  const viaSymlink = await deployOk(['--temporary'], link, HOME);
  const other = app(work, 'other');
  const viaDotDot = await deployOk(['--temporary', '../alpha'], other, HOME);
  const viaArgument = await deployOk(['--temporary', a], work, HOME);
  assert.equal(viaSymlink.project, viaPath.project, 'symlinked path reuses');
  assert.equal(viaDotDot.project, viaPath.project, '.. spelling reuses');
  assert.equal(viaArgument.project, viaPath.project, 'deploy <dir> from elsewhere reuses');
  assert.equal(projectSeq, projectsBefore + 1, 'one throwaway for one root');

  const sub = app(a, 'sub');
  const fromSub = await deployOk(['--temporary'], sub, HOME);
  assert.notEqual(fromSub.project, viaPath.project, 'a subdirectory is its own root, like project discovery');
  const again = await deployOk(['--temporary'], a, HOME);
  assert.equal(again.project, viaPath.project, 'the parent still has its own throwaway');
});

test('an unscoped throwaway recorded by an older CLI is never adopted', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-root-work-')));
  const a = app(work, 'alpha');
  const legacy = { token: 'smt_temp_legacy', temp_expires_at: new Date(Date.now() + 3_600_000).toISOString(), claim_url: 'https://somewhere.tech/claim?token=legacy', project: { project_id: 'proj_legacy', name: 'old', subdomain: 'old' } };
  writeFileSync(join(HOME, '.somewhere', 'temp-session.json'), JSON.stringify(legacy));
  const mintsBefore = mints;

  const d = await deployOk(['--temporary'], a, HOME);
  assert.notEqual(d.project, 'proj_legacy');
  assert.equal(deploys.filter((x) => x.project === 'proj_legacy').length, 0, 'the legacy throwaway is left as it was');
  assert.equal(d.auth, 'smt_temp_legacy', 'the still-live credential is reused');
  assert.equal(mints, mintsBefore, 'no new credential needed');
  const stored = sidecar(HOME);
  assert.equal(stored.project.project_id, 'proj_legacy', 'legacy record kept, not lost');
  assert.equal(stored.projects[a].project_id, d.project);
});

test('an expired temporary session mints a new one and never targets the old throwaways', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-root-work-')));
  const a = app(work, 'alpha');
  writeFileSync(join(HOME, '.somewhere', 'temp-session.json'), JSON.stringify({
    token: 'smt_temp_expired', temp_expires_at: new Date(Date.now() - 60_000).toISOString(), claim_url: 'https://somewhere.tech/claim?token=old',
    projects: { [a]: { project_id: 'proj_expired', name: 'old', subdomain: 'old' } },
  }));
  const mintsBefore = mints;

  const d = await deployOk(['--temporary'], a, HOME);
  assert.equal(mints, mintsBefore + 1, 'a fresh credential');
  assert.notEqual(d.project, 'proj_expired');
  assert.notEqual(d.auth, 'smt_temp_expired');
  const stored = sidecar(HOME);
  assert.equal(stored.token, d.auth);
  assert.deepEqual(Object.keys(stored.projects), [a]);
  assert.equal(stored.projects[a].project_id, d.project);
});

test('a directory linked to a real project keeps its link; the account deploy still goes to it', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-root-work-')));
  const a = app(work, 'alpha');
  const link = JSON.stringify({ project_id: 'proj_account_1', name: 'mine', subdomain: 'mine' }) + '\n';
  writeFileSync(join(a, '.somewhere.json'), link);

  const temporary = await deployOk(['--temporary'], a, HOME);
  assert.notEqual(temporary.project, 'proj_account_1', 'the throwaway credential never targets the owned project');
  assert.equal(readFileSync(join(a, '.somewhere.json'), 'utf8'), link, 'the owned-project link is byte-for-byte unchanged');
  assert.equal(realConfig(HOME).token, 'smt_real_account');

  const account = await deployOk([], a, HOME);
  assert.equal(account.project, 'proj_account_1', 'no flag: the account deploy goes to the linked project');
  assert.equal(account.auth, 'smt_real_account');
});

test('an explicit --project is deliberate and is not recorded as this root\'s throwaway', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-root-work-')));
  const a = app(work, 'alpha');
  const b = app(work, 'beta');
  const first = await deployOk(['--temporary'], a, HOME);
  const projectsBefore = projectSeq;

  const explicit = await deployOk(['--temporary', '--project', first.project], b, HOME);
  assert.equal(explicit.project, first.project, 'the named target is honoured');
  assert.equal(projectSeq, projectsBefore, 'nothing created');
  assert.equal(sidecar(HOME).projects[b], undefined, 'beta has no recorded throwaway of its own yet');
});

test('logged out: the temporary path stays directory-scoped through .somewhere.json (unchanged)', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-root-home-out-'));
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-root-work-')));
  const a = app(work, 'alpha');
  const b = app(work, 'beta');
  const first = await deployOk([], a, HOME);
  const second = await deployOk([], b, HOME);
  assert.notEqual(second.project, first.project);
  assert.equal(second.auth, first.auth, 'one temporary credential');
  assert.equal(JSON.parse(readFileSync(join(a, '.somewhere.json'), 'utf8')).project_id, first.project);
  assert.equal(existsSync(join(HOME, '.somewhere', 'temp-session.json')), false, 'no sidecar without a real login');
});
