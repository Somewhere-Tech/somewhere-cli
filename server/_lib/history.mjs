/** Advisory history for a package across ALL versions.
 *
 *  The exact-version MAL check in osv.mjs stays live and authoritative. This
 *  module is the slower ENRICH signal: query OSV without a version so the
 *  narrative can say "this package was compromised before, current version is
 *  clean" and count non-malware CVE/GHSA history. Fetch is injected for offline
 *  fixture tests. */

const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';

function advisoryKind(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('MAL-')) return 'MAL';
  if (id.startsWith('CVE-') || id.startsWith('GHSA-')) return 'CVE';
  return null;
}

function summaryOf(vuln) {
  return (
    vuln?.summary ||
    (typeof vuln?.details === 'string' ? vuln.details.split('\n')[0].slice(0, 140) : undefined) ||
    'advisory'
  );
}

/** Normalize OSV vulns into [{ id, summary, published, kind }], newest first. */
export function parseAdvisoryHistory(json) {
  const vulns = Array.isArray(json?.vulns) ? json.vulns : [];
  return vulns
    .map((v) => {
      const id = typeof v?.id === 'string' ? v.id : null;
      const kind = advisoryKind(id);
      if (!id || !kind) return null;
      const published = v?.published || v?.modified || '';
      return {
        id,
        summary: summaryOf(v),
        published: published ? String(published).slice(0, 10) : '',
        kind,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.published).localeCompare(String(a.published)));
}

export async function queryAdvisoryHistory(name, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(OSV_QUERY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: { ecosystem: 'npm', name } }),
    });
    if (!res.ok) return [];
    return parseAdvisoryHistory(await res.json());
  } catch {
    return [];
  }
}
