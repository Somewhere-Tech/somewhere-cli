import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { DOM_OUTLINE_SCRIPT } from '../runtime/browser-probes.mjs';
const root = join(import.meta.dirname, '..');
const dir = join(root, 'runtime');
const manifest = JSON.parse(readFileSync(join(dir, 'VENDOR.json'), 'utf8'));
test('only the browser probe and declared-data generator remain vendored and hash-covered', () => {
  assert.deepEqual(Object.keys(manifest.files), ['browser-probes.mjs']);
  assert.deepEqual(readdirSync(dir).sort(), [
    'DECLARED-DATA-VENDOR.json', 'VENDOR.json', 'browser-probes.mjs', 'declared-data.cjs',
  ]);
  const dataManifest = JSON.parse(readFileSync(join(dir, 'DECLARED-DATA-VENDOR.json'), 'utf8'));
  assert.equal(
    createHash('sha256').update(readFileSync(join(dir, 'declared-data.cjs'))).digest('hex'),
    dataManifest.sha256,
  );
  assert.match(manifest.commit, /^[a-f0-9]{7,40}$/);
  const probe = readFileSync(join(dir, 'browser-probes.mjs'), 'utf8');
  assert.equal(createHash('sha256').update(probe).digest('hex'), manifest.files['browser-probes.mjs']);
  for (const marker of ['export const DOM_OUTLINE_SCRIPT', 'outline.push(', 'testid_map']) assert.ok(probe.includes(marker));
  assert.equal(existsSync(join(root, 'src/local')), false);
  assert.equal(existsSync(join(root, 'src/commands/exec.ts')), false);
});

// Exercise the vendored browser-context script, including legitimate button labels.
test('vendored outline omits current form values while retaining placeholders and button labels', () => {
  const field = (id, type, value, placeholder = '') => ({
    id, tagName: 'INPUT', value, innerText: '', disabled: false,
    getAttribute: name => ({ type, placeholder })[name] ?? null,
    matches: () => ['submit', 'button', 'reset'].includes(type),
    closest: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
  });
  const fields = [field('password', 'password', 'private-fixture-password', 'Password'),
    field('name', 'text', 'private-fixture-name', 'Your name'), field('save', 'submit', 'Save')];
  const result = runInNewContext(DOM_OUTLINE_SCRIPT, {
    document: { querySelectorAll: selector => selector === '[data-testid]' ? [] : fields },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    CSS: { escape: value => value },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.outline.map(node => node.text))), ['Password', 'Your name', 'Save']);
  assert.ok(!JSON.stringify(result).includes('private-fixture'));
});
