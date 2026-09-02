/**
 * tsk_0e9e13b8 (CLI half) — a stranger must be able to create an account.
 *
 * The blind run found no way in: `somewhere login` prints a device URL whose
 * page redirects straight to Google OAuth, `--legacy` does the same, and there
 * was no `signup` command at all. Someone without a Google or GitHub account
 * had no front door from the CLI.
 *
 * `somewhere signup` and `somewhere login --signup` both point at
 * https://somewhere.tech/auth?intent=signup, and `login` names that path in its
 * own output so a new user is never stranded mid-flow.
 *
 * The login intro is asserted through the exported line builder rather than by
 * running `login`: the device flow contacts the live platform on its first
 * line, and no test here touches production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNUP_URL, SIGNUP_HINT, loginIntroLines } from '../dist/commands/auth.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        CI: '1',
        NO_COLOR: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
        // Never launch a real browser from the test suite.
        SOMEWHERE_NO_BROWSER: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function emptyHome() {
  return mkdtempSync(join(tmpdir(), 'sw-signup-home-'));
}

test('signup resolves the account-creation URL', () => {
  assert.equal(SIGNUP_URL, 'https://somewhere.tech/auth?intent=signup');
  assert.match(SIGNUP_HINT, /Create an account: https:\/\/somewhere\.tech\/auth\?intent=signup/);
});

test('`somewhere signup` is a registered command that prints the URL as text', async () => {
  const home = emptyHome();
  const result = await run(['signup'], { HOME: home, USERPROFILE: home });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(
    result.stdout.includes('https://somewhere.tech/auth?intent=signup'),
    `the URL must be printed as text for a headless agent to relay:\n${result.stdout}`,
  );
  assert.match(result.stdout, /Create your somewhere\.tech account/);
  assert.doesNotMatch(result.stderr, /unknown command/i);
});

test('`somewhere login --signup` reaches the same page', async () => {
  const home = emptyHome();
  const result = await run(['login', '--signup'], { HOME: home, USERPROFILE: home });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(result.stdout.includes('https://somewhere.tech/auth?intent=signup'));
});

test("login's own output carries an account-creation line", () => {
  const printed = loginIntroLines().join('\n');
  assert.match(printed, /create an account/i);
  assert.ok(printed.includes('https://somewhere.tech/auth?intent=signup'));
});

test('help mentions signup at the top level and on login', async () => {
  const top = await run(['--help']);
  assert.equal(top.status, 0);
  assert.match(top.stdout, /^\s*signup\s+Create a somewhere\.tech account/m);

  const loginHelp = await run(['login', '--help']);
  assert.equal(loginHelp.status, 0);
  assert.match(loginHelp.stdout, /--signup/);
  assert.match(loginHelp.stdout, /somewhere signup/);
});
