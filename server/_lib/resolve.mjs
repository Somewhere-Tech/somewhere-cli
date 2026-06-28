/** The one place that turns (name, version) into a finished verdict: D1 cache
 *  hit, or compute-and-cache on miss, then the LIVE MAL check on top. Shared by
 *  the single + batch routes. sw + fetch are injected so it's testable. */

import { readVerdict, writeVerdict } from './db.mjs';
import { computeMechanical, finalize, minimalRow } from './compute.mjs';
import { cachedMalAdvisories } from './mal-cache.mjs';

export async function resolveVerdict(sw, name, version, opts = {}) {
  const githubToken = opts.githubToken ?? sw?.env?.GITHUB_TOKEN;

  // MAL is the authoritative block signal and is INDEPENDENT of the registry
  // manifest — confirmed-malware versions are frequently unpublished from npm, so
  // we must be able to block a version we can no longer fetch. Read through a
  // short-TTL cache (60s) instead of hitting OSV on every request: fast on the hot
  // path, at most ~60s behind a brand-new advisory, and on an OSV outage it serves
  // last-known-recent advisories (keep blocking known-bad) rather than failing
  // open. An unrecoverable failure yields "no MAL info" (mal = []), never a silent
  // clean pass.
  let mal = [];
  try {
    mal = await cachedMalAdvisories(sw, name, version, { fetchImpl: opts.fetchImpl });
  } catch {
    mal = [];
  }

  let row = null;
  try {
    row = await readVerdict(sw, name, version);
  } catch {
    row = null; // a cache read failure must not block the live compute
  }
  if (!row) {
    try {
      row = await computeMechanical(name, version, {
        githubToken,
        fetchImpl: opts.fetchImpl,
        popular: opts.popular,
      });
      try {
        await writeVerdict(sw, row);
      } catch {
        // best-effort cache; returning the verdict matters more than persisting it
      }
    } catch (err) {
      // Mechanical inspection failed (manifest 404 / registry outage). If MAL
      // still flags this version, block from MAL alone (don't cache the
      // placeholder). If we know NOTHING — no manifest AND no MAL — rethrow so
      // the route 502s and the CLI fails OPEN to plain npx.
      if (mal.length === 0) throw err;
      row = minimalRow(name, version);
    }
  }

  return finalize(row, mal);
}
