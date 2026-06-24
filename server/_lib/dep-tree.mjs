/** Dependency-tree cascade signals.
 *
 *  computeMechanical records direct runtime dependency names. ENRICH resolves
 *  up to 50 of those names to concrete versions, checks the D1 verdict cache,
 *  and flags any dependency already known as non-verified. Cache misses are
 *  unknown, not flagged; swpm's full tree check remains the exhaustive path. */

import semver from 'semver';
import { fetchPackument } from './registry.mjs';

export async function resolveVersion(name, version, { fetchImpl = fetch } = {}) {
  if (version && semver.valid(version)) return version;

  const pack = await fetchPackument(name, { fetchImpl });
  const tags = pack?.['dist-tags'] ?? {};
  const versions = Object.keys(pack?.versions ?? {});

  if (!version) {
    const latest = tags.latest ?? semver.maxSatisfying(versions, '*', { includePrerelease: false });
    if (!latest) throw new Error(`no published versions for ${name}`);
    return latest;
  }
  if (tags[version]) return tags[version];

  const match = semver.maxSatisfying(versions, version, { includePrerelease: false });
  if (match) return match;
  throw new Error(`no version of ${name} satisfies "${version}"`);
}

export async function checkDependencies(deps, opts = {}) {
  const {
    resolveVersion: resolveImpl = resolveVersion,
    readVerdict,
    sw,
    fetchImpl = fetch,
  } = opts;
  const names = (Array.isArray(deps) ? deps : [])
    .filter((d) => typeof d === 'string' && d)
    .slice(0, 50);

  let checked = 0;
  const flagged = [];
  if (typeof readVerdict !== 'function') return { checked, flagged };

  for (const name of names) {
    let version;
    try {
      version = resolveImpl === resolveVersion
        ? await resolveImpl(name, undefined, { fetchImpl })
        : await resolveImpl(name, undefined, fetchImpl);
      checked++;
    } catch {
      continue;
    }

    let row;
    try {
      row = await readVerdict(sw, name, version);
    } catch {
      row = null;
    }
    if (row?.verdict && row.verdict !== 'verified') {
      flagged.push({ name, version, verdict: row.verdict });
    }
  }

  return { checked, flagged };
}
