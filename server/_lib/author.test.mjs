import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch, sumBulkDownloads, authorProfile } from './author.mjs';

test('parseSearch — names, total, oldest date', () => {
  const r = parseSearch({
    total: 150,
    objects: [
      { package: { name: 'p1', date: '2015-01-01T00:00:00Z' } },
      { package: { name: '@scope/p2', date: '2020-01-01T00:00:00Z' } },
      { package: { name: 'p3', date: '2012-06-01T00:00:00Z' } },
      { nope: true },
    ],
  });
  assert.equal(r.total, 150);
  assert.deepEqual(r.names, ['p1', '@scope/p2', 'p3']);
  assert.equal(r.oldest, '2012-06-01T00:00:00Z');
});

test('parseSearch — junk yields empties', () => {
  assert.deepEqual(parseSearch(null), { total: 0, names: [], oldest: null });
  assert.deepEqual(parseSearch({ objects: [] }), { total: 0, names: [], oldest: null });
});

test('sumBulkDownloads — multi-package object', () => {
  assert.equal(
    sumBulkDownloads({ p1: { downloads: 1_000_000, package: 'p1' }, p2: { downloads: 500_000, package: 'p2' }, p3: null }),
    1_500_000,
  );
});

test('sumBulkDownloads — single-package shape', () => {
  assert.equal(sumBulkDownloads({ downloads: 42, package: 'foo', start: 'a', end: 'b' }), 42);
});

test('sumBulkDownloads — junk → 0', () => {
  assert.equal(sumBulkDownloads(null), 0);
  assert.equal(sumBulkDownloads({}), 0);
});

const resp = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

function routeFetch(searchBody, bulkBody) {
  return async (url) => {
    if (url.includes('/-/v1/search')) return (resp(searchBody))();
    if (url.includes('/downloads/point/')) return (resp(bulkBody))();
    return (resp({}, false))();
  };
}

test('authorProfile — aggregates package count + combined downloads + oldest date', async () => {
  const fetchImpl = routeFetch(
    {
      total: 150,
      objects: [
        { package: { name: 'chalk', date: '2013-01-01T00:00:00Z' } },
        { package: { name: 'ora', date: '2016-01-01T00:00:00Z' } },
        { package: { name: '@sindresorhus/is', date: '2018-01-01T00:00:00Z' } },
      ],
    },
    { chalk: { downloads: 400_000_000 }, ora: { downloads: 30_000_000 } },
  );
  const p = await authorProfile('sindresorhus', { fetchImpl });
  assert.equal(p.name, 'sindresorhus');
  assert.equal(p.package_count, 150);
  assert.equal(p.combined_downloads, 430_000_000);
  assert.equal(p.oldest_package_date, '2013-01-01T00:00:00Z');
});

test('authorProfile — null maintainer / search failure → null', async () => {
  assert.equal(await authorProfile('', {}), null);
  assert.equal(await authorProfile('x', { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), null);
});

test('authorProfile — excludes scoped names from the bulk-downloads request', async () => {
  let bulkUrl = '';
  const fetchImpl = async (url) => {
    if (url.includes('/-/v1/search')) {
      return { ok: true, status: 200, json: async () => ({ total: 2, objects: [{ package: { name: '@scope/a', date: '2020-01-01' } }, { package: { name: 'b', date: '2019-01-01' } }] }) };
    }
    bulkUrl = url;
    return { ok: true, status: 200, json: async () => ({ b: { downloads: 5 } }) };
  };
  const p = await authorProfile('someone', { fetchImpl });
  assert.ok(!bulkUrl.includes('@scope'), 'scoped names must not go into the bulk request');
  assert.equal(p.combined_downloads, 5);
});
