import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePackageJsonDeps, parseLockfile } from '../dist/swpx/tree.js';

test('parsePackageJsonDeps — deps + devDeps + optional, with ranges', () => {
  const r = parsePackageJsonDeps(
    JSON.stringify({
      dependencies: { left: '^1.0.0' },
      devDependencies: { type: '~2.0.0' },
      optionalDependencies: { opt: '3.0.0' },
    }),
  );
  assert.deepEqual(r.directNames.sort(), ['left', 'opt', 'type']);
  assert.equal(r.ranges.left, '^1.0.0');
  assert.equal(r.ranges.opt, '3.0.0');
});

test('parsePackageJsonDeps — tolerates junk', () => {
  assert.deepEqual(parsePackageJsonDeps('not json'), { directNames: [], ranges: {} });
  assert.deepEqual(parsePackageJsonDeps(JSON.stringify({ name: 'x' })), {
    directNames: [],
    ranges: {},
  });
});

test('parseLockfile — v3 packages map, scoped names, skips root + links + dupes', () => {
  const refs = parseLockfile(
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/@ctrl/tinycolor': { version: '4.1.1' },
        'node_modules/foo': { version: '2.0.0' },
        'node_modules/foo/node_modules/bar': { version: '0.5.0' },
        'node_modules/dup': { version: '1.0.0' },
        'node_modules/nested/node_modules/dup': { version: '1.0.0' },
        'node_modules/local-link': { link: true, resolved: '../local' },
      },
    }),
  );
  const ids = refs.map((r) => `${r.package}@${r.version}`).sort();
  assert.deepEqual(ids, [
    '@ctrl/tinycolor@4.1.1',
    'bar@0.5.0',
    'dup@1.0.0',
    'foo@2.0.0',
    'left-pad@1.3.0',
  ]);
});

test('parseLockfile — v1 recursive dependencies tree', () => {
  const refs = parseLockfile(
    JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } },
        c: { version: '3.0.0' },
      },
    }),
  );
  const ids = refs.map((r) => `${r.package}@${r.version}`).sort();
  assert.deepEqual(ids, ['a@1.0.0', 'b@2.0.0', 'c@3.0.0']);
});

test('parseLockfile — junk yields empty', () => {
  assert.deepEqual(parseLockfile('{['), []);
  assert.deepEqual(parseLockfile(JSON.stringify({ lockfileVersion: 3 })), []);
});
