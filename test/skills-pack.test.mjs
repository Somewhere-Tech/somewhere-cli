import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'somewhere.js');
const { BUNDLED_SKILLS_PACK } = await import('../dist/lib/skills-pack.generated.js');
const { installSkills, skillsStatus, verifyPack, fetchLatestPack } = await import('../dist/lib/skills-pack.js');
const { writeInitSkills } = await import('../dist/commands/init.js');
const { INIT_AGENTS_MD, AGENT_WORKFLOW } = await import('../dist/lib/init-agent-guide.js');
const { writeInitScaffold } = await import('../dist/lib/init-scaffold.js');
const { createGreenTemplate } = await import('../dist/lib/init-green-template.js');
const CLI_VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const NAMES = ['deploy-verify-loop', 'schema-changes', 'sign-in-setup', 'troubleshooting', 'realtime-and-background', 'email-and-test-inbox'];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const temp = () => mkdtempSync(join(tmpdir(), 'somewhere-skills-'));

/** A newer pack, correctly hashed, as the docs host would serve it. */
function newerPack() {
  const files = BUNDLED_SKILLS_PACK.files.map((f, i) => {
    const content = i === 0 ? `${f.content}\nnewer\n` : f.content;
    return { path: f.path, sha256: sha(content), content };
  });
  const digest = sha(files.map((f) => `${f.path}\0${f.sha256}\n`).join(''));
  return { ...BUNDLED_SKILLS_PACK, files, sha256: digest, version: `1+${digest.slice(0, 12)}` };
}

/** Async so an in-process docs host can answer while the CLI runs. */
function cli(args, cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, SOMEWHERE_CONFIG_DIR: join(cwd, '.cfg'), NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withHost(body, fn) {
  const server = createServer((req, res) => {
    if (req.url !== '/skills/pack.json' || body === 404) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('the bundled pack is the six generated skills, verifies, and fits the ceilings', () => {
  verifyPack(BUNDLED_SKILLS_PACK);
  assert.deepEqual(BUNDLED_SKILLS_PACK.files.map((f) => f.path), NAMES.map((n) => `${n}/SKILL.md`));
  let bytes = 0;
  for (const f of BUNDLED_SKILLS_PACK.files) {
    bytes += Buffer.byteLength(f.content);
    assert.ok(f.content.split('\n').length <= 150, `${f.path} is over 150 lines`);
    assert.match(f.content, /^---\nname: [a-z-]+\ndescription: .+\n---\n/);
  }
  assert.ok(bytes <= 12 * 1024, `pack is ${bytes} bytes`);
});

test('init on an empty directory writes the pack, links it for Claude, and pins it to this CLI', () => {
  const dir = temp();
  writeInitScaffold(dir, createGreenTemplate());
  const result = writeInitSkills(dir);
  assert.equal(result.version, BUNDLED_SKILLS_PACK.version);
  for (const name of NAMES) {
    const file = join(dir, '.agents/skills', name, 'SKILL.md');
    assert.ok(existsSync(file), `${name} written`);
    const link = join(dir, '.claude/skills', name);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), join('..', '..', '.agents/skills', name));
    assert.equal(readFileSync(join(link, 'SKILL.md'), 'utf8'), readFileSync(file, 'utf8'));
  }
  const lock = JSON.parse(readFileSync(join(dir, 'skills-lock.json'), 'utf8'));
  assert.equal(lock.version, BUNDLED_SKILLS_PACK.version);
  assert.equal(lock.cli, CLI_VERSION);
  assert.equal(lock.source, 'bundled');
  assert.equal(Object.keys(lock.files).length, 6);
  // AGENTS.md: the first screen names the pack, then the canonical loop.
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(agents, INIT_AGENTS_MD);
  const firstScreen = agents.split('\n').slice(0, 12).join('\n');
  assert.match(firstScreen, /\.agents\/skills\//);
  for (const name of NAMES) assert.ok(firstScreen.includes(`\`${name}\``));
  assert.match(firstScreen, /Getting started — build, deploy, verify/);
  assert.ok(agents.includes(AGENT_WORKFLOW));
});

test('init never overwrites an existing install or a project skill with a pack name', () => {
  const dir = temp();
  mkdirSync(join(dir, '.agents/skills/troubleshooting'), { recursive: true });
  writeFileSync(join(dir, '.agents/skills/troubleshooting/SKILL.md'), 'mine\n');
  assert.match(writeInitSkills(dir).kept, /troubleshooting already exist/);
  assert.equal(readFileSync(join(dir, '.agents/skills/troubleshooting/SKILL.md'), 'utf8'), 'mine\n');
  assert.equal(existsSync(join(dir, 'skills-lock.json')), false);

  const installed = temp();
  writeInitSkills(installed);
  assert.match(writeInitSkills(installed).kept, /skills-lock\.json already present/);
});

test('status: current, then modified after an edit, stale against a newer pack, missing without a lock', () => {
  const dir = temp();
  assert.equal(skillsStatus(dir, BUNDLED_SKILLS_PACK, CLI_VERSION, null).state, 'missing');
  installSkills(dir, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' });
  assert.equal(skillsStatus(dir, BUNDLED_SKILLS_PACK, CLI_VERSION, null).state, 'current');
  assert.equal(skillsStatus(dir, BUNDLED_SKILLS_PACK, CLI_VERSION, BUNDLED_SKILLS_PACK).state, 'current');

  const stale = skillsStatus(dir, BUNDLED_SKILLS_PACK, CLI_VERSION, newerPack());
  assert.equal(stale.state, 'stale');
  assert.match(stale.message, /out of date/);

  // An older CLI's lock is stale against this CLI's bundled pack, offline too.
  const lockPath = join(dir, 'skills-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  writeFileSync(lockPath, JSON.stringify({ ...lock, version: '1+000000000000', cli: '0.33.0' }));
  assert.equal(skillsStatus(dir, BUNDLED_SKILLS_PACK, CLI_VERSION, null).state, 'stale');
  writeFileSync(lockPath, JSON.stringify(lock));

  writeFileSync(join(dir, '.agents/skills/schema-changes/SKILL.md'), 'edited\n');
  const modified = skillsStatus(dir, BUNDLED_SKILLS_PACK, CLI_VERSION, null);
  assert.equal(modified.state, 'modified');
  assert.deepEqual(modified.modified, ['.agents/skills/schema-changes/SKILL.md']);
});

test('`skills status` and `skills update` end to end against a docs host', async () => {
  const dir = temp();
  // Offline, nothing installed: status exits 1; update installs the bundled pack.
  let r = await cli(['skills', 'status', '--offline'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /No skills installed/);
  r = await cli(['skills', 'update', '--offline', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).source, 'bundled');
  r = await cli(['skills', 'status', '--offline', '--json'], dir);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).state, 'current');

  const before = readFileSync(join(dir, 'skills-lock.json'), 'utf8');
  await withHost(newerPack(), async (base) => {
    const out = await cli(['skills', 'update', '--json'], dir, { SOMEWHERE_DOCS_BASE: base });
    assert.equal(out.status, 1);
    assert.match(JSON.parse(out.stdout).message, /trusted https:\/\/somewhere.tech origin/);
  });
  assert.equal(readFileSync(join(dir, 'skills-lock.json'), 'utf8'), before);
});

test('update removes only skills the previous pack owned; a project skill survives', () => {
  const dir = temp();
  installSkills(dir, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' });
  mkdirSync(join(dir, '.agents/skills/my-own'), { recursive: true });
  writeFileSync(join(dir, '.agents/skills/my-own/SKILL.md'), 'mine\n');
  const smaller = { ...BUNDLED_SKILLS_PACK, files: BUNDLED_SKILLS_PACK.files.slice(1) };
  smaller.sha256 = sha(smaller.files.map((f) => `${f.path}\0${f.sha256}\n`).join(''));
  smaller.version = `1+${smaller.sha256.slice(0, 12)}`;
  const result = installSkills(dir, smaller, { cli: CLI_VERSION, source: 'docs-host' });
  assert.deepEqual(result.removed, ['deploy-verify-loop']);
  assert.equal(existsSync(join(dir, '.agents/skills/deploy-verify-loop/SKILL.md')), false);
  assert.equal(existsSync(join(dir, '.claude/skills/deploy-verify-loop')), false);
  assert.equal(readFileSync(join(dir, '.agents/skills/my-own/SKILL.md'), 'utf8'), 'mine\n');
});

test('the bundled copy carries the platform generator header', () => {
  // The platform gate (scripts/check-skills-pack.mjs with SOMEWHERE_CLI_REPO)
  // is the authority; this pins that the file carries the generator header.
  const text = readFileSync(join(root, 'src/lib/skills-pack.generated.ts'), 'utf8');
  assert.match(text, /^\/\/ GENERATED by somewhere\.tech scripts\/skills\/generate\.mjs/);
});


test('updates preserve edited, deleted, same-name and symlinked skills before any writes', () => {
  for (const change of ['edit', 'delete', 'claude-edit']) {
    const dir = temp();
    installSkills(dir, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' });
    const lock = readFileSync(join(dir, 'skills-lock.json'), 'utf8');
    const file = join(dir, '.agents/skills/schema-changes/SKILL.md');
    if (change === 'delete') rmSync(file);
    else if (change === 'edit') writeFileSync(file, 'my edited skill');
    else { const at = join(dir, '.claude/skills/schema-changes'); rmSync(at); mkdirSync(at); writeFileSync(join(at, 'SKILL.md'), 'my Claude edit'); }
    assert.throws(() => installSkills(dir, newerPack(), { cli: CLI_VERSION, source: 'docs-host' }), /Skills conflict/);
    assert.equal(readFileSync(join(dir, 'skills-lock.json'), 'utf8'), lock);
    assert.equal(readFileSync(join(dir, '.agents/skills/deploy-verify-loop/SKILL.md'), 'utf8'), BUNDLED_SKILLS_PACK.files[0].content);
  }
  const own = temp(); mkdirSync(join(own, '.agents/skills/schema-changes'), { recursive: true });
  writeFileSync(join(own, '.agents/skills/schema-changes/SKILL.md'), 'mine');
  assert.throws(() => installSkills(own, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' }), /Skills conflict/);
  assert.equal(existsSync(join(own, 'skills-lock.json')), false);
  const linked = temp(), outside = temp(); symlinkSync(outside, join(linked, '.agents'));
  assert.throws(() => installSkills(linked, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' }), /Skills conflict/);
  assert.equal(existsSync(join(outside, 'skills')), false);
});

test('trusted HTTPS fetch verifies integrity and refuses redirects/tampering', async () => {
  const original = globalThis.fetch;
  const previous = process.env.SOMEWHERE_DOCS_BASE;
  delete process.env.SOMEWHERE_DOCS_BASE;
  try {
    globalThis.fetch = async (url, options) => { assert.equal(url, 'https://somewhere.tech/skills/pack.json'); assert.equal(options.redirect, 'manual'); return Response.json(newerPack()); };
    assert.equal((await fetchLatestPack()).version, newerPack().version);
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://evil.example/pack' } });
    await assert.rejects(fetchLatestPack(), /answered 302/);
    const tampered = newerPack(); tampered.files[0].content += 'tampered';
    globalThis.fetch = async () => Response.json(tampered);
    await assert.rejects(fetchLatestPack(), /does not match its sha256/);
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal(await fetchLatestPack(), null);
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    assert.equal(await fetchLatestPack(), null);
  } finally { globalThis.fetch = original; if (previous === undefined) delete process.env.SOMEWHERE_DOCS_BASE; else process.env.SOMEWHERE_DOCS_BASE = previous; }
});


test('lock traversal and same-name Claude skills are refused; extra project files survive retired skills', () => {
  const hostile = temp();
  writeFileSync(join(hostile, 'skills-lock.json'), JSON.stringify({ pack: 'somewhere-skills', version: '1+bad', files: { '../../outside': '0'.repeat(64) } }));
  assert.throws(() => installSkills(hostile, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' }), /lock is malformed/);
  const claude = temp(); mkdirSync(join(claude, '.claude/skills/schema-changes'), { recursive: true });
  writeFileSync(join(claude, '.claude/skills/schema-changes/SKILL.md'), 'my Claude skill');
  assert.throws(() => installSkills(claude, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' }), /Skills conflict/);
  assert.equal(readFileSync(join(claude, '.claude/skills/schema-changes/SKILL.md'), 'utf8'), 'my Claude skill');
  const dir = temp(); installSkills(dir, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' });
  writeFileSync(join(dir, '.agents/skills/deploy-verify-loop/my-notes.txt'), 'keep my notes');
  const smaller = { ...BUNDLED_SKILLS_PACK, files: BUNDLED_SKILLS_PACK.files.slice(1) };
  smaller.sha256 = sha(smaller.files.map(f => `${f.path}\0${f.sha256}\n`).join(''));
  smaller.version = `1+${smaller.sha256.slice(0, 12)}`;
  installSkills(dir, smaller, { cli: CLI_VERSION, source: 'bundled' });
  assert.equal(readFileSync(join(dir, '.agents/skills/deploy-verify-loop/my-notes.txt'), 'utf8'), 'keep my notes');
});
