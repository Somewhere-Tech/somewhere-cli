/** npm registry + CDN access for the verdict backend.
 *
 *  We do NOT download tarballs — that's npm's CDN job and the whole point of the
 *  notary architecture. For the readability/capability checks we fetch only the
 *  package's ENTRY file from a per-file CDN (jsDelivr), which serves individual
 *  files out of the published package. Metadata (scripts, dist.attestations,
 *  repository, publish time) comes from the registry manifest; popularity from
 *  the downloads API. All fetches injected for offline tests of the parsers. */

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';
const CDN = 'https://cdn.jsdelivr.net/npm';

function encodeName(name) {
  return name.startsWith('@') ? name.replace('/', '%2f') : name;
}

/** Full version manifest: { name, version, dist, scripts, repository, description, ... }. */
export async function fetchManifest(name, version, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${REGISTRY}/${encodeName(name)}/${encodeURIComponent(version)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`registry manifest ${res.status} for ${name}@${version}`);
  return res.json();
}

/** Abbreviated packument (dist-tags + versions + time). */
export async function fetchPackument(name, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${REGISTRY}/${encodeName(name)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`registry packument ${res.status} for ${name}`);
  return res.json();
}

/** The relative path of the entry file we analyse for capabilities/readability. */
export function entryFile(manifest) {
  const main = manifest?.main;
  if (typeof main === 'string' && main.trim()) return main.replace(/^\.?\//, '');
  return 'index.js';
}

/** Fetch ONLY the package's entry file from the per-file CDN (not the tarball).
 *  Returns '' if the file can't be fetched — analysis degrades, never throws. */
export async function fetchEntrySource(name, version, manifest, { fetchImpl = fetch } = {}) {
  const file = entryFile(manifest);
  try {
    const res = await fetchImpl(`${CDN}/${name}@${version}/${file}`, { headers: { accept: 'text/plain' } });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/** Weekly download count for popularity-gated checks (typosquat, no-tag). 0 on failure. */
export async function weeklyDownloads(name, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${DOWNLOADS}/${encodeName(name)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return 0;
    const data = await res.json();
    return typeof data?.downloads === 'number' ? data.downloads : 0;
  } catch {
    return 0;
  }
}

/** Publish time (ISO) for a version, from the packument's `time` map. */
export function publishTime(packument, version) {
  const t = packument?.time;
  return t && typeof t[version] === 'string' ? t[version] : null;
}
