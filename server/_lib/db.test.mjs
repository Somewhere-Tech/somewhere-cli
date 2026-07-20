import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowToVerdict, verdictToParams, writeVerdict } from './db.mjs';

const COLUMNS = [
  'package', 'version', 'computed_at', 'has_provenance', 'provenance_commit', 'provenance_repo',
  'has_install_scripts', 'install_script_types', 'is_minified', 'capabilities', 'typosquat_of',
  'typosquat_distance', 'has_github_tag', 'github_repo', 'publish_time', 'publisher', 'description',
  'description_match', 'description_match_reason', 'diff_review', 'diff_review_reason',
  'diff_from_version', 'weekly_downloads', 'verdict', 'verdict_signals',
  'summary', 'author_package_count', 'author_total_downloads', 'author_first_publish', 'dependencies',
  'known_cves', 'compromised_history', 'dependency_flags',
];

const zipRow = (params) => Object.fromEntries(COLUMNS.map((c, i) => [c, params[i]]));

test('verdictToParams → row → rowToVerdict round-trips a full verdict', () => {
  const v = {
    package: '@ctrl/tinycolor',
    version: '4.1.1',
    verdict: 'unverified',
    verdict_signals: ['no_provenance', 'minified'],
    capabilities: ['network', 'fs'],
    has_provenance: false,
    provenance_commit: null,
    provenance_repo: null,
    is_minified: true,
    has_install_scripts: true,
    install_script_types: ['postinstall'],
    typosquat_of: null,
    typosquat_distance: null,
    has_github_tag: 0,
    github_repo: 'https://github.com/ctrl/tinycolor',
    publish_time: '2025-01-01T00:00:00Z',
    publisher: 'someuser',
    description: 'a color tool',
    description_match: null,
    description_match_reason: null,
    diff_review: null,
    diff_review_reason: null,
    diff_from_version: null,
    weekly_downloads: 123456,
    summary: 'Sketchy because a dependency is blocked.',
    author_package_count: 1,
    author_total_downloads: 42,
    author_first_publish: '2025-01-01T00:00:00Z',
    dependencies: ['a', 'b'],
    known_cves: 3,
    compromised_history: [{ id: 'MAL-2025-99', published: '2025-09-15' }],
    dependency_flags: [{ name: 'b', version: '2.0.0', verdict: 'blocked' }],
    computed_at: '2026-06-24T00:00:00Z',
  };
  const back = rowToVerdict(zipRow(verdictToParams(v)));
  assert.equal(back.verdict, 'unverified');
  assert.deepEqual(back.verdict_signals, ['no_provenance', 'minified']);
  assert.deepEqual(back.capabilities, ['network', 'fs']);
  assert.equal(back.has_provenance, false);
  assert.equal(back.is_minified, true);
  assert.equal(back.has_install_scripts, true);
  assert.deepEqual(back.install_script_types, ['postinstall']);
  assert.equal(back.has_github_tag, 0);
  assert.equal(back.weekly_downloads, 123456);
  assert.equal(back.github_repo, 'https://github.com/ctrl/tinycolor');
  assert.equal(back.known_cves, 3);
  assert.deepEqual(back.compromised_history, [{ id: 'MAL-2025-99', published: '2025-09-15' }]);
  assert.deepEqual(back.dependency_flags, [{ name: 'b', version: '2.0.0', verdict: 'blocked' }]);
});

test('rowToVerdict — booleans from 0/1, null github tag stays null', () => {
  const r = rowToVerdict(
    zipRow(
      verdictToParams({
        package: 'x',
        version: '1',
        verdict: 'verified',
        verdict_signals: [],
        capabilities: [],
        has_provenance: true,
        is_minified: false,
        has_install_scripts: false,
        install_script_types: [],
        has_github_tag: null,
        weekly_downloads: null,
        computed_at: 't',
      }),
    ),
  );
  assert.equal(r.has_provenance, true);
  assert.equal(r.is_minified, false);
  assert.equal(r.has_github_tag, null);
  assert.equal(r.weekly_downloads, null);
  assert.equal(r.known_cves, 0);
  assert.deepEqual(r.compromised_history, []);
  assert.deepEqual(r.dependency_flags, []);
});

test('writeVerdict performs only the cache-row write; schema belongs to migrations', async () => {
  const statements = [];
  const sw = {
    db: {
      async query(sql) {
        statements.push(sql);
        return { data: [], changes: 1 };
      },
    },
  };
  await writeVerdict(sw, {
    package: 'semver',
    version: '7.7.2',
    verdict: 'verified',
    verdict_signals: [],
    capabilities: [],
    has_provenance: true,
    is_minified: false,
    has_install_scripts: false,
    install_script_types: [],
    computed_at: '2026-07-19T00:00:00Z',
  });
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^INSERT OR REPLACE INTO verdicts/);
  assert.doesNotMatch(statements[0], /\b(?:ALTER|CREATE|DROP)\b/i);
});

test('verdict request handler contains no runtime DDL fallback', () => {
  const source = readFileSync(new URL('../api/verdict/[pkg]/[version].js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:ALTER|CREATE|DROP)\s+(?:TABLE|INDEX)\b/i);
});
