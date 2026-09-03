import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

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

test('every registered non-pass-through command owns its --help output', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-command-help-home-'));
  const top = await run(['--help'], home);
  assert.equal(top.status, 0, top.stderr);

  const commands = top.stdout
    .split('\n')
    .slice(top.stdout.split('\n').findIndex((line) => line === 'Commands:') + 1)
    .map((line) => /^  ([a-z][a-z0-9-]*)\b/.exec(line)?.[1])
    .filter((name) => name && !['npx', 'npm', 'help'].includes(name));

  assert.ok(commands.includes('cron'));
  assert.ok(commands.includes('email'));
  for (const name of commands) {
    const result = await run([name, '--help'], home);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^Usage: somewhere ${name}\\b`), name);
    assert.doesNotMatch(result.stdout, /^Usage: somewhere \[options\] \[command\]/, name);
  }
});

test('cron and email group help names subcommands and gives one copyable example', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-command-help-groups-home-'));
  const cron = await run(['cron', '--help'], home);
  const email = await run(['email', '--help'], home);

  assert.equal(cron.status, 0, cron.stderr);
  assert.match(cron.stdout, /Commands:\n[\s\S]*create \[options\] <schedule> <handler>/);
  assert.match(cron.stdout, /somewhere cron create "0 8 \* \* \*" \/api\/daily-digest/);

  assert.equal(email.status, 0, email.stderr);
  assert.match(email.stdout, /Commands:\n[\s\S]*send \[options\] <recipient>/);
  assert.match(email.stdout, /somewhere email send alice@example\.com/);
});
