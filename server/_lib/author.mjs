/** Author reputation — an ingredient for the narrative summary (tsk_f30faf55).
 *
 *  "47 downloads but authored by sindresorhus (150 packages, 2M combined)" vs
 *  "12 downloads, author's only package, account 3 days old" are opposite stories
 *  the raw signals can't tell on their own. We fetch the publisher's footprint:
 *  how many packages they maintain, their combined weekly downloads, and how far
 *  back they've been publishing. Two subrequests (npm search + bulk downloads),
 *  so this runs in the ENRICH/backfill path, not the synchronous verdict path.
 *  fetch is injected; the search parser is pure + tested. */

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS_BULK = 'https://api.npmjs.org/downloads/point/last-week';

// The bulk downloads endpoint rejects scoped names, so scoped packages are
// summed one request each. Cap the fan-out so a prolific @scope author can't
// trigger hundreds of point lookups in the enrich path.
const SCOPED_DOWNLOAD_LOOKUP_CAP = 64;

/** Pull names + oldest publish date + total count out of an npm v1 search body. */
export function parseSearch(json) {
  const objects = Array.isArray(json?.objects) ? json.objects : [];
  const names = [];
  let oldest = null;
  for (const o of objects) {
    const p = o?.package;
    if (!p || typeof p.name !== 'string') continue;
    names.push(p.name);
    if (typeof p.date === 'string' && (!oldest || p.date < oldest)) oldest = p.date;
  }
  const total = typeof json?.total === 'number' ? json.total : names.length;
  return { total, names, oldest };
}

/** Sum the `downloads` across a bulk last-week response (object keyed by name,
 *  or a single-package object). */
export function sumBulkDownloads(json) {
  if (!json || typeof json !== 'object') return 0;
  // single-package shape: { downloads, package: 'name', start, end }
  if (typeof json.package === 'string' && typeof json.downloads === 'number') return json.downloads;
  // multi shape: { 'name': { downloads, package }, ... } (null for unknown names)
  let sum = 0;
  for (const v of Object.values(json)) {
    if (v && typeof v === 'object' && typeof v.downloads === 'number') sum += v.downloads;
  }
  return sum;
}

/** Profile for a maintainer: package count, combined weekly downloads, and the
 *  oldest publish date we can see (a proxy for "publishing since"). Returns null
 *  on any failure — the narrative degrades gracefully without it. */
export async function authorProfile(maintainer, { fetchImpl = fetch } = {}) {
  if (!maintainer || typeof maintainer !== 'string') return null;

  let search;
  try {
    const res = await fetchImpl(
      `${REGISTRY}/-/v1/search?text=${encodeURIComponent('maintainer:' + maintainer)}&size=250`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    search = parseSearch(await res.json());
  } catch {
    return null;
  }

  // Bulk downloads accepts up to 128 names but ONLY unscoped ones.
  const unscoped = search.names.filter((n) => !n.startsWith('@')).slice(0, 128);
  let combined = 0;
  if (unscoped.length) {
    try {
      const res = await fetchImpl(`${DOWNLOADS_BULK}/${unscoped.join(',')}`, {
        headers: { accept: 'application/json' },
      });
      if (res.ok) combined += sumBulkDownloads(await res.json());
    } catch {
      // combined keeps the scoped total below; package_count alone still helps
    }
  }

  // Scoped packages must be queried individually (the single-package point
  // endpoint DOES accept scoped names). Without this, an author who ships only
  // @scope/* packages sums to zero downloads and reads as "low-activity" — the
  // exact false signal that dragged our own all-@somewhere-tech verdict.
  const scoped = search.names.filter((n) => n.startsWith('@')).slice(0, SCOPED_DOWNLOAD_LOOKUP_CAP);
  for (let i = 0; i < scoped.length; i += 8) {
    const chunk = scoped.slice(i, i + 8);
    const totals = await Promise.all(
      chunk.map(async (name) => {
        try {
          const res = await fetchImpl(`${DOWNLOADS_BULK}/${name}`, {
            headers: { accept: 'application/json' },
          });
          return res.ok ? sumBulkDownloads(await res.json()) : 0;
        } catch {
          return 0;
        }
      }),
    );
    combined += totals.reduce((sum, n) => sum + n, 0);
  }

  return {
    name: maintainer,
    package_count: search.total,
    combined_downloads: combined,
    oldest_package_date: search.oldest,
  };
}
