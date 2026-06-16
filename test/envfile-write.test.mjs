import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvTemplate } from '../dist/lib/envfile-write.js';

test('buildEnvTemplate writes one blank-valued line per key', () => {
  const out = buildEnvTemplate([{ key: 'STRIPE_KEY' }, { key: 'API_URL' }]);
  assert.match(out, /^STRIPE_KEY=$/m);
  assert.match(out, /^API_URL=$/m);
  // Never emits a value — the platform never returns env values.
  assert.ok(!/STRIPE_KEY=\S/.test(out), 'no value after =');
});

test('buildEnvTemplate annotates non-default scope as a comment, omits "all"', () => {
  const out = buildEnvTemplate([
    { key: 'PROD_ONLY', scope: 'prod' },
    { key: 'SHARED', scope: 'all' },
  ]);
  assert.match(out, /^PROD_ONLY=\s+# scope: prod$/m);
  assert.match(out, /^SHARED=$/m);
});

test('buildEnvTemplate dedupes repeated keys and includes the project id header', () => {
  const out = buildEnvTemplate([{ key: 'A' }, { key: 'A' }, { key: 'B' }], {
    projectId: 'proj_123',
  });
  assert.equal((out.match(/^A=/gm) || []).length, 1);
  assert.match(out, /# project: proj_123/);
});

test('buildEnvTemplate is a comment-only file when there are no keys', () => {
  const out = buildEnvTemplate([]);
  for (const line of out.split('\n')) {
    assert.ok(line === '' || line.startsWith('#'), `unexpected non-comment line: ${line}`);
  }
});
