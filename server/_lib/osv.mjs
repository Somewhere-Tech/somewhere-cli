/** Live MAL-advisory lookup against OSV (api.osv.dev).
 *
 *  MAL advisories are NEVER cached (a version can be retroactively flagged), so
 *  this runs on every verdict request. We query OSV for the exact name@version,
 *  keep only IDs starting with "MAL-" (the OpenSSF malicious-packages feed,
 *  mirrored into OSV), and normalise each into the shape the CLI renders.
 *
 *  fetch is injected so the parser (parseMalAdvisory) and the flow are testable
 *  offline. Source attribution is best-effort from the advisory's references —
 *  it feeds the engine's "Amazon-Inspector-only → warn, not block" rule, so when
 *  in doubt we under-attribute (fewer false "confirmed" blocks). */

const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';

function hostSource(url) {
  const u = String(url).toLowerCase();
  if (u.includes('ossf') || u.includes('openssf') || u.includes('malicious-packages')) return 'OpenSSF';
  if (u.includes('github.com/advisories') || u.includes('githubusercontent')) return 'GitHub';
  if (u.includes('amazon') || u.includes('aws') || u.includes('inspector')) return 'Amazon Inspector';
  if (u.includes('snyk')) return 'Snyk';
  if (u.includes('osv.dev')) return 'OSV';
  return null;
}

/** Best-effort safe versions: the `fixed` boundary of each affected range. */
function safeVersions(vuln) {
  const out = [];
  for (const aff of vuln?.affected ?? []) {
    for (const range of aff?.ranges ?? []) {
      for (const ev of range?.events ?? []) {
        if (ev?.fixed) out.push(ev.fixed);
      }
    }
  }
  return [...new Set(out)];
}

/** Normalise one OSV vuln object into a CLI-facing MAL advisory. */
export function parseMalAdvisory(vuln) {
  const refs = Array.isArray(vuln?.references) ? vuln.references : [];
  const sources = [...new Set(refs.map((r) => hostSource(r?.url)).filter(Boolean))];
  if (sources.length === 0) sources.push('OSV'); // it came from OSV at minimum
  const published = vuln?.published || vuln?.modified || null;
  const summary =
    vuln?.summary ||
    (typeof vuln?.details === 'string' ? vuln.details.split('\n')[0].slice(0, 140) : undefined) ||
    'flagged as malicious';
  return {
    id: vuln?.id,
    summary,
    disclosed: published ? String(published).slice(0, 10) : undefined,
    source: sources.join(' / '),
    sources, // engine reads this array for the confirmation rule
    safe_versions: safeVersions(vuln),
  };
}

/** All MAL advisories affecting name@version (empty array if none). Throws on a
 *  transport/HTTP failure so the caller can decide (the verdict route treats an
 *  OSV outage as "no MAL info available", never as a silent clean pass). */
export async function queryMalAdvisories(name, version, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(OSV_QUERY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version, package: { ecosystem: 'npm', name } }),
  });
  if (!res.ok) throw new Error(`OSV query returned ${res.status}`);
  const data = await res.json();
  const vulns = Array.isArray(data?.vulns) ? data.vulns : [];
  return vulns
    .filter((v) => typeof v?.id === 'string' && v.id.startsWith('MAL-'))
    .map(parseMalAdvisory);
}
