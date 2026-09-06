import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
const root = join(import.meta.dirname, '..');
const dir = join(root, 'runtime');
const manifest = JSON.parse(readFileSync(join(dir, 'VENDOR.json'), 'utf8'));
test('only the independent browser probe remains vendored and hash-covered', () => {
  assert.deepEqual(Object.keys(manifest.files), ['browser-probes.mjs']);
  assert.deepEqual(readdirSync(dir).sort(), ['VENDOR.json', 'browser-probes.mjs']);
  assert.match(manifest.commit, /^[a-f0-9]{7,40}$/);
  const probe = readFileSync(join(dir, 'browser-probes.mjs'), 'utf8');
  assert.equal(createHash('sha256').update(probe).digest('hex'), manifest.files['browser-probes.mjs']);
  for (const marker of ['export const DOM_OUTLINE_SCRIPT', 'outline.push(', 'testid_map']) assert.ok(probe.includes(marker));
  assert.equal(existsSync(join(root, 'src/local')), false);
  assert.equal(existsSync(join(root, 'src/commands/exec.ts')), false);
});
