import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, resolveVersion, fetchPackument } from '../dist/swpx/registry.js';

test('parseSpec — bare name', () => {
  assert.deepEqual(parseSpec('create-next-app'), { name: 'create-next-app' });
});

test('parseSpec — name@version', () => {
  assert.deepEqual(parseSpec('foo@1.2.3'), { name: 'foo', version: '1.2.3' });
});

test('parseSpec — name@range', () => {
  assert.deepEqual(parseSpec('foo@^1.0.0'), { name: 'foo', version: '^1.0.0' });
});

test('parseSpec — name@dist-tag', () => {
  assert.deepEqual(parseSpec('foo@next'), { name: 'foo', version: 'next' });
});

test('parseSpec — scoped, no version', () => {
  assert.deepEqual(parseSpec('@ctrl/tinycolor'), { name: '@ctrl/tinycolor' });
});

test('parseSpec — scoped with version', () => {
  assert.deepEqual(parseSpec('@ctrl/tinycolor@4.1.1'), {
    name: '@ctrl/tinycolor',
    version: '4.1.1',
  });
});

test('parseSpec — scoped with range', () => {
  assert.deepEqual(parseSpec('@babel/core@^7.0.0'), { name: '@babel/core', version: '^7.0.0' });
});

test('parseSpec — trailing @ is no version', () => {
  assert.deepEqual(parseSpec('foo@'), { name: 'foo' });
});

// --- resolveVersion against an injected packument (no network) ---

const packument = {
  'dist-tags': { latest: '15.2.0', next: '16.0.0-canary.3', beta: '15.3.0-beta.1' },
  versions: {
    '14.0.0': {},
    '15.0.0': {},
    '15.1.0': {},
    '15.2.0': {},
    '15.3.0-beta.1': {},
    '16.0.0-canary.3': {},
  },
};
const fakeFetch = (body, ok = true, status = 200) => async () => ({
  ok,
  status,
  json: async () => body,
});

test('resolveVersion — exact version short-circuits (no fetch)', async () => {
  let called = false;
  const f = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => packument };
  };
  assert.equal(await resolveVersion('next', '15.1.0', f), '15.1.0');
  assert.equal(called, false, 'exact version must not hit the registry');
});

test('resolveVersion — undefined resolves to latest dist-tag', async () => {
  assert.equal(await resolveVersion('next', undefined, fakeFetch(packument)), '15.2.0');
});

test('resolveVersion — dist-tag resolves', async () => {
  assert.equal(await resolveVersion('next', 'next', fakeFetch(packument)), '16.0.0-canary.3');
});

test('resolveVersion — caret range picks greatest satisfying stable', async () => {
  assert.equal(await resolveVersion('next', '^15.0.0', fakeFetch(packument)), '15.2.0');
});

test('resolveVersion — tilde range', async () => {
  assert.equal(await resolveVersion('next', '~15.1.0', fakeFetch(packument)), '15.1.0');
});

test('resolveVersion — unsatisfiable range throws', async () => {
  await assert.rejects(
    () => resolveVersion('next', '^99.0.0', fakeFetch(packument)),
    /satisfies/,
  );
});

test('fetchPackument — surfaces a non-200 as an error', async () => {
  await assert.rejects(
    () => fetchPackument('nope', fakeFetch({}, false, 404)),
    /404/,
  );
});
