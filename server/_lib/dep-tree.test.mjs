import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDependencies, resolveVersion } from './dep-tree.mjs';

test('checkDependencies — flags cached non-verified dependency verdicts', async () => {
  const rows = new Map([
    ['a@1.0.0', { verdict: 'verified' }],
    ['b@2.0.0', { verdict: 'unverified' }],
    ['c@3.0.0', { verdict: 'blocked' }],
  ]);
  const out = await checkDependencies(['a', 'b', 'c'], {
    resolveVersion: async (name) => ({ a: '1.0.0', b: '2.0.0', c: '3.0.0' })[name],
    readVerdict: async (_sw, name, version) => rows.get(`${name}@${version}`) ?? null,
    sw: {},
  });
  assert.equal(out.checked, 3);
  assert.deepEqual(out.flagged, [
    { name: 'b', version: '2.0.0', verdict: 'unverified' },
    { name: 'c', version: '3.0.0', verdict: 'blocked' },
  ]);
});

test('checkDependencies — uncached or unresolvable deps are unknown, not flagged', async () => {
  const out = await checkDependencies(['cached-miss', 'bad-range'], {
    resolveVersion: async (name) => {
      if (name === 'bad-range') throw new Error('no version');
      return '1.0.0';
    },
    readVerdict: async () => null,
    sw: {},
  });
  assert.equal(out.checked, 1);
  assert.deepEqual(out.flagged, []);
});

test('checkDependencies — caps checks at 50 direct dependency names', async () => {
  let resolves = 0;
  const deps = Array.from({ length: 80 }, (_, i) => `d${i}`);
  const out = await checkDependencies(deps, {
    resolveVersion: async () => {
      resolves++;
      return '1.0.0';
    },
    readVerdict: async () => ({ verdict: 'verified' }),
    sw: {},
  });
  assert.equal(resolves, 50);
  assert.equal(out.checked, 50);
});

test('resolveVersion — mirrors npm dist-tag/range behavior', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      'dist-tags': { latest: '2.0.0', beta: '3.0.0-beta.1' },
      versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {}, '3.0.0-beta.1': {} },
    }),
  });
  assert.equal(await resolveVersion('pkg', undefined, { fetchImpl }), '2.0.0');
  assert.equal(await resolveVersion('pkg', 'beta', { fetchImpl }), '3.0.0-beta.1');
  assert.equal(await resolveVersion('pkg', '^1.0.0', { fetchImpl }), '1.5.0');
  assert.equal(await resolveVersion('pkg', '1.2.3', { fetchImpl }), '1.2.3');
});
