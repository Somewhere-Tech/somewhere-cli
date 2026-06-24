import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMalAdvisory, queryMalAdvisories } from './osv.mjs';
import { parseRepoSlug, hasGithubTag } from './github.mjs';
import { entryFile, publishTime, weeklyDownloads, fetchEntrySource } from './registry.mjs';

const resp = (body, ok = true, status = 200, kind = 'json') => async () => ({
  ok,
  status,
  json: async () => body,
  text: async () => (kind === 'text' ? body : JSON.stringify(body)),
});

// ---- OSV ----

test('parseMalAdvisory — extracts id, summary, date, sources, safe versions', () => {
  const a = parseMalAdvisory({
    id: 'MAL-2025-09-384',
    summary: 'credential-harvesting via preinstall hook',
    published: '2025-09-15T00:00:00Z',
    references: [{ url: 'https://github.com/ossf/malicious-packages/x' }, { url: 'https://osv.dev/MAL-2025-09-384' }],
    affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.2.0' }] }] }],
  });
  assert.equal(a.id, 'MAL-2025-09-384');
  assert.equal(a.disclosed, '2025-09-15');
  assert.deepEqual(a.sources, ['OpenSSF', 'OSV']);
  assert.equal(a.source, 'OpenSSF / OSV');
  assert.deepEqual(a.safe_versions, ['4.2.0']);
});

test('parseMalAdvisory — defaults source to OSV when no references', () => {
  const a = parseMalAdvisory({ id: 'MAL-1' });
  assert.deepEqual(a.sources, ['OSV']);
  assert.ok(a.summary);
});

test('parseMalAdvisory — Amazon-only attribution preserved (drives warn-not-block)', () => {
  const a = parseMalAdvisory({ id: 'MAL-2', references: [{ url: 'https://aws.amazon.com/inspector/x' }] });
  assert.deepEqual(a.sources, ['Amazon Inspector']);
});

test('queryMalAdvisories — keeps only MAL- ids', async () => {
  const out = await queryMalAdvisories('pkg', '1.0.0', {
    fetchImpl: resp({
      vulns: [
        { id: 'MAL-2025-1', references: [] },
        { id: 'GHSA-xxxx', references: [] },
        { id: 'CVE-2025-1', references: [] },
      ],
    }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'MAL-2025-1');
});

test('queryMalAdvisories — no vulns → empty', async () => {
  assert.deepEqual(await queryMalAdvisories('pkg', '1.0.0', { fetchImpl: resp({}) }), []);
});

test('queryMalAdvisories — HTTP error throws (never a silent clean pass)', async () => {
  await assert.rejects(() => queryMalAdvisories('pkg', '1.0.0', { fetchImpl: resp({}, false, 500) }));
});

// ---- GitHub ----

test('parseRepoSlug — git+https, ssh, git@, plain forms', () => {
  assert.deepEqual(parseRepoSlug('git+https://github.com/ctrl/tinycolor.git'), {
    owner: 'ctrl',
    repo: 'tinycolor',
  });
  assert.deepEqual(parseRepoSlug('git@github.com:vercel/next.js.git'), {
    owner: 'vercel',
    repo: 'next.js',
  });
  assert.deepEqual(parseRepoSlug('https://github.com/foo/bar'), { owner: 'foo', repo: 'bar' });
  assert.equal(parseRepoSlug('https://gitlab.com/foo/bar'), null);
  assert.equal(parseRepoSlug(undefined), null);
});

test('hasGithubTag — 1 when the v-tag exists', async () => {
  assert.equal(await hasGithubTag('https://github.com/a/b', '1.0.0', { fetchImpl: resp({}, true, 200) }), 1);
});

test('hasGithubTag — 0 when neither tag form exists (both 404)', async () => {
  assert.equal(await hasGithubTag('https://github.com/a/b', '1.0.0', { fetchImpl: resp({}, false, 404) }), 0);
});

test('hasGithubTag — null on no repo / non-github / rate limit', async () => {
  assert.equal(await hasGithubTag('https://gitlab.com/a/b', '1.0.0', { fetchImpl: resp({}, true, 200) }), null);
  assert.equal(await hasGithubTag(null, '1.0.0', {}), null);
  assert.equal(await hasGithubTag('https://github.com/a/b', '1.0.0', { fetchImpl: resp({}, false, 403) }), null);
});

// ---- registry helpers ----

test('entryFile — main normalised, defaults to index.js', () => {
  assert.equal(entryFile({ main: './lib/index.js' }), 'lib/index.js');
  assert.equal(entryFile({ main: 'dist/x.js' }), 'dist/x.js');
  assert.equal(entryFile({}), 'index.js');
});

test('publishTime — reads the version out of the time map', () => {
  assert.equal(publishTime({ time: { '1.0.0': '2025-01-02T00:00:00Z' } }, '1.0.0'), '2025-01-02T00:00:00Z');
  assert.equal(publishTime({}, '1.0.0'), null);
});

test('weeklyDownloads — number on success, 0 on failure', async () => {
  assert.equal(await weeklyDownloads('x', { fetchImpl: resp({ downloads: 12345 }) }), 12345);
  assert.equal(await weeklyDownloads('x', { fetchImpl: resp({}, false, 404) }), 0);
});

test('fetchEntrySource — returns text, or "" when missing (never throws)', async () => {
  assert.equal(
    await fetchEntrySource('x', '1.0.0', { main: 'i.js' }, { fetchImpl: resp('module.exports={}', true, 200, 'text') }),
    'module.exports={}',
  );
  assert.equal(await fetchEntrySource('x', '1.0.0', {}, { fetchImpl: resp('', false, 404, 'text') }), '');
});

test('fetchEntrySource — refuses a path-traversal entry file (SSRF guard)', async () => {
  let called = false;
  const out = await fetchEntrySource(
    'x',
    '1.0.0',
    { main: '../../../../etc/passwd' },
    { fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => 'SECRET' }; } },
  );
  assert.equal(out, '');
  assert.equal(called, false, 'must not issue a fetch for a traversal path');
});

test('fetchEntrySource — encodes scoped name + version into the CDN url', async () => {
  let seen = '';
  await fetchEntrySource(
    '@scope/pkg',
    '1.2.3',
    { main: 'dist/i.js' },
    { fetchImpl: async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({}), text: async () => 'ok' }; } },
  );
  assert.match(seen, /cdn\.jsdelivr\.net\/npm\/@scope\/pkg@1\.2\.3\/dist\/i\.js/);
});
