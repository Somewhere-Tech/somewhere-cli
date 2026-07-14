import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  buildChecks,
  renderChecklist,
  renderVerdict,
  renderSingle,
  renderTree,
  shortReasons,
  toJsonVerdict,
} from '../dist/swpx/render.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const lines = (arr) => strip(arr.join('\n'));

test('renderVerdict — clean pass shows every check (wall of green + one honest ⚠)', () => {
  const v = {
    package: 'left-pad',
    version: '1.3.0',
    verdict: 'verified',
    weekly_downloads: 1400622,
    has_install_scripts: false,
    is_minified: false,
    capabilities: [],
    mal: [],
    has_github_tag: 1,
    has_provenance: false,
  };
  assert.equal(
    lines(renderVerdict(v)),
    [
      '✓ left-pad@1.3.0',
      '  ✓ 1.4M weekly downloads',
      '  ✓ No install scripts',
      '  ✓ Readable source',
      '  ✓ No system access',
      '  ✓ No advisories',
      '  ✓ GitHub tag exists',
      '  ⚠ No provenance',
    ].join('\n'),
  );
});

test('renderVerdict — flagged package: the red/yellow stands out, with the override footer', () => {
  const v = {
    package: 'some-sketchy-thing',
    version: '2.1.0',
    verdict: 'unverified',
    weekly_downloads: 11,
    has_install_scripts: true,
    install_script_types: ['postinstall'],
    is_minified: true,
    capabilities: ['network', 'fs', 'process.env'],
    mal: [],
    has_provenance: false,
    description: 'date formatting utility',
    description_match: 'mismatch',
  };
  assert.equal(
    lines(renderVerdict(v)),
    [
      '⚠ some-sketchy-thing@2.1.0',
      '  ⚠ 11 weekly downloads',
      '  ✖ Has postinstall script',
      '  ✖ Minified (unreadable)',
      '  ⚠ network, fs, process.env',
      '  ✓ No advisories',
      '  ⚠ No provenance',
      '  ✖ Doesn\'t match: "date formatting utility"',
      '  Run npx some-sketchy-thing to proceed unverified.',
    ].join('\n'),
  );
});

test('renderVerdict — override footer preserves the full npx invocation', () => {
  const v = { package: 'lakebed', version: '1.0.0', verdict: 'unverified' };
  assert.match(
    lines(renderVerdict(v, 'npx lakebed login')),
    /Run npx lakebed login to proceed unverified\.$/,
  );
});

test('renderVerdict — blocked: advisory row + safe versions + malware footer', () => {
  const v = {
    package: '@ctrl/tinycolor',
    version: '4.1.1',
    verdict: 'blocked',
    weekly_downloads: 50000,
    has_install_scripts: true,
    install_script_types: ['preinstall'],
    is_minified: true,
    capabilities: ['network', 'child_process'],
    has_provenance: false,
    mal: [{ id: 'MAL-2025-09-384', summary: 'credential-harvesting via preinstall hook', safe_versions: ['4.0.0', '4.2.0'] }],
  };
  const out = lines(renderVerdict(v));
  assert.match(out, /^✖ @ctrl\/tinycolor@4\.1\.1/);
  assert.match(out, /✖ MAL-2025-09-384: credential-harvesting via preinstall hook/);
  assert.match(out, /Safe versions: @ctrl\/tinycolor@4\.0\.0, @ctrl\/tinycolor@4\.2\.0/);
  assert.match(out, /Confirmed malware\. Do not install\./);
});

test('buildChecks — download thresholds (✓ popular, ⚠ low, omitted when unknown)', () => {
  const dl = (n) => buildChecks({ package: 'p', version: '1', verdict: 'verified', weekly_downloads: n })[0];
  assert.deepEqual(dl(4_570_900_000), { level: 'ok', text: '4.6B weekly downloads' });
  assert.deepEqual(dl(1400622), { level: 'ok', text: '1.4M weekly downloads' });
  assert.deepEqual(dl(50000), { level: 'ok', text: '50k weekly downloads' });
  assert.deepEqual(dl(11), { level: 'warn', text: '11 weekly downloads' });
  // unknown downloads → no row at all (don't fabricate a check)
  const noDl = buildChecks({ package: 'p', version: '1', verdict: 'verified' });
  assert.ok(!noDl.some((c) => /weekly downloads/.test(c.text)));
});

test('buildChecks — install scripts ✖ when present, ✓ when absent', () => {
  const withScript = buildChecks({ package: 'p', version: '1', verdict: 'verified', has_install_scripts: true, install_script_types: ['postinstall'] });
  assert.ok(withScript.some((c) => c.level === 'bad' && c.text === 'Has postinstall script'));
  const without = buildChecks({ package: 'p', version: '1', verdict: 'verified', has_install_scripts: false });
  assert.ok(without.some((c) => c.level === 'ok' && c.text === 'No install scripts'));
});

test('buildChecks — github tag row omitted when not checked (null)', () => {
  const checks = buildChecks({ package: 'p', version: '1', verdict: 'verified', has_github_tag: null });
  assert.ok(!checks.some((c) => /GitHub tag/.test(c.text)));
  const tagged = buildChecks({ package: 'p', version: '1', verdict: 'verified', has_github_tag: 1 });
  assert.ok(tagged.some((c) => c.level === 'ok' && c.text === 'GitHub tag exists'));
  const noTag = buildChecks({ package: 'p', version: '1', verdict: 'verified', has_github_tag: 0 });
  assert.ok(noTag.some((c) => c.level === 'warn' && c.text === 'No GitHub tag'));
});

test('buildChecks — provenance ✓ when present, ⚠ when absent', () => {
  assert.ok(buildChecks({ package: 'p', version: '1', verdict: 'verified', has_provenance: true }).some((c) => c.level === 'ok' && c.text === 'Provenance verified'));
  assert.ok(buildChecks({ package: 'p', version: '1', verdict: 'verified', has_provenance: false }).some((c) => c.level === 'warn' && c.text === 'No provenance'));
});

test('buildChecks — description match row only appears once the LLM ran', () => {
  assert.ok(!buildChecks({ package: 'p', version: '1', verdict: 'verified' }).some((c) => /match/.test(c.text)));
  assert.ok(buildChecks({ package: 'p', version: '1', verdict: 'verified', description_match: 'match' }).some((c) => c.level === 'ok' && c.text === 'Matches description'));
});

test('renderChecklist header marked by verdict level', () => {
  assert.match(strip(renderChecklist({ package: 'a', version: '1', verdict: 'verified' })[0]), /^✓ a@1$/);
  assert.match(strip(renderChecklist({ package: 'a', version: '1', verdict: 'unverified' })[0]), /^⚠ a@1$/);
  assert.match(strip(renderChecklist({ package: 'a', version: '1', verdict: 'blocked' })[0]), /^✖ a@1$/);
});

test('renderSingle delegates to renderVerdict', () => {
  const v = { package: 'a', version: '1', verdict: 'verified', has_provenance: true };
  assert.equal(lines(renderSingle(v)), lines(renderVerdict(v)));
});

test('decide — verified runs, unverified/suspicious stop, blocked blocks', () => {
  assert.equal(decide({ package: 'a', version: '1', verdict: 'verified' }), 'run');
  assert.equal(decide({ package: 'a', version: '1', verdict: 'unverified' }), 'stop');
  assert.equal(decide({ package: 'a', version: '1', verdict: 'suspicious' }), 'stop');
  assert.equal(decide({ package: 'a', version: '1', verdict: 'blocked' }), 'block');
});

test('toJsonVerdict — stable --json projection (landing page shape)', () => {
  const ageMs = 2160 * 3_600_000;
  const v = {
    package: 'some-pkg',
    version: '2.1.0',
    verdict: 'unverified',
    has_provenance: false,
    is_minified: true,
    install_script_types: ['postinstall'],
    capabilities: ['network', 'fs', 'process.env'],
    description_match: 'mismatch',
    mal: [],
    typosquat_distance: null,
    publish_time: new Date(Date.now() - ageMs).toISOString(),
  };
  const j = toJsonVerdict(v);
  assert.equal(j.verdict, 'unverified');
  assert.equal(j.signals.provenance, false);
  assert.equal(j.signals.readable, false);
  assert.deepEqual(j.signals.install_scripts, ['postinstall']);
  assert.deepEqual(j.signals.capabilities, ['network', 'fs', 'process.env']);
  assert.equal(j.signals.description_match, false);
  assert.deepEqual(j.signals.mal_advisories, []);
  assert.ok(Math.abs(j.signals.age_hours - 2160) <= 1, `age_hours ${j.signals.age_hours}`);
});

test('shortReasons — compact tree-row reasons (swpm)', () => {
  assert.equal(
    shortReasons({ package: 'o', version: '1', verdict: 'unverified', is_minified: true, has_provenance: false }),
    'minified, no provenance',
  );
  assert.equal(
    shortReasons({ package: 'x', version: '1', verdict: 'blocked', mal: [{ id: 'MAL-2025-09-384' }] }),
    'MAL-2025-09-384',
  );
});

test('renderTree — full tree summary (swpm install)', () => {
  const verified = Array.from({ length: 44 }, (_, i) => ({ package: `pkg-${i}`, version: '1.0.0', verdict: 'verified' }));
  const items = [
    ...verified,
    { package: 'obfuscated-util', version: '1.2.0', verdict: 'unverified', is_minified: true, has_provenance: false },
    { package: 'tiny-helper', version: '0.8.1', verdict: 'unverified', has_provenance: false, has_install_scripts: true, install_script_types: ['postinstall'] },
    { package: '@ctrl/tinycolor', version: '4.1.1', verdict: 'blocked', mal: [{ id: 'MAL-2025-09-384' }] },
  ];
  assert.equal(
    lines(renderTree(items, 12)),
    [
      'Checking 47 packages (12 direct, 35 transitive)',
      '  ✓ 44 verified',
      '  ⚠  2 unverified',
      '     ├ obfuscated-util@1.2.0 — minified, no provenance',
      '     └ tiny-helper@0.8.1 — no provenance, has postinstall',
      '  ✖  1 blocked',
      '     └ @ctrl/tinycolor@4.1.1 — MAL-2025-09-384',
      '  Remove or replace blocked packages to continue.',
      '  Run npm install to bypass all checks.',
    ].join('\n'),
  );
});

test('renderVerdict — rich: narrative headline + author + dependencies + github link', () => {
  const v = {
    package: 'tiny-thing', version: '0.1.0', verdict: 'verified',
    weekly_downloads: 47,
    publisher: 'sindresorhus', author_package_count: 150, author_total_downloads: 2000000,
    has_install_scripts: false, is_minified: false, capabilities: [], mal: [],
    dependencies: ['escape-string-regexp'],
    has_github_tag: 1, has_provenance: false,
    github_repo: 'https://github.com/sindresorhus/tiny-thing',
    summary: 'Small package (47 weekly downloads) but authored by sindresorhus who maintains 150 packages. No provenance here — common for their older packages. Readable, no system access.',
    description_match: 'match',
  };
  const out = lines(renderVerdict(v));
  assert.match(out, /authored by sindresorhus/); // narrative paragraph present
  assert.match(out, /✓ Author: sindresorhus \(150 packages, 2M combined\)/);
  assert.match(out, /✓ 1 dependency: escape-string-regexp/);
  assert.match(out, /→ https:\/\/github\.com\/sindresorhus\/tiny-thing/);
});

test('buildChecks — single-package author is a caution (⚠), established is ok (✓)', () => {
  const newbie = buildChecks({ package: 'x', version: '1', verdict: 'verified', publisher: 'newbie', author_package_count: 1 });
  assert.ok(newbie.some((c) => c.level === 'warn' && /Author: newbie/.test(c.text)));
  const estab = buildChecks({ package: 'x', version: '1', verdict: 'verified', publisher: 'sindresorhus', author_package_count: 150, author_total_downloads: 2000000 });
  assert.ok(estab.some((c) => c.level === 'ok' && /Author: sindresorhus \(150 packages, 2M combined\)/.test(c.text)));
});

test('buildChecks — dependency row: none / few (named) / many (count)', () => {
  assert.ok(buildChecks({ package: 'x', version: '1', verdict: 'verified', dependencies: [] }).some((c) => c.text === 'No dependencies'));
  assert.ok(buildChecks({ package: 'x', version: '1', verdict: 'verified', dependencies: ['a', 'b'] }).some((c) => c.text === '2 dependencies: a, b'));
  assert.ok(buildChecks({ package: 'x', version: '1', verdict: 'verified', dependencies: Array.from({ length: 9 }, (_, i) => 'd' + i) }).some((c) => c.text === '9 dependencies'));
});

test('buildChecks — license row appears only when present', () => {
  assert.ok(buildChecks({ package: 'x', version: '1', verdict: 'verified', license: 'MIT' }).some((c) => c.level === 'ok' && c.text === 'MIT licensed'));
  assert.ok(!buildChecks({ package: 'x', version: '1', verdict: 'verified' }).some((c) => /licensed/.test(c.text)));
});

test('buildChecks — maintainer change: ⚠ when changed (with previous), ✓ when same, omitted when unknown', () => {
  const changed = buildChecks({ package: 'x', version: '1', verdict: 'verified', maintainer_changed: true, previous_publisher: 'oldguy' });
  assert.ok(changed.some((c) => c.level === 'warn' && c.text === 'Publisher changed since previous release (was oldguy)'));
  const same = buildChecks({ package: 'x', version: '1', verdict: 'verified', maintainer_changed: false });
  assert.ok(same.some((c) => c.level === 'ok' && c.text === 'Same publisher as previous release'));
  assert.ok(!buildChecks({ package: 'x', version: '1', verdict: 'verified' }).some((c) => /publisher/i.test(c.text)));
});

test('buildChecks — repo maintenance: archived ⚠, last-commit age + open issues, stale ⚠', () => {
  assert.ok(buildChecks({ package: 'x', version: '1', verdict: 'verified', repo_archived: true }).some((c) => c.level === 'warn' && c.text === 'Source repo is archived'));
  const recent = new Date(Date.now() - 10 * 86400000).toISOString();
  assert.ok(buildChecks({ package: 'x', version: '1', verdict: 'verified', repo_last_commit: recent, repo_open_issues: 47 }).some((c) => c.level === 'ok' && c.text === 'Repo last updated 10d ago, 47 open issues'));
  const stale = new Date(Date.now() - 800 * 86400000).toISOString();
  assert.ok(buildChecks({ package: 'x', version: '1', verdict: 'verified', repo_last_commit: stale }).some((c) => c.level === 'warn' && /Repo last updated/.test(c.text)));
});

test('buildChecks — dependency breakdown (verified / flagged / not yet checked)', () => {
  assert.ok(
    buildChecks({ package: 'x', version: '1', verdict: 'verified', dependencies: ['a', 'b', 'c'], dependency_flags: [], dep_verified: 1, dep_unknown: 2 })
      .some((c) => c.level === 'ok' && c.text === '3 dependencies — 1 verified · 2 not yet checked'),
  );
  const flagged = buildChecks({
    package: 'x', version: '1', verdict: 'suspicious',
    dependencies: ['a', 'b'], dependency_flags: [{ name: 'evil', version: '1.0.0', verdict: 'blocked' }], dep_verified: 1, dep_unknown: 0,
  });
  assert.ok(flagged.some((c) => c.level === 'bad' && c.text === '2 dependencies — 1 verified · 1 flagged: evil (blocked)'));
});
