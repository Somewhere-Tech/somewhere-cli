/**
 * The vendored core decides dependency versions for BOTH sides (tsk_a8cb3d23).
 *
 * `resolveInstallSpec` is the single place that answers "which version of this
 * dependency does the build install?", and it lives in the compiler core —
 * which the compile container runs on deploy and the CLI runs locally, from
 * this vendored copy. That is what makes the two sides agree by construction
 * rather than by two edits that happen to match.
 *
 * The point of this fixture is the word VENDORED. The tech repo has its own
 * copy of these expectations (worker/containers/compile/install-spec.test.mjs);
 * this one asserts the copy the CLI actually ships still behaves the same way,
 * so a CLI left behind on an older core is a failing build here rather than a
 * silent local/deploy divergence discovered by a customer.
 *
 * The cases below are the tech fixture's, kept deliberately identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireVendored = createRequire(join(root, 'runtime', 'compiler', 'compile-core.cjs'));
const core = requireVendored('./compile-core.cjs');

const semver = createRequire(join(root, 'package.json'))('semver');
const satisfies = (version, range) => {
  const wanted = typeof range === 'string' && range.trim() ? range.trim() : '*';
  if (semver.validRange(wanted) === null) return false;
  return semver.satisfies(version, wanted, { includePrerelease: true });
};

test('the vendored core still exposes the install-spec contract', () => {
  assert.equal(typeof core.resolveInstallSpec, 'function');
  assert.equal(typeof core.lockfileVersions, 'function');
  assert.equal(typeof core.cleanRange, 'function');
  assert.ok(Array.isArray(core.LOCKFILE_NAMES) && core.LOCKFILE_NAMES.length >= 2);
  // npm's own precedence: a shrinkwrap outranks a package-lock.
  assert.deepEqual([...core.LOCKFILE_NAMES], ['npm-shrinkwrap.json', 'package-lock.json']);
});

test('a lockfile pin inside the declared range is what gets installed', () => {
  // The measured case (tsk_f79d71ce): declared ^7.9.5, lockfile 7.18.3. Deploy
  // used to install the range FLOOR while the developer's machine used the
  // lockfile version.
  assert.equal(
    core.resolveInstallSpec({
      name: 'react-router-dom',
      range: '^7.9.5',
      lockedVersion: '7.18.3',
      satisfies,
    }),
    'react-router-dom@7.18.3',
  );
});

test('a lockfile can only move the build INSIDE what package.json allows', () => {
  // Out of range -> the floor-pin. An out-of-sync lockfile can never install
  // something the manifest forbids.
  assert.equal(
    core.resolveInstallSpec({ name: 'react-router-dom', range: '^7.9.5', lockedVersion: '6.30.4', satisfies }),
    'react-router-dom@7.9.5',
  );
  // An unprovable range keeps the floor-pin too.
  assert.equal(
    core.resolveInstallSpec({ name: 'thing', range: 'github:me/thing', lockedVersion: '1.0.0', satisfies }),
    `thing@${core.cleanRange('github:me/thing')}`,
  );
  // No semver available -> the floor-pin, never a wrong pin.
  assert.equal(
    core.resolveInstallSpec({ name: 'zod', range: '^3.24.1', lockedVersion: '3.25.76', satisfies: null }),
    'zod@3.24.1',
  );
});

test('with NO lockfile a third-party dependency still floor-pins the declared range', () => {
  // Rule 9, measured rather than asserted: a project with no lockfile must not
  // move at all. These are the exact pre-change spec strings.
  for (const [range, expected] of [
    ['^7.9.5', '7.9.5'],
    ['~3.24.1', '3.24.1'],
    ['>=1.7.9', '1.7.9'],
  ]) {
    assert.equal(
      core.resolveInstallSpec({ name: 'pkg', range, lockedVersion: undefined, satisfies }),
      `pkg@${expected}`,
      `range ${range}`,
    );
  }
});

test('a first-party @somewhere-tech package passes its range through, lockfile or not', () => {
  // Deliberate (pfb_f607d6b27453): `somewhere init` + `npm install` writes a
  // lockfile within seconds, so honouring it for our own packages would freeze
  // every scaffold on the SDK version it was born with and published SDK fixes
  // would never reach a new deploy.
  assert.equal(
    core.resolveInstallSpec({ name: '@somewhere-tech/sdk', range: '^1.2.0', lockedVersion: '1.2.0', satisfies }),
    '@somewhere-tech/sdk@^1.2.0',
  );
});

test('lockfileVersions reads a top-level pin and ignores a nested private copy', () => {
  const v3 = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/a': { version: '1.2.3' },
      'node_modules/a/node_modules/b': { version: '9.9.9' },
      'node_modules/linked': { link: true },
    },
  });
  const pins = core.lockfileVersions(v3);
  assert.equal(pins.get('a'), '1.2.3');
  assert.equal(pins.get('b'), undefined, 'a nested private copy is not a top-level pin');
  assert.equal(pins.get('linked'), undefined, 'a link entry carries no version');
});

test('a malformed lockfile degrades to no pins instead of throwing', () => {
  for (const bad of ['', '{', 'null', undefined]) {
    assert.doesNotThrow(() => core.lockfileVersions(bad));
  }
});
