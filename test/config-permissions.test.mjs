import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'sw-config-perms-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const configDir = join(HOME, '.somewhere');
const configPath = join(configDir, 'config.json');
mkdirSync(configDir, { recursive: true });
writeFileSync(configPath, '{}\n');
chmodSync(configDir, 0o755);
chmodSync(configPath, 0o644);

const { saveConfig } = await import('../dist/lib/config.js');

test('saveConfig tightens an existing credential file and directory', () => {
  const oldConfigFd = openSync(configPath, 'r');
  saveConfig({
    token: 'smt_permissions_test',
    refresh_token: 'smtr_permissions_test',
    user: { email: 'permissions@example.com', username: 'permissions' },
  });

  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(configDir).mode & 0o777, 0o700);
  assert.equal(readFileSync(oldConfigFd, 'utf8'), '{}\n');
  closeSync(oldConfigFd);
});

test('saveConfig replaces a planted config symlink without writing through it', () => {
  const linkedTarget = join(HOME, 'linked-target.json');
  writeFileSync(linkedTarget, 'attacker-controlled\n');
  unlinkSync(configPath);
  symlinkSync(linkedTarget, configPath);

  saveConfig({
    token: 'smt_symlink_test',
    refresh_token: 'smtr_symlink_test',
    user: { email: 'symlink@example.com', username: 'symlink' },
  });

  assert.equal(readFileSync(linkedTarget, 'utf8'), 'attacker-controlled\n');
  assert.equal(lstatSync(configPath).isFile(), true);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
});
