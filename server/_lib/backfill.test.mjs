import test from 'node:test';
import assert from 'node:assert/strict';
import { mechanicalVerdictFromRow, correctedInstallScripts, recomputeRow } from './backfill.mjs';

// A tiny in-memory verdict store standing in for D1.
function store(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    readVerdict: async (_sw, name, version) => m.get(`${name}@${version}`) ?? null,
    writeVerdict: async (_sw, v) => { m.set(`${v.package}@${v.version}`, v); },
  };
}

test('correctedInstallScripts — drops prepare from the stored type list', () => {
  assert.deepEqual(correctedInstallScripts({ install_script_types: ['prepare'] }), { types: [], has: false });
  assert.deepEqual(
    correctedInstallScripts({ install_script_types: ['postinstall', 'prepare'] }),
    { types: ['postinstall'], has: true },
  );
});

test('mechanicalVerdictFromRow — a prepare-only leaf re-derives to VERIFIED (no network)', () => {
  // minipass / minimatch shape: no provenance, has_github_tag, only script is
  // `prepare`. Under the old rule this was unverified [no_provenance, install_scripts].
  const r = mechanicalVerdictFromRow({
    has_provenance: false, is_minified: false, has_github_tag: 1, weekly_downloads: 370_000_000,
    description_match: 'match', install_script_types: ['prepare'], has_install_scripts: true,
  });
  assert.equal(r.verdict, 'verified');
});

test('mechanicalVerdictFromRow — a REAL postinstall still tips to unverified', () => {
  const r = mechanicalVerdictFromRow({
    has_provenance: false, has_github_tag: 1, install_script_types: ['postinstall'], has_install_scripts: true,
  });
  assert.equal(r.verdict, 'unverified');
  assert.deepEqual(r.verdict_signals, ['no_provenance', 'install_scripts']);
});

test('recomputeRow — prepare-only leaf clears to verified and drops the stale script label', async () => {
  const s = store();
  const res = await recomputeRow({
    package: 'minipass', version: '7.1.3',
    has_provenance: false, is_minified: false, has_github_tag: 1, weekly_downloads: 370_529_989,
    description_match: 'match', install_script_types: ['prepare'], has_install_scripts: true,
    dependencies: [], verdict: 'unverified', verdict_signals: ['no_provenance', 'install_scripts'],
    dependency_flags: [], summary: 'ships an install script',
  }, { sw: {}, ...s });
  assert.equal(res.to, 'verified');
  const saved = s.m.get('minipass@7.1.3');
  assert.deepEqual(saved.install_script_types, []);
  assert.equal(saved.has_install_scripts, false);
  assert.equal(saved.summary, 'ships an install script'); // narrative preserved
});

test('recomputeRow — cascade re-reads STORED flags by their exact version key', async () => {
  // sigstore@5.0.0's real stored flags point at CONCRETE versions, not `latest`.
  // A parent must re-read @sigstore/sign@5.0.0, not @sigstore/sign@latest.
  const s = store({
    '@sigstore/sign@5.0.0': { verdict: 'verified' },   // concrete, now clean
    '@sigstore/sign@latest': { verdict: 'suspicious' }, // decoy alias — must be ignored
  });
  const res = await recomputeRow({
    package: 'sigstore', version: '5.0.0',
    has_provenance: true, has_github_tag: 0, weekly_downloads: 9_874_993, description_match: 'match',
    install_script_types: [], has_install_scripts: false,
    dependencies: ['@sigstore/sign'], verdict: 'suspicious', verdict_signals: ['no_github_tag', 'dependency_flagged'],
    dependency_flags: [{ name: '@sigstore/sign', version: '5.0.0', verdict: 'suspicious' }],
  }, { sw: {}, ...s });
  assert.equal(res.to, 'verified');
});

// The regression the founder hit: a parent whose ONLY reason to be flagged is a
// prepare-only leaf several levels down. Reproduces the sigstore chain in
// miniature and asserts the whole thing clears (FAILS before the prepare fix).
test('convergence — sigstore-shape chain clears once the prepare leaf clears', async () => {
  const s = store();
  const common = { sw: {} };
  const row = (over) => ({
    has_provenance: true, has_github_tag: 0, description_match: 'match',
    install_script_types: [], has_install_scripts: false, verdict_signals: ['dependency_flagged'],
    ...over,
  });
  // leaf: prepare-only, no provenance → was unverified, must re-derive verified
  s.m.set('minipass@7.1.3', row({
    package: 'minipass', version: '7.1.3', has_provenance: false, has_github_tag: 1,
    install_script_types: ['prepare'], has_install_scripts: true,
    verdict: 'unverified', verdict_signals: ['no_provenance', 'install_scripts'],
    dependency_flags: [], dependencies: [],
  }));
  s.m.set('@sigstore/sign@5.0.0', row({
    package: '@sigstore/sign', version: '5.0.0', verdict: 'suspicious',
    dependency_flags: [{ name: 'minipass', version: '7.1.3', verdict: 'unverified' }],
    dependencies: ['minipass'],
  }));
  s.m.set('sigstore@5.0.0', row({
    package: 'sigstore', version: '5.0.0', verdict: 'suspicious',
    dependency_flags: [{ name: '@sigstore/sign', version: '5.0.0', verdict: 'suspicious' }],
    dependencies: ['@sigstore/sign'],
  }));

  const rr = (k) => recomputeRow(s.m.get(k), { ...common, readVerdict: s.readVerdict, writeVerdict: s.writeVerdict });
  // Pass 1: leaf clears; sign still reads leaf as… already cleared if processed after,
  // so run bottom-up to model one converging pass, then a second for the root.
  assert.equal((await rr('minipass@7.1.3')).to, 'verified');
  assert.equal((await rr('@sigstore/sign@5.0.0')).to, 'verified');
  assert.equal((await rr('sigstore@5.0.0')).to, 'verified');
  assert.deepEqual(s.m.get('sigstore@5.0.0').verdict_signals, []);
});

test('recomputeRow — idempotent: a corrected row rewrites to itself (0 change)', async () => {
  const s = store();
  const res = await recomputeRow({
    package: 'left-pad', version: '1.3.0',
    has_provenance: false, has_github_tag: 0, weekly_downloads: 2_000_000, description_match: 'match',
    install_script_types: [], has_install_scripts: false,
    dependencies: [], verdict: 'verified', verdict_signals: [], dependency_flags: [],
  }, { sw: {}, ...s });
  assert.equal(res.changed, false);
});
