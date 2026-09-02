import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isExactOrigin } from '../dist/lib/allowed-origins.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const DEAD_API = 'http://127.0.0.1:9/v1';

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function setup(prefix) {
  const HOME = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(
    join(HOME, '.somewhere', 'config.json'),
    JSON.stringify({ token: 'smt_origins', user: { email: 'dev@example.com', username: 'dev' } }) + '\n',
  );
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}-fixture-`));
  return { env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: DEAD_API }, cwd };
}

// Parity finding #3 — the advisor recommended `somewhere project
// allowed-origins list/set`, which the CLI did not have. Advice and executable
// surface have to be the same surface.

test('DIRECTION 1: the recommended commands exist and run', async () => {
  for (const args of [
    ['project', 'allowed-origins', 'list', '--project', 'my-app'],
    ['project', 'allowed-origins', 'set', 'https://app.example.com', '--project', 'my-app'],
    ['project', 'allowed-origins', 'set', '--clear', '--project', 'my-app'],
    // The short alias reads well in a support reply.
    ['project', 'origins', 'list', '--project', 'my-app'],
    // `get` is the natural guess for someone who read the platform tool name.
    ['project', 'allowed-origins', 'get', '--project', 'my-app'],
  ]) {
    const { env, cwd } = setup('sw-origins-exists');
    const result = await run(args, { cwd, env });
    assert.doesNotMatch(
      result.stderr,
      /unknown command|unknown option/,
      `${args.join(' ')} did not dispatch:\n${result.stderr}`,
    );
  }
});

test('the commands are discoverable from --help, so nobody has to guess', async () => {
  const { env, cwd } = setup('sw-origins-help');
  const result = await run(['project', '--help'], { cwd, env });
  assert.match(result.stdout, /allowed-origins/);
});

test('DIRECTION 2: a neighbouring command that does not exist still fails', async () => {
  const { env, cwd } = setup('sw-origins-unknown');
  const result = await run(['project', 'allowed-origin', 'list'], { cwd, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command/i);
});

test('set refuses to send nothing by accident', async () => {
  const { env, cwd } = setup('sw-origins-empty');
  const result = await run(['project', 'allowed-origins', 'set', '--project', 'my-app'], { cwd, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--clear/);
});

test('set refuses addresses the allowlist could never match', async () => {
  const { env, cwd } = setup('sw-origins-invalid');
  const result = await run(
    ['project', 'allowed-origins', 'set', 'https://app.example.com/dashboard', '--project', 'my-app'],
    { cwd, env },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exact web address/);
  // Product language: a customer-facing line names no infrastructure.
  assert.doesNotMatch(result.stderr, /D1|R2|KV|Cloudflare|Worker/i);
});

test('isExactOrigin accepts exactly scheme + host + optional port', () => {
  for (const good of [
    'https://app.example.com',
    'http://localhost:5173',
    'https://example.com:8443',
    'http://127.0.0.1:3000',
  ]) {
    assert.equal(isExactOrigin(good), true, good);
  }
  for (const bad of [
    'https://app.example.com/',
    'https://app.example.com/dashboard',
    'https://*.example.com',
    'app.example.com',
    'ftp://example.com',
    'https://example.com?x=1',
    'https://example.com#top',
    'https://user:pw@example.com',
    ' https://example.com',
    '',
  ]) {
    assert.equal(isExactOrigin(bad), false, bad);
  }
});
