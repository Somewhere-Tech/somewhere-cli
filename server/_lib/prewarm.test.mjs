import test from 'node:test';
import assert from 'node:assert/strict';
import { prewarmSlice, coverDependencies, normalizeNames } from './prewarm.mjs';
import { rowToVerdict } from './db.mjs';

test('normalizeNames — strings, {name} objects, {rows}, garbage', () => {
  assert.deepEqual(normalizeNames(['a', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeNames([{ name: 'a', downloads: 5 }, { name: 'b' }]), ['a', 'b']);
  assert.deepEqual(normalizeNames({ rows: [{ name: 'x' }] }), ['x']);
  assert.deepEqual(normalizeNames(null), []);
  assert.deepEqual(normalizeNames([1, {}, { nope: 1 }]), []);
});

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const text = (body, status = 200) => ({ ok: status < 400, status, json: async () => ({}), text: async () => body });

function routeFetch() {
  return async (url) => {
    const u = new URL(url);
    if (u.host.includes('api.npmjs.org')) return json({ downloads: 1000 });
    if (u.host.includes('cdn.jsdelivr.net')) return text('export const x = 1');
    if (u.host.includes('api.github.com')) return json({}, 200);
    if (u.host.includes('api.osv.dev')) return json({ vulns: [] });
    if (u.host.includes('registry.npmjs.org')) {
      const segs = u.pathname.split('/').filter(Boolean);
      const isManifest = segs.length >= 2 && /^\d/.test(decodeURIComponent(segs[segs.length - 1]));
      if (isManifest) {
        return json({ name: segs[0], version: '1.0.0', main: 'index.js', dist: { attestations: { url: 'x' } }, repository: { url: 'https://github.com/a/b' } });
      }
      return json({ 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2024-01-01T00:00:00Z' } });
    }
    return json({}, 404);
  };
}

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

function fakeSw(freshNames = new Set(), now = Date.now(), storedRows = new Map()) {
  const writes = [];
  const writeParams = [];
  return {
    writes,
    writeParams,
    env: {},
    ai: {
      chat: async () => ({ parsed: { summary: 'Dependency bad-dep is blocked.', match: true } }),
    },
    db: {
      query: async (sql, params) => {
        if (sql.startsWith('SELECT')) {
          const [name, version] = params;
          const stored = storedRows.get(`${name}@${version}`);
          if (stored) return { data: [stored] };
          if (freshNames.has(name)) {
            return { data: [{ package: name, version: '1.0.0', verdict: 'verified', computed_at: new Date(now).toISOString() }] };
          }
          return { data: [] };
        }
        if (sql.startsWith('INSERT')) {
          writes.push(params[0]); // package name
          writeParams.push(params);
          return { changes: 1 };
        }
        return { data: [] };
      },
    },
  };
}

test('prewarmSlice — computes + caches each package on a cold cache', async () => {
  const sw = fakeSw();
  const out = await prewarmSlice(sw, { names: ['alpha', 'beta'], fetchImpl: routeFetch(), now: Date.now() });
  assert.equal(out.processed, 2);
  assert.equal(out.written, 2);
  assert.equal(out.skipped, 0);
  assert.deepEqual(sw.writes.sort(), ['alpha', 'beta']);
});

test('prewarmSlice — skips a fresh cached row', async () => {
  const sw = fakeSw(new Set(['alpha']));
  const out = await prewarmSlice(sw, { names: ['alpha', 'beta'], fetchImpl: routeFetch(), now: Date.now() });
  assert.equal(out.skipped, 1);
  assert.equal(out.written, 1);
  assert.deepEqual(sw.writes, ['beta']);
});

test('prewarmSlice — respects offset/limit and reports nextOffset/remaining', async () => {
  const sw = fakeSw();
  const out = await prewarmSlice(sw, {
    names: ['a', 'b', 'c', 'd', 'e'],
    offset: 2,
    limit: 2,
    fetchImpl: routeFetch(),
    now: Date.now(),
  });
  assert.equal(out.processed, 2);
  assert.equal(out.nextOffset, 4);
  assert.equal(out.remaining, 1);
  assert.deepEqual(sw.writes.sort(), ['c', 'd']);
});

test('prewarmSlice enrich — advisory history + dependency cascade are cached before summary', async () => {
  const depRow = {
    package: 'bad-dep',
    version: '2.0.0',
    verdict: 'blocked',
    verdict_signals: '[]',
    capabilities: '[]',
    install_script_types: '[]',
    dependencies: '[]',
    compromised_history: '[]',
    dependency_flags: '[]',
    computed_at: 'OLD',
  };
  const sw = fakeSw(new Set(), Date.now(), new Map([['bad-dep@2.0.0', depRow]]));
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.host.includes('api.npmjs.org')) return json({ downloads: 1000 });
    if (u.host.includes('cdn.jsdelivr.net')) return text('export const x = 1');
    if (u.host.includes('api.github.com')) return json({}, 200);
    if (u.host.includes('api.osv.dev')) {
      return json({
        vulns: [
          { id: 'MAL-2025-99', summary: 'past compromise', published: '2025-09-15T00:00:00Z' },
          { id: 'CVE-2024-1', summary: 'old cve', published: '2024-01-01T00:00:00Z' },
        ],
      });
    }
    if (u.host.includes('registry.npmjs.org')) {
      const segs = u.pathname.split('/').filter(Boolean);
      const name = decodeURIComponent(segs[0]);
      const isManifest = segs.length >= 2 && /^\d/.test(decodeURIComponent(segs[segs.length - 1]));
      if (name === 'bad-dep') return json({ 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': {} } });
      if (isManifest) {
        return json({
          name: 'alpha',
          version: '1.0.0',
          main: 'index.js',
          dist: { attestations: { url: 'x' } },
          repository: { url: 'https://github.com/a/b' },
          dependencies: { 'bad-dep': '^2.0.0' },
        });
      }
      return json({ 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2024-01-01T00:00:00Z' } });
    }
    return json({}, 404);
  };

  const out = await prewarmSlice(sw, { names: ['alpha'], fetchImpl, enrich: true, now: Date.now() });
  assert.equal(out.written, 1);
  const row = rowToVerdict(zipRow(sw.writeParams[0]));
  assert.equal(row.verdict, 'blocked');
  assert.ok(row.verdict_signals.includes('dependency_blocked'));
  assert.equal(row.known_cves, 1);
  assert.deepEqual(row.compromised_history, [{ id: 'MAL-2025-99', published: '2025-09-15' }]);
  assert.deepEqual(row.dependency_flags, [{ name: 'bad-dep', version: '2.0.0', verdict: 'blocked' }]);
  assert.equal(row.summary, 'Dependency bad-dep is blocked.');
});

// --- coverDependencies (close the dependency closure) ---
function depSw(uncovered) {
  const writes = [];
  return {
    writes,
    env: {},
    db: {
      query: async (sql, params) => {
        if (/SELECT DISTINCT je\.value/.test(sql)) return { data: uncovered.map((d) => ({ dep: d })) };
        if (/COUNT\(DISTINCT je\.value\)/.test(sql)) return { data: [{ c: Math.max(0, uncovered.length - writes.length) }] };
        if (sql.startsWith('INSERT')) { writes.push(params[0]); return { changes: 1 }; }
        return { data: [] }; // any other best-effort query
      },
    },
  };
}

test('coverDependencies — computes uncovered deps and reports remaining', async () => {
  const sw = depSw(['uncov-a', 'uncov-b']);
  const out = await coverDependencies(sw, { fetchImpl: routeFetch(), now: Date.now() });
  assert.equal(out.processed, 2);
  assert.equal(out.written, 2);
  assert.equal(out.errors, 0);
  assert.deepEqual(sw.writes.sort(), ['uncov-a', 'uncov-b']);
  assert.equal(out.remaining_uncovered, 0);
});

test('coverDependencies — nothing uncovered is a clean no-op', async () => {
  const sw = depSw([]);
  const out = await coverDependencies(sw, { fetchImpl: routeFetch(), now: Date.now() });
  assert.equal(out.processed, 0);
  assert.equal(out.written, 0);
  assert.equal(out.remaining_uncovered, 0);
});
