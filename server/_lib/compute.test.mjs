import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMechanical, finalize } from './compute.mjs';
import { resolveVerdict } from './resolve.mjs';
import { verdictToParams } from './db.mjs';

const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const text = (body, status = 200) => ({ ok: status < 400, status, json: async () => ({}), text: async () => body });

/** Route a fake fetch to fixtures by host/path. */
function routeFetch(fx) {
  return async (url) => {
    const u = new URL(url);
    if (u.host.includes('api.npmjs.org')) return json(fx.downloads ?? { downloads: 0 });
    if (u.host.includes('cdn.jsdelivr.net')) return text(fx.source ?? '', fx.sourceStatus ?? 200);
    if (u.host.includes('api.github.com')) return json({}, fx.tagStatus ?? 404);
    if (u.host.includes('api.osv.dev')) return json(fx.osv ?? { vulns: [] });
    if (u.host.includes('registry.npmjs.org')) {
      const segs = u.pathname.split('/').filter(Boolean);
      const isManifest = segs.length >= 2 && /^\d/.test(decodeURIComponent(segs[segs.length - 1]));
      return json(isManifest ? (fx.manifest ?? {}) : (fx.packument ?? {}));
    }
    return json({}, 404);
  };
}

test('computeMechanical — clean package with provenance + github tag is verified', async () => {
  const fetchImpl = routeFetch({
    manifest: {
      name: 'left-pad',
      version: '1.3.0',
      description: 'pad a string',
      main: 'index.js',
      dist: { attestations: { url: 'https://x', provenance: { predicateType: 'slsa' } } },
      repository: { url: 'git+https://github.com/stevemao/left-pad.git' },
    },
    packument: { time: { '1.3.0': '2024-01-01T00:00:00Z' } },
    source: 'module.exports = function leftPad(s,n){ return s }',
    downloads: { downloads: 2_000_000 },
    tagStatus: 200,
  });
  const row = await computeMechanical('left-pad', '1.3.0', { fetchImpl, now: 'NOW' });
  assert.equal(row.verdict, 'verified');
  assert.equal(row.has_provenance, true);
  assert.equal(row.has_github_tag, 1);
  assert.equal(row.is_minified, false);
  assert.deepEqual(row.capabilities, []);
  assert.equal(row.publish_time, '2024-01-01T00:00:00Z');
  assert.equal(row.weekly_downloads, 2_000_000);
});

test('computeMechanical — no provenance + minified + install script → unverified', async () => {
  const minified = 'a'.repeat(60000) + ';return 1'; // single huge line
  const fetchImpl = routeFetch({
    manifest: {
      name: 'sketchy',
      version: '2.1.0',
      description: 'date formatter',
      main: 'index.js',
      scripts: { postinstall: 'node steal.js' },
      // no dist.attestations → no provenance; no repository → tag null
    },
    packument: {},
    source: minified,
    downloads: { downloads: 5000 },
  });
  const row = await computeMechanical('sketchy', '2.1.0', { fetchImpl, now: 'NOW' });
  assert.equal(row.verdict, 'unverified');
  assert.equal(row.has_provenance, false);
  assert.equal(row.is_minified, true);
  assert.deepEqual(row.install_script_types, ['postinstall']);
  assert.ok(row.verdict_signals.includes('no_provenance'));
  assert.ok(row.verdict_signals.includes('install_scripts'));
});

test('computeMechanical — missing entry source does not flag minified', async () => {
  const fetchImpl = routeFetch({
    manifest: { name: 'x', version: '1.0.0', main: 'index.js' },
    packument: {},
    source: '',
    sourceStatus: 404,
    downloads: { downloads: 10 },
  });
  const row = await computeMechanical('x', '1.0.0', { fetchImpl, now: 'NOW' });
  assert.equal(row.is_minified, false);
});

test('finalize — confirmed MAL escalates a verified row to blocked', () => {
  const row = { package: 'p', version: '1', verdict: 'verified', verdict_signals: [] };
  const out = finalize(row, [{ id: 'MAL-1', sources: ['OpenSSF', 'OSV'] }]);
  assert.equal(out.verdict, 'blocked');
  assert.deepEqual(out.verdict_signals, ['MAL-1']);
  assert.equal(out.mal.length, 1);
});

test('finalize — no MAL keeps the mechanical verdict', () => {
  const row = { package: 'p', version: '1', verdict: 'unverified', verdict_signals: ['no_provenance', 'install_scripts'] };
  const out = finalize(row, []);
  assert.equal(out.verdict, 'unverified');
  assert.deepEqual(out.mal, []);
});

test('finalize — strips the internal `sources` field from advisories on the wire', () => {
  const out = finalize(
    { package: 'p', version: '1', verdict: 'verified', verdict_signals: [] },
    [{ id: 'MAL-1', summary: 'x', source: 'OpenSSF / OSV', sources: ['OpenSSF', 'OSV'], safe_versions: [] }],
  );
  assert.equal(out.verdict, 'blocked');
  assert.equal(out.mal[0].source, 'OpenSSF / OSV'); // public string kept
  assert.equal('sources' in out.mal[0], false); // internal array stripped
});

test('computeMechanical — throws when the version manifest is unavailable (fail-open, never a clean pass)', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.host.includes('registry.npmjs.org')) {
      const segs = u.pathname.split('/').filter(Boolean);
      const isManifest = segs.length >= 2 && /^\d/.test(decodeURIComponent(segs[segs.length - 1]));
      if (isManifest) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      return json({});
    }
    if (u.host.includes('api.npmjs.org')) return json({ downloads: 0 });
    return json({}, 404);
  };
  await assert.rejects(() => computeMechanical('ghost', '9.9.9', { fetchImpl, now: 'NOW' }), /could not fetch manifest/);
});

// ---- resolveVerdict (cache miss + hit) ----

function fakeSw(storedRow) {
  const writes = [];
  return {
    env: {},
    writes,
    db: {
      query: async (sql, params) => {
        // The MAL cache (mal_advisories) is a separate layer — empty here so these
        // tests still exercise the live OSV path, and its writes stay out of the
        // verdict-table `writes` counter the assertions below depend on.
        if (sql.includes('mal_advisories')) return { data: [] };
        if (sql.startsWith('SELECT')) return { data: storedRow ? [storedRow] : [] };
        if (sql.startsWith('INSERT')) {
          writes.push(params);
          return { changes: 1 };
        }
        return { data: [] };
      },
    },
  };
}

test('resolveVerdict — cache miss computes, writes, and returns', async () => {
  const sw = fakeSw(null);
  const fetchImpl = routeFetch({
    manifest: { name: 'fresh', version: '1.0.0', main: 'index.js', dist: { attestations: { url: 'x' } }, repository: { url: 'https://github.com/a/b' } },
    packument: { time: { '1.0.0': '2024-01-01T00:00:00Z' } },
    source: 'export const x = 1',
    downloads: { downloads: 1000 },
    tagStatus: 200,
  });
  const out = await resolveVerdict(sw, 'fresh', '1.0.0', { fetchImpl });
  assert.equal(out.verdict, 'verified');
  assert.equal(sw.writes.length, 1, 'should cache the computed row');
});

test('resolveVerdict — cache hit skips compute, still does live MAL', async () => {
  // A stored mechanical row that says verified...
  const storedParams = verdictToParams({
    package: 'cached',
    version: '1.0.0',
    verdict: 'verified',
    verdict_signals: [],
    capabilities: [],
    has_provenance: true,
    is_minified: false,
    has_install_scripts: false,
    install_script_types: [],
    has_github_tag: 1,
    weekly_downloads: 1000,
    computed_at: 'OLD',
  });
  const COLUMNS = [
    'package', 'version', 'computed_at', 'has_provenance', 'provenance_commit', 'provenance_repo',
    'has_install_scripts', 'install_script_types', 'is_minified', 'capabilities', 'typosquat_of',
    'typosquat_distance', 'has_github_tag', 'github_repo', 'publish_time', 'publisher', 'description',
    'description_match', 'description_match_reason', 'diff_review', 'diff_review_reason',
    'diff_from_version', 'weekly_downloads', 'verdict', 'verdict_signals',
  ];
  const storedRow = Object.fromEntries(COLUMNS.map((c, i) => [c, storedParams[i]]));
  const sw = fakeSw(storedRow);
  // ...but a live MAL advisory now exists → must escalate to blocked.
  const fetchImpl = routeFetch({ osv: { vulns: [{ id: 'MAL-NEW', references: [{ url: 'https://github.com/ossf/x' }] }] } });
  const out = await resolveVerdict(sw, 'cached', '1.0.0', { fetchImpl });
  assert.equal(out.verdict, 'blocked');
  assert.equal(sw.writes.length, 0, 'cache hit should not recompute/rewrite');
});

test('resolveVerdict — an UNPUBLISHED version still BLOCKS from a live MAL advisory', async () => {
  // Malware versions are frequently pulled from npm: manifest 404s, but OSV
  // still has the advisory. We must block from MAL alone, not fall open.
  const sw = fakeSw(null);
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.host.includes('api.osv.dev')) {
      return json({ vulns: [{ id: 'MAL-2025-47141', references: [{ url: 'https://github.com/ossf/x' }] }] });
    }
    if (u.host.includes('registry.npmjs.org')) {
      const segs = u.pathname.split('/').filter(Boolean);
      const isManifest = segs.length >= 2 && /^\d/.test(decodeURIComponent(segs[segs.length - 1]));
      if (isManifest) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      return json({});
    }
    if (u.host.includes('api.npmjs.org')) return json({ downloads: 0 });
    return json({}, 404);
  };
  const out = await resolveVerdict(sw, '@ctrl/tinycolor', '4.1.1', { fetchImpl });
  assert.equal(out.verdict, 'blocked');
  assert.deepEqual(out.verdict_signals, ['MAL-2025-47141']);
  assert.equal(sw.writes.length, 0, 'the placeholder row must not be cached');
});

test('resolveVerdict — uninspectable AND no MAL throws (route 502 → CLI fails open)', async () => {
  const sw = fakeSw(null);
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.host.includes('api.osv.dev')) return json({ vulns: [] });
    if (u.host.includes('registry.npmjs.org')) {
      const segs = u.pathname.split('/').filter(Boolean);
      const isManifest = segs.length >= 2 && /^\d/.test(decodeURIComponent(segs[segs.length - 1]));
      if (isManifest) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      return json({});
    }
    if (u.host.includes('api.npmjs.org')) return json({ downloads: 0 });
    return json({}, 404);
  };
  await assert.rejects(() => resolveVerdict(sw, 'ghost', '9.9.9', { fetchImpl }));
});

test('finalize — a freshly published version is penalized to caution (read-time)', () => {
  const fresh = new Date(Date.now() - 3 * 3600 * 1000).toISOString(); // 3h ago
  const out = finalize({ package: 'p', version: '1', verdict: 'verified', verdict_signals: [], publish_time: fresh }, []);
  assert.equal(out.verdict, 'unverified');
  assert.ok(out.verdict_signals.includes('freshly_published'));
});

test('finalize — an old version is not penalized', () => {
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const out = finalize({ package: 'p', version: '1', verdict: 'verified', verdict_signals: [], publish_time: old }, []);
  assert.equal(out.verdict, 'verified');
});

test('finalize — freshness never downgrades a confirmed block', () => {
  const fresh = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
  const out = finalize({ package: 'p', version: '1', verdict: 'verified', publish_time: fresh }, [{ id: 'MAL-1', sources: ['OSV', 'GitHub'] }]);
  assert.equal(out.verdict, 'blocked');
});
