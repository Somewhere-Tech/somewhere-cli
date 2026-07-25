import test from 'node:test';
import assert from 'node:assert/strict';
import { mechanicalVerdictFromRow, recomputeRow } from './backfill.mjs';

// A tiny in-memory verdict store standing in for D1.
function store(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    readVerdict: async (_sw, name, version) => m.get(`${name}@${version}`) ?? null,
    writeVerdict: async (_sw, v) => { m.set(`${v.package}@${v.version}`, v); },
  };
}
const noNetwork = () => { throw new Error('leaf rows must not touch the network'); };

test('mechanicalVerdictFromRow — re-derives from stored signals, no network', () => {
  // The zod-to-json-schema row: minified + no provenance + no tag, no active signal.
  const r = mechanicalVerdictFromRow({
    has_provenance: false, is_minified: true, has_install_scripts: false,
    has_github_tag: 0, weekly_downloads: 47_261_616, description_match: 'match',
  });
  assert.equal(r.verdict, 'verified');
});

test('recomputeRow — a no_github_tag LEAF clears to verified with ZERO fetches', async () => {
  const s = store();
  const row = {
    package: 'zod-to-json-schema', version: '3.25.2',
    has_provenance: false, is_minified: true, has_install_scripts: false,
    has_github_tag: 0, weekly_downloads: 47_261_616, description_match: 'match',
    dependencies: [], verdict: 'unverified', verdict_signals: ['no_github_tag'],
    dependency_flags: [], summary: 'the repo has no release tag for this version',
    author_package_count: 3,
  };
  const res = await recomputeRow(row, {
    sw: {}, ...s, fetchImpl: noNetwork, fetchPackument: noNetwork,
  });
  assert.equal(res.changed, true);
  assert.equal(res.to, 'verified');
  const saved = s.m.get('zod-to-json-schema@3.25.2');
  assert.equal(saved.verdict, 'verified');
  assert.deepEqual(saved.verdict_signals, []);
  // enrich fields are PRESERVED verbatim (no LLM, narrative untouched)
  assert.equal(saved.summary, 'the repo has no release tag for this version');
  assert.equal(saved.author_package_count, 3);
});

test('recomputeRow — provenance short-circuits the tag heuristic (@sigstore/bundle)', async () => {
  const s = store();
  const res = await recomputeRow({
    package: '@sigstore/bundle', version: '5.0.0',
    has_provenance: true, is_minified: false, has_install_scripts: false,
    has_github_tag: 0, weekly_downloads: 9_614_346, description_match: 'match',
    dependencies: [], verdict: 'unverified', verdict_signals: ['no_github_tag'], dependency_flags: [],
  }, { sw: {}, ...s, fetchImpl: noNetwork, fetchPackument: noNetwork });
  assert.equal(res.to, 'verified');
});

test('recomputeRow — idempotent: a corrected row rewrites to itself (0 change)', async () => {
  const s = store();
  const row = {
    package: 'left-pad', version: '1.3.0',
    has_provenance: false, is_minified: false, has_install_scripts: false,
    has_github_tag: 0, weekly_downloads: 2_000_000, description_match: 'match',
    dependencies: [], verdict: 'verified', verdict_signals: [], dependency_flags: [],
  };
  // Already correct under the new engine → recompute must not rewrite it.
  const res = await recomputeRow(row, { sw: {}, ...s, fetchImpl: noNetwork, fetchPackument: noNetwork });
  assert.equal(res.changed, false);
  assert.equal(res.to, 'verified');
});

test('recomputeRow — cascade STILL fires while a child is genuinely flagged', async () => {
  // parent has provenance (base=verified) but a child is unverified → suspicious.
  const s = store({ 'kid@1.0.0': { verdict: 'unverified' } });
  const fetchPackument = async () => ({ versions: { '2.0.0': { dependencies: { kid: '1.0.0' } } } });
  const res = await recomputeRow({
    package: 'parent', version: '2.0.0',
    has_provenance: true, has_github_tag: 0, weekly_downloads: 5_000_000, description_match: 'match',
    dependencies: ['kid'], verdict: 'suspicious', verdict_signals: ['no_github_tag', 'dependency_flagged'],
    dependency_flags: [{ name: 'kid', version: '1.0.0', verdict: 'unverified' }],
  }, { sw: {}, ...s, fetchImpl: async () => { throw new Error('exact range needs no fetch'); }, fetchPackument });
  assert.equal(res.to, 'suspicious');
  const saved = s.m.get('parent@2.0.0');
  // the stale no_github_tag signal is gone; the real cascade signal remains
  assert.deepEqual(saved.verdict_signals, ['dependency_flagged']);
});

test('convergence — parent clears on the pass AFTER its child clears (leaves first)', async () => {
  const s = store({
    // child: a no_github_tag leaf, still stale (pre-backfill)
    'kid@1.0.0': {
      package: 'kid', version: '1.0.0',
      has_provenance: true, has_github_tag: 0, weekly_downloads: 9_000_000, description_match: 'match',
      dependencies: [], verdict: 'unverified', verdict_signals: ['no_github_tag'], dependency_flags: [],
    },
  });
  const parent = {
    package: 'parent', version: '2.0.0',
    has_provenance: true, has_github_tag: 0, weekly_downloads: 5_000_000, description_match: 'match',
    dependencies: ['kid'], verdict: 'suspicious', verdict_signals: ['no_github_tag', 'dependency_flagged'],
    dependency_flags: [{ name: 'kid', version: '1.0.0', verdict: 'unverified' }],
  };
  s.m.set('parent@2.0.0', parent);
  const fetchPackument = async () => ({ versions: { '2.0.0': { dependencies: { kid: '1.0.0' } } } });
  const common = { sw: {}, ...s, fetchImpl: async () => { throw new Error('exact ranges need no fetch'); }, fetchPackument };

  // PASS 1, parent BEFORE child: parent still reads child='unverified' → stays suspicious.
  let p = await recomputeRow(s.m.get('parent@2.0.0'), common);
  assert.equal(p.to, 'suspicious');
  // PASS 1, child: clears to verified (leaf).
  const k = await recomputeRow(s.m.get('kid@1.0.0'), { ...common, fetchPackument: noNetwork });
  assert.equal(k.to, 'verified');
  // PASS 2, parent: now reads child='verified' → no flag → clears.
  p = await recomputeRow(s.m.get('parent@2.0.0'), common);
  assert.equal(p.to, 'verified');
  assert.deepEqual(s.m.get('parent@2.0.0').verdict_signals, []);
});
