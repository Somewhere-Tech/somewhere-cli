import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installScripts,
  hasInstallScripts,
  hasProvenance,
  provenanceRepo,
} from './manifest.mjs';

// ---------------------------------------------------------------------------
// installScripts
// ---------------------------------------------------------------------------

test('installScripts: all four lifecycle scripts present, returned sorted', () => {
  const m = {
    scripts: {
      postinstall: 'node setup.js',
      preinstall: 'echo hi',
      prepare: 'tsc',
      install: 'node-gyp rebuild',
    },
  };
  assert.deepEqual(installScripts(m), [
    'install',
    'postinstall',
    'preinstall',
    'prepare',
  ]);
});

test('installScripts: single script present', () => {
  assert.deepEqual(installScripts({ scripts: { postinstall: './x.sh' } }), [
    'postinstall',
  ]);
});

test('installScripts: partial subset present, returned sorted', () => {
  const m = { scripts: { prepare: 'tsc', preinstall: 'echo' } };
  assert.deepEqual(installScripts(m), ['preinstall', 'prepare']);
});

test('installScripts: no scripts object -> []', () => {
  assert.deepEqual(installScripts({}), []);
});

test('installScripts: empty scripts object -> []', () => {
  assert.deepEqual(installScripts({ scripts: {} }), []);
});

test('installScripts: non-lifecycle scripts (test/build/start) excluded', () => {
  const m = {
    scripts: {
      test: 'jest',
      build: 'vite build',
      start: 'node index.js',
      lint: 'eslint .',
    },
  };
  assert.deepEqual(installScripts(m), []);
});

test('installScripts: mix of lifecycle and non-lifecycle keeps only lifecycle', () => {
  const m = {
    scripts: {
      test: 'jest',
      build: 'vite build',
      postinstall: 'node patch.js',
      preinstall: 'echo go',
    },
  };
  assert.deepEqual(installScripts(m), ['postinstall', 'preinstall']);
});

test('installScripts: non-string / empty-string / falsy values treated as absent', () => {
  const m = {
    scripts: {
      preinstall: '', // empty string -> absent
      install: null, // null -> absent
      postinstall: 42, // number -> absent
      prepare: 'tsc', // valid
    },
  };
  assert.deepEqual(installScripts(m), ['prepare']);
});

test('installScripts: object-valued lifecycle key treated as absent', () => {
  const m = { scripts: { postinstall: { nested: true }, install: 'real' } };
  assert.deepEqual(installScripts(m), ['install']);
});

test('installScripts: scripts as array (garbage) -> []', () => {
  assert.deepEqual(installScripts({ scripts: ['postinstall'] }), []);
});

test('installScripts: scripts as string (garbage) -> []', () => {
  assert.deepEqual(installScripts({ scripts: 'postinstall' }), []);
});

test('installScripts: defensive — undefined/null/garbage manifest -> []', () => {
  assert.deepEqual(installScripts(undefined), []);
  assert.deepEqual(installScripts(null), []);
  assert.deepEqual(installScripts(0), []);
  assert.deepEqual(installScripts('nope'), []);
  assert.deepEqual(installScripts([]), []);
  assert.deepEqual(installScripts(true), []);
});

test('installScripts: returns a fresh array each call (no shared mutation)', () => {
  const m = { scripts: { install: 'x' } };
  const a = installScripts(m);
  a.push('mutated');
  assert.deepEqual(installScripts(m), ['install']);
});

// ---------------------------------------------------------------------------
// hasInstallScripts
// ---------------------------------------------------------------------------

test('hasInstallScripts: true when a lifecycle script present', () => {
  assert.equal(hasInstallScripts({ scripts: { postinstall: 'x' } }), true);
});

test('hasInstallScripts: false when only non-lifecycle scripts', () => {
  assert.equal(hasInstallScripts({ scripts: { test: 'jest' } }), false);
});

test('hasInstallScripts: false when no scripts', () => {
  assert.equal(hasInstallScripts({}), false);
});

test('hasInstallScripts: defensive — garbage input -> false', () => {
  assert.equal(hasInstallScripts(undefined), false);
  assert.equal(hasInstallScripts(null), false);
  assert.equal(hasInstallScripts('x'), false);
  assert.equal(hasInstallScripts([]), false);
});

// ---------------------------------------------------------------------------
// hasProvenance
// ---------------------------------------------------------------------------

test('hasProvenance: true with dist.attestations object (npm shape)', () => {
  const m = {
    dist: {
      tarball: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/x@1.0.0',
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    },
  };
  assert.equal(hasProvenance(m), true);
});

test('hasProvenance: true even with an empty attestations object', () => {
  assert.equal(hasProvenance({ dist: { attestations: {} } }), true);
});

test('hasProvenance: false when dist present but no attestations', () => {
  assert.equal(hasProvenance({ dist: { tarball: 'https://x' } }), false);
});

test('hasProvenance: false when dist.attestations is null', () => {
  assert.equal(hasProvenance({ dist: { attestations: null } }), false);
});

test('hasProvenance: false when dist.attestations is false', () => {
  assert.equal(hasProvenance({ dist: { attestations: false } }), false);
});

test('hasProvenance: false when no dist at all', () => {
  assert.equal(hasProvenance({ name: 'x', version: '1.0.0' }), false);
});

test('hasProvenance: false when dist is not an object', () => {
  assert.equal(hasProvenance({ dist: 'garbage' }), false);
  assert.equal(hasProvenance({ dist: ['a'] }), false);
});

test('hasProvenance: defensive — garbage input -> false', () => {
  assert.equal(hasProvenance(undefined), false);
  assert.equal(hasProvenance(null), false);
  assert.equal(hasProvenance('x'), false);
  assert.equal(hasProvenance([]), false);
  assert.equal(hasProvenance(123), false);
});

// ---------------------------------------------------------------------------
// provenanceRepo
// ---------------------------------------------------------------------------

test('provenanceRepo: repository object with git+ and .git normalized', () => {
  const m = { repository: { type: 'git', url: 'git+https://github.com/a/b.git' } };
  assert.equal(provenanceRepo(m), 'https://github.com/a/b');
});

test('provenanceRepo: repository object with only .git suffix', () => {
  const m = { repository: { url: 'https://github.com/a/b.git' } };
  assert.equal(provenanceRepo(m), 'https://github.com/a/b');
});

test('provenanceRepo: repository object with only git+ prefix', () => {
  const m = { repository: { url: 'git+ssh://git@github.com/a/b' } };
  assert.equal(provenanceRepo(m), 'ssh://git@github.com/a/b');
});

test('provenanceRepo: repository object with clean url unchanged', () => {
  const m = { repository: { url: 'https://github.com/a/b' } };
  assert.equal(provenanceRepo(m), 'https://github.com/a/b');
});

test('provenanceRepo: repository object url is trimmed', () => {
  const m = { repository: { url: '  git+https://github.com/a/b.git  ' } };
  assert.equal(provenanceRepo(m), 'https://github.com/a/b');
});

test('provenanceRepo: repository as a bare string is normalized', () => {
  assert.equal(
    provenanceRepo({ repository: 'git+https://github.com/a/b.git' }),
    'https://github.com/a/b',
  );
});

test('provenanceRepo: repository as shorthand string normalized (no scheme)', () => {
  assert.equal(provenanceRepo({ repository: 'github:a/b' }), 'github:a/b');
});

test('provenanceRepo: repository object without url -> null', () => {
  assert.equal(provenanceRepo({ repository: { type: 'git' } }), null);
});

test('provenanceRepo: repository object with non-string url -> null', () => {
  assert.equal(provenanceRepo({ repository: { url: 42 } }), null);
});

test('provenanceRepo: repository object with blank url -> null', () => {
  assert.equal(provenanceRepo({ repository: { url: '   ' } }), null);
});

test('provenanceRepo: blank repository string -> null', () => {
  assert.equal(provenanceRepo({ repository: '   ' }), null);
});

test('provenanceRepo: no repository field -> null', () => {
  assert.equal(provenanceRepo({ name: 'x' }), null);
});

test('provenanceRepo: repository as array (garbage) -> null', () => {
  assert.equal(provenanceRepo({ repository: ['a', 'b'] }), null);
});

test('provenanceRepo: defensive — garbage input -> null', () => {
  assert.equal(provenanceRepo(undefined), null);
  assert.equal(provenanceRepo(null), null);
  assert.equal(provenanceRepo('x'), null);
  assert.equal(provenanceRepo([]), null);
  assert.equal(provenanceRepo(0), null);
});

// ---------------------------------------------------------------------------
// integration-ish: a realistic full manifest
// ---------------------------------------------------------------------------

test('full realistic manifest: combined signals', () => {
  const m = {
    name: 'left-pad',
    version: '1.3.0',
    scripts: { postinstall: 'node ./scripts/postinstall.js', test: 'mocha' },
    repository: { type: 'git', url: 'git+https://github.com/stevemao/left-pad.git' },
    dist: {
      tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      attestations: { url: 'https://x', provenance: {} },
    },
  };
  assert.deepEqual(installScripts(m), ['postinstall']);
  assert.equal(hasInstallScripts(m), true);
  assert.equal(hasProvenance(m), true);
  assert.equal(provenanceRepo(m), 'https://github.com/stevemao/left-pad');
});

test('full realistic manifest: clean package, no signals', () => {
  const m = {
    name: 'is-odd',
    version: '3.0.1',
    scripts: { test: 'mocha' },
  };
  assert.deepEqual(installScripts(m), []);
  assert.equal(hasInstallScripts(m), false);
  assert.equal(hasProvenance(m), false);
  assert.equal(provenanceRepo(m), null);
});
