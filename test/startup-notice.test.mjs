// tsk_1df39001 — a first `npx @somewhere-tech/cli …` on a cold cache sat silent
// for more than a minute. That silence belongs to npm: it installs the package
// before running the entrypoint, so nothing we ship can print during it. What
// the CLI owns is speaking the moment it IS running. These fixtures pin both
// directions: an interactive terminal sees the line first, and every machine
// -readable surface stays byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const noticeModule = process.env.SOMEWHERE_TEST_SOURCE
  ? '../src/lib/startup-notice.ts'
  : '../dist/lib/startup-notice.js';
const { startupNotice } = await import(noticeModule);

function run(args, home) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('an interactive run announces the CLI and the version it actually got', () => {
  assert.equal(
    startupNotice('0.31.12', { isTTY: true, jsonOutput: false, passThrough: false }),
    'starting somewhere CLI 0.31.12',
  );
});

test('nothing is announced where the output is read by a machine', () => {
  // Piped or redirected stdout — agents, scripts, log capture.
  assert.equal(startupNotice('0.31.12', { isTTY: false, jsonOutput: false, passThrough: false }), null);
  // --json, whose envelope is the whole contract.
  assert.equal(startupNotice('0.31.12', { isTTY: true, jsonOutput: true, passThrough: false }), null);
  // npx/npm pass-through: that output belongs to the wrapped tool.
  assert.equal(startupNotice('0.31.12', { isTTY: true, jsonOutput: false, passThrough: true }), null);
});

test('a piped command emits no startup line on either stream', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-startup-notice-'));
  const result = await run(['--version'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), version);
  assert.doesNotMatch(result.stdout, /starting somewhere CLI/);
  assert.doesNotMatch(result.stderr, /starting somewhere CLI/);
});
