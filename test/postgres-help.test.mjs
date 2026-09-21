import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The registered surface, through the real binary. What `--help` promises is
// the only description of this feature the CLI owns, so the claims it makes
// about billing, OAuth and disconnect are asserted here rather than trusted.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, home) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('postgres is registered and its group help names all five subcommands', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-postgres-help-'));
  const top = await run(['--help'], home);
  assert.equal(top.status, 0, top.stderr);
  assert.match(top.stdout, /^ {2}postgres\b/m);

  const group = await run(['postgres', '--help'], home);
  assert.equal(group.status, 0, group.stderr);
  assert.match(group.stdout, /^Usage: somewhere postgres\b/);
  for (const sub of ['connect', 'attach', 'create', 'status', 'disconnect']) {
    assert.match(group.stdout, new RegExp(`^ {2}${sub}\\b`, 'm'), sub);
  }
  for (const sub of ['connect', 'attach', 'create', 'status', 'disconnect']) {
    const help = await run(['postgres', sub, '--help'], home);
    assert.equal(help.status, 0, `${sub}: ${help.stderr}`);
    assert.match(help.stdout, new RegExp(`^Usage: somewhere postgres ${sub}\\b`), sub);
    assert.match(help.stdout, /--json\b/, sub);
    assert.match(help.stdout, /-p, --project <id-or-slug>/, sub);
    assert.doesNotMatch(help.stdout, /neon_project_id|provider_project_id/, `${sub} must not leak wire field names into help`);
  }
});

test('group help describes pass-through and sw.postgres without inventing a platform database', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-postgres-help-claims-'));
  const group = await run(['postgres', '--help'], home);
  assert.equal(group.status, 0, group.stderr);

  assert.match(group.stdout, /You own the Neon account and pay Neon directly/);
  assert.match(group.stdout, /Connect using a Neon API key: https:\/\/neon\.com\/docs\/manage\/api-keys/);
  assert.match(group.stdout, /sw\.postgres is the official @neondatabase\/serverless driver callable/);
  // No managed-database overlay may be implied.
  assert.doesNotMatch(group.stdout, /managed (?:database|Postgres)/i);
});

test('connect help points at Neon key setup and promises no other path', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-postgres-help-key-'));
  const help = await run(['postgres', 'connect', '--help'], home);
  assert.equal(help.status, 0, help.stderr);

  assert.match(help.stdout, /Create a Neon API key: https:\/\/neon\.com\/docs\/manage\/api-keys/);
  // A connection method we do not offer is not a customer's concern, and a
  // date nobody has committed to is worse than silence.
  assert.doesNotMatch(help.stdout, /OAuth|commercial partner|registration/i);
  assert.doesNotMatch(help.stdout, /coming soon|for now, |will soon|not yet available/i);
  // The key's accepted sources are stated, and argv is not one of them.
  assert.match(help.stdout, /read from SOMEWHERE_NEON_API_KEY, from stdin, or from a hidden prompt/);
  assert.doesNotMatch(help.stdout, /<api-key>|--api-key/);
  // A project-scoped key cannot list projects, so setup must offer the id.
  assert.match(help.stdout, /--neon-project <id>/);
  assert.match(help.stdout, /project-scoped key/);
});

test('no help text discusses the provider relationship instead of the task', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-postgres-help-scope-'));
  for (const args of [
    ['postgres', '--help'],
    ['postgres', 'connect', '--help'],
    ['postgres', 'attach', '--help'],
    ['postgres', 'create', '--help'],
    ['postgres', 'status', '--help'],
    ['postgres', 'disconnect', '--help'],
  ]) {
    const help = await run(args, home);
    assert.equal(help.status, 0, `${args[1]}: ${help.stderr}`);
    assert.doesNotMatch(help.stdout, /OAuth|commercial partner/i, args[1]);
  }
});

test('create help warns about real Neon billing and forbids retrying an uncertain create', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-postgres-help-create-'));
  const help = await run(['postgres', 'create', '--help'], home);
  assert.equal(help.status, 0, help.stderr);

  assert.match(help.stdout, /Neon bills you for it/);
  assert.match(help.stdout, /a failed `attach` does not fall back to this command/);
  assert.match(help.stdout, /do NOT run it again/);
  assert.match(help.stdout, /Neon does not de-duplicate/);
  assert.match(help.stdout, /-y, --yes\b/);
});

test('disconnect help says the Neon database survives and access is not cut off at once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-postgres-help-disconnect-'));
  const help = await run(['postgres', 'disconnect', '--help'], home);
  assert.equal(help.status, 0, help.stderr);

  assert.match(help.stdout, /your Neon database is NOT deleted/i);
  assert.match(help.stdout, /It never calls Neon's delete/);
  assert.match(help.stdout, /not an immediate cut-off/i);
  assert.match(help.stdout, /keeps the\n?connection details it was built with/);
  assert.match(help.stdout, /Rotate the credential in Neon/);
});

test('an unknown postgres subcommand fails instead of guessing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-postgres-unknown-'));
  const result = await run(['postgres', 'delete-database'], home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command 'delete-database'/);
});
