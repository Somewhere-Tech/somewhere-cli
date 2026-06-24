import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict } from './engine.mjs';

test('verified — clean package with capabilities + provenance (create-next-app)', () => {
  const r = computeVerdict({
    has_provenance: true,
    is_minified: false,
    has_install_scripts: true,
    description_match: 'match',
    capabilities: ['network', 'fs', 'child_process'],
  });
  assert.equal(r.verdict, 'verified');
  assert.deepEqual(r.verdict_signals, []);
});

test('verified — a lone soft signal is not enough (is-odd, no provenance only)', () => {
  const r = computeVerdict({ has_provenance: false, is_minified: false, has_install_scripts: false });
  assert.equal(r.verdict, 'verified');
});

test('verified — RULE 9: no_provenance + minified alone do NOT stop (both passive)', () => {
  // The single most common combo on npm — must stay verified, or we warn on a
  // huge slice of normal popular packages.
  const r = computeVerdict({ has_provenance: false, is_minified: true });
  assert.equal(r.verdict, 'verified');
});

test('unverified — a passive signal PLUS an active one crosses the threshold', () => {
  const r = computeVerdict({ has_provenance: false, has_install_scripts: true });
  assert.equal(r.verdict, 'unverified');
  assert.deepEqual(r.verdict_signals, ['no_provenance', 'install_scripts']);
});

test('verified — a lone active signal is not enough (install scripts alone)', () => {
  // A package with an install script but otherwise clean (e.g. has provenance)
  // stays verified — one signal never stops.
  assert.equal(computeVerdict({ has_install_scripts: true }).verdict, 'verified');
});

test('unverified — the some-analytics-tool case (4 soft signals)', () => {
  const r = computeVerdict({
    has_provenance: false,
    is_minified: true,
    has_install_scripts: true,
    description_match: 'mismatch',
  });
  assert.equal(r.verdict, 'unverified');
  assert.deepEqual(r.verdict_signals, [
    'no_provenance',
    'minified',
    'install_scripts',
    'description_mismatch',
  ]);
});

test('unverified — popular package with no GitHub tag', () => {
  const r = computeVerdict({ has_provenance: true, has_github_tag: 0, weekly_downloads: 50000 });
  assert.equal(r.verdict, 'unverified');
  assert.deepEqual(r.verdict_signals, ['no_github_tag']);
});

test('verified — no GitHub tag but unpopular (no false stop on the long tail)', () => {
  const r = computeVerdict({ has_provenance: true, has_github_tag: 0, weekly_downloads: 200 });
  assert.equal(r.verdict, 'verified');
});

test('suspicious — typosquat is a strong single signal', () => {
  const r = computeVerdict({ typosquat: { of: 'request', distance: 1 }, has_provenance: false });
  assert.equal(r.verdict, 'suspicious');
  assert.deepEqual(r.verdict_signals, ['typosquat']);
});

test('suspicious — LLM diff review flagged the change', () => {
  assert.equal(computeVerdict({ diff_review: 'suspicious' }).verdict, 'suspicious');
  assert.equal(computeVerdict({ diff_review: 'unexplained' }).verdict, 'suspicious');
  assert.equal(computeVerdict({ diff_review: 'clean' }).verdict, 'verified');
});

test('blocked — a confirmed MAL advisory hard-blocks', () => {
  const r = computeVerdict({ mal: [{ id: 'MAL-2025-09-384', sources: ['OpenSSF', 'OSV'] }] });
  assert.equal(r.verdict, 'blocked');
  assert.deepEqual(r.verdict_signals, ['MAL-2025-09-384']);
});

test('blocked beats every other signal', () => {
  const r = computeVerdict({
    mal: [{ id: 'MAL-1', sources: ['GitHub'] }],
    typosquat: { of: 'x', distance: 1 },
    has_provenance: false,
    is_minified: true,
  });
  assert.equal(r.verdict, 'blocked');
});

test('Amazon-Inspector-only advisory warns (suspicious), does not block', () => {
  const r = computeVerdict({ mal: [{ id: 'MAL-FP-1', sources: ['Amazon Inspector'] }] });
  assert.equal(r.verdict, 'suspicious');
  assert.ok(r.verdict_signals.some((x) => x.startsWith('mal_unconfirmed:')));
});

test('Amazon + another source IS confirmed → blocked', () => {
  const r = computeVerdict({ mal: [{ id: 'MAL-2', sources: ['Amazon Inspector', 'OSV'] }] });
  assert.equal(r.verdict, 'blocked');
});

test('empty / garbage input is verified, never throws', () => {
  assert.equal(computeVerdict().verdict, 'verified');
  assert.equal(computeVerdict({}).verdict, 'verified');
  assert.equal(computeVerdict({ mal: null, capabilities: null }).verdict, 'verified');
});
