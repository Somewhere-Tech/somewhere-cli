import test from 'node:test';
import assert from 'node:assert/strict';
import { prewarmSlice, normalizeNames } from './prewarm.mjs';

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

function fakeSw(freshNames = new Set(), now = Date.now()) {
  const writes = [];
  return {
    writes,
    env: {},
    db: {
      query: async (sql, params) => {
        if (sql.startsWith('SELECT')) {
          const name = params[0];
          if (freshNames.has(name)) {
            return { data: [{ package: name, version: '1.0.0', verdict: 'verified', computed_at: new Date(now).toISOString() }] };
          }
          return { data: [] };
        }
        if (sql.startsWith('INSERT')) {
          writes.push(params[0]); // package name
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
