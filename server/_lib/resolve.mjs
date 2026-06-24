/** The one place that turns (name, version) into a finished verdict: D1 cache
 *  hit, or compute-and-cache on miss, then the LIVE MAL check on top. Shared by
 *  the single + batch routes. sw + fetch are injected so it's testable. */

import { readVerdict, writeVerdict } from './db.mjs';
import { computeMechanical, finalize } from './compute.mjs';
import { queryMalAdvisories } from './osv.mjs';

export async function resolveVerdict(sw, name, version, opts = {}) {
  const githubToken = opts.githubToken ?? sw?.env?.GITHUB_TOKEN;

  let row = null;
  try {
    row = await readVerdict(sw, name, version);
  } catch {
    row = null; // a cache read failure must not block the live compute
  }
  if (!row) {
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
  }

  // MAL is live on every request and never cached. An OSV outage yields "no MAL
  // info" (mal = []), NOT a silent clean pass — the mechanical verdict stands.
  let mal = [];
  try {
    mal = await queryMalAdvisories(name, version, { fetchImpl: opts.fetchImpl });
  } catch {
    mal = [];
  }
  return finalize(row, mal);
}
