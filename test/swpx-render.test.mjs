import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  renderVerified,
  renderEvidence,
  renderBlocked,
  renderSingle,
  renderTree,
  shortReasons,
  toJsonVerdict,
} from '../dist/swpx/render.js';

// chalk emits no color on a non-TTY, but strip ANSI anyway so assertions read
// the plain text regardless of FORCE_COLOR.
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const lines = (arr) => strip(arr.join('\n'));

test('renderVerified — caps + description match (landing page)', () => {
  const v = {
    package: 'create-next-app',
    version: '15.2.0',
    verdict: 'verified',
    capabilities: ['network', 'fs', 'child_process'],
    description: 'Create Next.js apps',
    description_match: 'match',
  };
  assert.equal(
    strip(renderVerified(v)),
    '✓ create-next-app@15.2.0 — network, fs, child_process ✓ matches "Create Next.js apps"',
  );
});

test('renderVerified — no system access (landing page)', () => {
  const v = { package: 'is-odd', version: '1.0.0', verdict: 'verified', capabilities: [] };
  assert.equal(strip(renderVerified(v)), '✓ is-odd@1.0.0 — (no system access)');
});

test('renderVerified — match line omitted when description_match is not "match"', () => {
  const v = {
    package: 'lakebed',
    version: '0.2.1',
    verdict: 'verified',
    capabilities: ['network', 'fs'],
    description: 'deploy apps to capsules',
    description_match: 'unclear',
  };
  assert.equal(strip(renderVerified(v)), '✓ lakebed@0.2.1 — network, fs');
});

test('renderEvidence — unverified block (landing page)', () => {
  const v = {
    package: 'some-analytics-tool',
    version: '2.1.0',
    verdict: 'unverified',
    has_provenance: false,
    is_minified: true,
    has_install_scripts: true,
    install_script_types: ['postinstall'],
    capabilities: ['network', 'fs', 'child_process', 'process.env'],
    description: 'lightweight date formatter',
    description_match: 'mismatch',
  };
  assert.equal(
    lines(renderEvidence(v)),
    [
      '⚠ some-analytics-tool@2.1.0 — could not verify',
      '  ⚠ No provenance (source unverifiable)',
      '  ⚠ Minified source (unreadable)',
      '  ⚠ Has install scripts (postinstall)',
      '  ⚠ network, fs, child_process, process.env',
      '  ⚠ Capabilities don\'t match description: "lightweight date formatter"',
      '  Run npx some-analytics-tool to proceed unverified.',
    ].join('\n'),
  );
});

test('renderBlocked — confirmed malware (landing page)', () => {
  const v = {
    package: '@ctrl/tinycolor',
    version: '4.1.1',
    verdict: 'blocked',
    mal: [
      {
        id: 'MAL-2025-09-384',
        summary: 'credential-harvesting via preinstall hook',
        disclosed: '2025-09-15',
        source: 'OpenSSF / OSV',
        safe_versions: ['4.0.0', '4.2.0'],
      },
    ],
  };
  assert.equal(
    lines(renderBlocked(v)),
    [
      '✖ BLOCKED — @ctrl/tinycolor@4.1.1',
      '  MAL-2025-09-384: credential-harvesting via preinstall hook',
      '  Disclosed: 2025-09-15 · Source: OpenSSF / OSV',
      '  Safe versions: @ctrl/tinycolor@4.0.0, @ctrl/tinycolor@4.2.0',
      '  This version is confirmed malware. Do not install.',
    ].join('\n'),
  );
});

test('decide — verified runs, unverified/suspicious stop, blocked blocks', () => {
  assert.equal(decide({ package: 'a', version: '1', verdict: 'verified' }), 'run');
  assert.equal(decide({ package: 'a', version: '1', verdict: 'unverified' }), 'stop');
  assert.equal(decide({ package: 'a', version: '1', verdict: 'suspicious' }), 'stop');
  assert.equal(decide({ package: 'a', version: '1', verdict: 'blocked' }), 'block');
});

test('renderSingle picks the block matching the verdict', () => {
  assert.match(strip(renderSingle({ package: 'a', version: '1', verdict: 'verified' })[0]), /^✓ /);
  assert.match(
    strip(renderSingle({ package: 'a', version: '1', verdict: 'unverified', has_provenance: false })[0]),
    /could not verify$/,
  );
  assert.match(
    strip(renderSingle({ package: 'a', version: '1', verdict: 'blocked', mal: [{ id: 'MAL-1' }] })[0]),
    /^✖ BLOCKED/,
  );
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
  assert.equal(j.package, 'some-pkg');
  assert.equal(j.version, '2.1.0');
  assert.equal(j.verdict, 'unverified');
  assert.equal(j.signals.provenance, false);
  assert.equal(j.signals.readable, false);
  assert.deepEqual(j.signals.install_scripts, ['postinstall']);
  assert.deepEqual(j.signals.capabilities, ['network', 'fs', 'process.env']);
  assert.equal(j.signals.description_match, false);
  assert.deepEqual(j.signals.mal_advisories, []);
  assert.equal(j.signals.typosquat_distance, null);
  assert.ok(Math.abs(j.signals.age_hours - 2160) <= 1, `age_hours ${j.signals.age_hours}`);
});

test('toJsonVerdict — age_hours null without publish_time', () => {
  const j = toJsonVerdict({ package: 'a', version: '1', verdict: 'verified' });
  assert.equal(j.signals.age_hours, null);
});

test('shortReasons — compact tree-row reasons', () => {
  assert.equal(
    shortReasons({ package: 'o', version: '1', verdict: 'unverified', is_minified: true, has_provenance: false }),
    'minified, no provenance',
  );
  assert.equal(
    shortReasons({
      package: 't',
      version: '1',
      verdict: 'unverified',
      has_provenance: false,
      has_install_scripts: true,
      install_script_types: ['postinstall'],
    }),
    'no provenance, has postinstall',
  );
  assert.equal(
    shortReasons({ package: 'x', version: '1', verdict: 'blocked', mal: [{ id: 'MAL-2025-09-384' }] }),
    'MAL-2025-09-384',
  );
});

test('renderTree — full tree summary (landing page)', () => {
  const verified = Array.from({ length: 44 }, (_, i) => ({
    package: `pkg-${i}`,
    version: '1.0.0',
    verdict: 'verified',
  }));
  const items = [
    ...verified,
    {
      package: 'obfuscated-util',
      version: '1.2.0',
      verdict: 'unverified',
      is_minified: true,
      has_provenance: false,
    },
    {
      package: 'tiny-helper',
      version: '0.8.1',
      verdict: 'unverified',
      has_provenance: false,
      has_install_scripts: true,
      install_script_types: ['postinstall'],
    },
    {
      package: '@ctrl/tinycolor',
      version: '4.1.1',
      verdict: 'blocked',
      mal: [{ id: 'MAL-2025-09-384' }],
    },
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
