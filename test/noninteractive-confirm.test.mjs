import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

// A dead port: the fail-fast must fire BEFORE any network call, so promote /
// rollback never reach this. If the guard regresses the process would either
// hang on the prompt (killed by the test timeout) or connect and fail with a
// network error — both distinct from the expected CONFIRMATION_REQUIRED exit.
const DEAD_API = 'http://127.0.0.1:9/v1';

// stdin from /dev/null (not an inherited pipe) so a MISSING guard exits
// promptly with the old "Aborted." path instead of hanging this test forever —
// the red state is a wrong/absent message, not a timeout.
function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
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

function writeLogin(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_noninteractive',
    user: { email: 'dev@example.com', username: 'dev' },
  }) + '\n');
}

function writeProject(dir) {
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_noninteractive',
    name: 'noninteractive',
    subdomain: 'noninteractive',
  }, null, 2) + '\n');
}

function setup(prefix) {
  const HOME = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const fixtureDir = mkdtempSync(join(tmpdir(), `${prefix}-fixture-`));
  writeLogin(HOME);
  writeProject(fixtureDir);
  return { env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: DEAD_API }, cwd: fixtureDir };
}

test('promote without --yes fails fast in a non-interactive shell', async () => {
  const { env, cwd } = setup('sw-noninteractive-promote');
  const result = await run(
    ['promote', 'draft_11111111-1111-4111-8111-111111111111', 'rel_candidate_1'],
    { cwd, env },
  );

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /non-interactive shell/);
  assert.match(result.stderr, /--yes/);
  // Must not masquerade as an ordinary user abort.
  assert.doesNotMatch(result.stderr, /^Aborted\.$/m);
});

test('promote --json without --yes emits a CONFIRMATION_REQUIRED error', async () => {
  const { env, cwd } = setup('sw-noninteractive-promote-json');
  const result = await run(
    ['promote', 'draft_11111111-1111-4111-8111-111111111111', 'rel_candidate_1', '--json'],
    { cwd, env },
  );

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.error, 'CONFIRMATION_REQUIRED');
  assert.match(payload.message, /--yes/);
});

test('promote --yes is unaffected by the non-interactive guard (still reaches the API)', async () => {
  const { env, cwd } = setup('sw-noninteractive-promote-yes');
  // With --yes there is no prompt: the guard must not fire, so this reaches the
  // dead API and fails on the network call, NOT on CONFIRMATION_REQUIRED.
  const result = await run(
    ['promote', 'draft_11111111-1111-4111-8111-111111111111', 'rel_candidate_1', '--yes'],
    { cwd, env },
  );

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /non-interactive shell/);
});

test('rollback without --yes fails fast in a non-interactive shell', async () => {
  const { env, cwd } = setup('sw-noninteractive-rollback');
  const result = await run(['rollback'], { cwd, env });

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /non-interactive shell/);
  assert.match(result.stderr, /--yes/);
  assert.doesNotMatch(result.stderr, /^Aborted\.$/m);
});

test('rollback --json without --yes emits a CONFIRMATION_REQUIRED error', async () => {
  const { env, cwd } = setup('sw-noninteractive-rollback-json');
  const result = await run(['rollback', '--json'], { cwd, env });

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.error, 'CONFIRMATION_REQUIRED');
  assert.match(payload.message, /--yes/);
});

test('rollback --yes is unaffected by the non-interactive guard (still reaches the API)', async () => {
  const { env, cwd } = setup('sw-noninteractive-rollback-yes');
  const result = await run(['rollback', '--yes'], { cwd, env });

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /non-interactive shell/);
});
