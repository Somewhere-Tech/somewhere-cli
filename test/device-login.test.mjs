import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

// What `somewhere login` tells the platform about this machine, so the
// approval page can show a device card the owner can recognise (tsk_d560943d).
test('describeThisDevice reports hostname, CLI version, runtime, platform and arch', async () => {
  const { describeThisDevice } = await import(join(repoRoot, 'dist', 'lib', 'device-login.js'));
  const meta = describeThisDevice();
  assert.equal(meta.cli_version, pkg.version, 'cli_version is the installed package version');
  assert.match(meta.runtime_version, /^node \d+\.\d+\.\d+/);
  assert.ok(meta.hostname.length > 0 && meta.hostname.length <= 64);
  assert.ok(!meta.hostname.endsWith('.local'));
  assert.ok(meta.platform.startsWith(process.platform));
  assert.equal(meta.arch, process.arch);
  for (const v of Object.values(meta)) assert.equal(typeof v, 'string');
});

test('a browser denial is reported as denial, not as a timeout', async () => {
  const { DeviceLoginDenied, DeviceLoginTimeout } = await import(join(repoRoot, 'dist', 'lib', 'device-login.js'));
  const denied = new DeviceLoginDenied();
  assert.match(denied.message, /denied in the browser/);
  assert.match(denied.message, /somewhere login/);
  assert.notEqual(denied.name, new DeviceLoginTimeout().name);
});

test('describeScope names all-projects and limited sessions plainly', async () => {
  const { describeScope } = await import(join(repoRoot, 'dist', 'commands', 'auth.js'));
  assert.equal(describeScope(null), 'all projects');
  assert.match(describeScope({ projects: ['11111111-1111-4111-8111-111111111111'] }), /^1 project only \(11111111\)/);
  assert.match(describeScope({ projects: ['a'.repeat(36), 'b'.repeat(36)] }), /^2 projects only/);
});
