import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdvisoryHistory, queryAdvisoryHistory } from './history.mjs';

const resp = (body, ok = true, status = 200) => async (_url, init) => ({
  ok,
  status,
  init,
  json: async () => body,
});

test('parseAdvisoryHistory — MAL + CVE/GHSA, date normalized, newest first', () => {
  const out = parseAdvisoryHistory({
    vulns: [
      { id: 'CVE-2024-1', summary: 'old cve', published: '2024-01-02T00:00:00Z' },
      { id: 'MAL-2025-99', details: 'credential theft\nmore', published: '2025-09-15T00:00:00Z' },
      { id: 'GHSA-abcd', summary: 'github advisory', modified: '2025-01-01T00:00:00Z' },
      { id: 'PYSEC-1', summary: 'ignored' },
      { nope: true },
    ],
  });
  assert.deepEqual(out, [
    { id: 'MAL-2025-99', summary: 'credential theft', published: '2025-09-15', kind: 'MAL' },
    { id: 'GHSA-abcd', summary: 'github advisory', published: '2025-01-01', kind: 'CVE' },
    { id: 'CVE-2024-1', summary: 'old cve', published: '2024-01-02', kind: 'CVE' },
  ]);
});

test('parseAdvisoryHistory — junk yields empty', () => {
  assert.deepEqual(parseAdvisoryHistory(null), []);
  assert.deepEqual(parseAdvisoryHistory({ vulns: 'nope' }), []);
});

test('queryAdvisoryHistory — POSTs package-only OSV query', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return (await resp({ vulns: [{ id: 'MAL-1', published: '2025-01-01' }] })()) ;
  };
  const out = await queryAdvisoryHistory('pkg', { fetchImpl });
  assert.equal(seen.url, 'https://api.osv.dev/v1/query');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { package: { ecosystem: 'npm', name: 'pkg' } });
  assert.equal('version' in JSON.parse(seen.init.body), false);
  assert.equal(out[0].id, 'MAL-1');
});

test('queryAdvisoryHistory — transport failure degrades to empty', async () => {
  assert.deepEqual(await queryAdvisoryHistory('pkg', { fetchImpl: async () => { throw new Error('offline'); } }), []);
  assert.deepEqual(await queryAdvisoryHistory('pkg', { fetchImpl: resp({}, false, 500) }), []);
});
