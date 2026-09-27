// Two CLI processes in different project roots share one temp-session sidecar
// (pfb_29428f76480e). Each loads it, creates its throwaway, then records it.
// A stub server holds both processes at a chosen point so the interleaving is
// deterministic, not timing luck. Local stub only; tokens are never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distIndex = process.env.SOMEWHERE_TEST_CLI ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
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

// A gate holds requests for one route until `count` have arrived, then hands
// them to the test, which answers them in the order it chooses.
function gate(count) {
  const held = [];
  let arrivedAll;
  const allArrived = new Promise((r) => { arrivedAll = r; });
  return {
    hold(entry) { held.push(entry); if (held.length === count) arrivedAll(held); },
    allArrived,
  };
}

let mints = 0;
let projectSeq = 0;
let projectsGate = null;
let mintGate = null;
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
    if (req.method === 'GET' && req.url === '/v1/auth/pow/challenge') {
      return send(200, { nonce: 'n', difficulty: DIFFICULTY, algorithm: 'sha256', input: 'n:<suffix>', expires_at: new Date(Date.now() + 600_000).toISOString(), ttl_seconds: 600 });
    }
    if (req.method === 'POST' && req.url === '/v1/auth/temp-create') {
      const parsed = JSON.parse(body);
      if (leadingZeroBits(createHash('sha256').update(`${parsed.nonce}:${parsed.suffix}`, 'utf8').digest()) < DIFFICULTY) {
        return send(400, { error: 'INVALID_SOLUTION', message: 'bad pow' });
      }
      const answer = () => {
        mints++;
        send(201, {
          access_token: `smt_temp_${mints}`, key: `smt_temp_${mints}`, key_prefix: 'smt_temp', key_id: `key_${mints}`,
          scopes: ['projects', 'deploy'], expires_at: new Date(Date.now() + 10_800_000).toISOString(), ttl_seconds: 10800,
          claim_token: `swtc_${mints}`, claim_url: `https://somewhere.tech/claim?token=swtc_${mints}`,
        });
      };
      if (mintGate) return mintGate.hold({ answer });
      return answer();
    }
    if (req.method === 'POST' && req.url === '/v1/projects') {
      const parsed = JSON.parse(body);
      const answer = () => {
        projectSeq++;
        send(201, { id: `proj_c_${projectSeq}`, name: parsed.name, subdomain: `${parsed.subdomain}-${projectSeq}` });
      };
      if (projectsGate) return projectsGate.hold({ name: parsed.name, answer });
      return answer();
    }
    if (req.method === 'POST' && req.url === '/v1/deploy') {
      const parsed = JSON.parse(body);
      deploys.push(parsed.project_id);
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

function start(args, cwd, HOME) {
  const child = spawn(process.execPath, [distIndex, ...args], { cwd, env: { ...process.env, HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl, NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const done = new Promise((r) => child.on('close', (status) => r({ status, out })));
  return { done };
}
function realLoginHome() {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-conc-home-'));
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
const sidecarPath = (HOME) => join(HOME, '.somewhere', 'temp-session.json');
const sidecar = (HOME) => JSON.parse(readFileSync(sidecarPath(HOME), 'utf8'));
const byName = (held, name) => held.find((h) => h.name.includes(name));

test('both processes load the sidecar, then save in turn: neither root mapping is lost', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-conc-work-')));
  const [alpha, beta] = [app(work, 'alpha'), app(work, 'beta')];
  // A live shared credential already exists; both processes reuse it.
  writeFileSync(sidecarPath(HOME), JSON.stringify({ token: 'smt_temp_shared', temp_expires_at: new Date(Date.now() + 3_600_000).toISOString(), claim_url: 'https://somewhere.tech/claim?token=shared' }));
  projectsGate = gate(2);
  const a = start(['deploy', '--temporary'], alpha, HOME);
  const b = start(['deploy', '--temporary'], beta, HOME);
  const held = await projectsGate.allArrived; // both have loaded the sidecar and are creating
  projectsGate = null;
  byName(held, 'alpha').answer();
  const aResult = await a.done; // alpha records its mapping and exits
  assert.equal(aResult.status, 0, aResult.out);
  byName(held, 'beta').answer(); // beta records from what it loaded before alpha saved
  const bResult = await b.done;
  assert.equal(bResult.status, 0, bResult.out);

  const stored = sidecar(HOME);
  assert.equal(stored.token, 'smt_temp_shared', 'the shared credential is kept');
  assert.deepEqual(Object.keys(stored.projects ?? {}).sort(), [alpha, beta].sort(), 'both roots keep their throwaway');
});

test('two first-time deploys mint at the same moment: the first saved credential and its mapping survive', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-conc-work-')));
  const [alpha, beta] = [app(work, 'alpha'), app(work, 'beta')];
  mintGate = gate(2);
  const a = start(['deploy', '--temporary'], alpha, HOME);
  const b = start(['deploy', '--temporary'], beta, HOME);
  const held = await mintGate.allArrived; // both found no live credential and are minting
  mintGate = null;
  held[0].answer();
  const firstOut = await Promise.race([a.done.then((r) => ({ who: 'alpha', r })), b.done.then((r) => ({ who: 'beta', r }))]);
  assert.equal(firstOut.r.status, 0, firstOut.r.out);
  const afterFirst = sidecar(HOME);
  held[1].answer();
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.status, 0, ra.out);
  assert.equal(rb.status, 0, rb.out);

  const stored = sidecar(HOME);
  const firstRoot = firstOut.who === 'alpha' ? alpha : beta;
  assert.equal(stored.token, afterFirst.token, 'the credential saved first is not replaced by the later mint');
  assert.equal(stored.projects?.[firstRoot]?.project_id, afterFirst.projects[firstRoot].project_id, 'its root mapping survives');
  assert.deepEqual(Object.keys(stored.projects).sort(), [alpha, beta].sort(), 'the later process joined that credential and recorded its own root too');
});

test('many processes recording different roots at once lose none of them', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-conc-work-')));
  const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
  const roots = names.map((n) => app(work, n));
  writeFileSync(sidecarPath(HOME), JSON.stringify({ token: 'smt_temp_shared', temp_expires_at: new Date(Date.now() + 3_600_000).toISOString(), claim_url: 'https://somewhere.tech/claim?token=shared' }));
  projectsGate = gate(names.length);
  const runs = roots.map((root) => start(['deploy', '--temporary'], root, HOME));
  const held = await projectsGate.allArrived;
  projectsGate = null;
  for (const h of held) h.answer(); // all release at once: every save races every other
  for (const r of await Promise.all(runs.map((x) => x.done))) assert.equal(r.status, 0, r.out);
  const stored = sidecar(HOME);
  assert.equal(stored.token, 'smt_temp_shared');
  assert.deepEqual(Object.keys(stored.projects).sort(), [...roots].sort());
  assert.equal(new Set(Object.values(stored.projects).map((p) => p.project_id)).size, names.length, 'six distinct throwaways');
});

async function waitForFile(path) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(path), true, 'holder reached the locked critical section');
}

function holdSidecarLock(configDir, marker) {
  const configModule = pathToFileURL(join(dirname(distIndex), 'lib', 'config.js')).href;
  const script = `import { updateTempSession } from ${JSON.stringify(configModule)};
    import { writeFileSync } from 'node:fs';
    updateTempSession((current) => {
      writeFileSync(process.env.TEMP_LOCK_MARKER, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
      return current;
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, SOMEWHERE_CONFIG_DIR: configDir, TEMP_LOCK_MARKER: marker },
  });
  return { child, closed: new Promise((r) => child.on('close', r)) };
}

test('a crashed writer leaves an intact sidecar and a recoverable lock; a live old lock is not stolen', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-conc-work-')));
  const [alpha, beta] = [app(work, 'alpha'), app(work, 'beta')];
  writeFileSync(sidecarPath(HOME), JSON.stringify({ token: 'smt_temp_shared', temp_expires_at: new Date(Date.now() + 3_600_000).toISOString(), claim_url: 'https://somewhere.tech/claim?token=shared' }));
  const lock = `${sidecarPath(HOME)}.lock`;

  const crashed = holdSidecarLock(join(HOME, '.somewhere'), join(work, 'crashed-ready'));
  await waitForFile(join(work, 'crashed-ready'));
  crashed.child.kill('SIGKILL');
  await crashed.closed;
  assert.equal(sidecar(HOME).token, 'smt_temp_shared', 'interrupted update did not corrupt the previous credential');
  const stale = await start(['deploy', '--temporary'], alpha, HOME).done;
  assert.equal(stale.status, 0, 'dead writer lock was recovered');
  assert.ok(sidecar(HOME).projects[alpha], 'recorded despite the stale lock');

  const live = holdSidecarLock(join(HOME, '.somewhere'), join(work, 'live-ready'));
  await waitForFile(join(work, 'live-ready'));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old); // age alone must not permit takeover
  const refused = await start(['deploy', '--temporary'], beta, HOME).done;
  assert.notEqual(refused.status, 0, 'live writer is not replaced after its lock looks stale');
  assert.equal(sidecar(HOME).projects?.[beta], undefined);
  assert.equal(existsSync(lock), true, 'the original owner still holds the lock');
  live.child.kill('SIGKILL');
  await live.closed;
  const waited = await start(['deploy', '--temporary'], beta, HOME).done;
  assert.equal(waited.status, 0, 'the stopped holder can be reclaimed');
  assert.deepEqual(Object.keys(sidecar(HOME).projects).sort(), [alpha, beta].sort());

  assert.equal(existsSync(lock), false, 'no lock file left behind');
  for (const out of [stale.out, waited.out]) {
    assert.doesNotMatch(out, /smt_temp_shared|smt_real_account/, 'credentials never printed');
  }
});

test('a credential replaced while project creation is in flight is neither overwritten nor linked to the old project', async () => {
  const HOME = realLoginHome();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sw-temp-conc-work-')));
  const alpha = app(work, 'alpha');
  writeFileSync(sidecarPath(HOME), JSON.stringify({ token: 'smt_temp_before', temp_expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  projectsGate = gate(1);
  const run = start(['deploy', '--temporary'], alpha, HOME);
  const held = await projectsGate.allArrived;
  projectsGate = null;
  const unrelated = { project_id: 'proj_other', name: 'other', subdomain: 'other' };
  writeFileSync(sidecarPath(HOME), JSON.stringify({
    token: 'smt_temp_after', temp_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    projects: { [app(work, 'other')]: unrelated },
  }));
  const deploysBefore = deploys.length;
  held[0].answer();
  const refused = await run.done;
  assert.notEqual(refused.status, 0, 'in-flight old credential must not silently become this root mapping');
  assert.match(refused.out, /temporary session changed/i);
  assert.doesNotMatch(refused.out, /smt_temp_before|smt_temp_after/);
  assert.equal(deploys.length, deploysBefore, 'no deployment follows the stale project creation');
  assert.equal(sidecar(HOME).token, 'smt_temp_after');
  assert.equal(sidecar(HOME).projects?.[alpha], undefined);
  assert.deepEqual(Object.values(sidecar(HOME).projects), [unrelated]);

  const retry = await start(['deploy', '--temporary'], alpha, HOME).done;
  assert.equal(retry.status, 0, 'retry uses the current credential and records this root');
  assert.ok(sidecar(HOME).projects?.[alpha]);
});

test('unlock leaves a replacement lock owned by another writer untouched', async () => {
  const HOME = realLoginHome();
  writeFileSync(sidecarPath(HOME), JSON.stringify({ token: 'smt_temp_shared' }));
  const lock = `${sidecarPath(HOME)}.lock`;
  const configModule = pathToFileURL(join(dirname(distIndex), 'lib', 'config.js')).href;
  const script = `import { updateTempSession } from ${JSON.stringify(configModule)};
    import { unlinkSync, writeFileSync } from 'node:fs';
    updateTempSession((current) => {
      unlinkSync(process.env.TEMP_LOCK_PATH);
      writeFileSync(process.env.TEMP_LOCK_PATH, JSON.stringify({ pid: process.pid, nonce: 'replacement' }));
      return current;
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, SOMEWHERE_CONFIG_DIR: join(HOME, '.somewhere'), TEMP_LOCK_PATH: lock },
  });
  const status = await new Promise((r) => child.on('close', r));
  assert.equal(status, 0);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'replacement', 'old owner did not unlink a new lock');
  unlinkSync(lock);
});
