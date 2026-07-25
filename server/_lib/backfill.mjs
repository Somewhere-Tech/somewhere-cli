/** Mechanical backfill — reconcile STORED verdict rows with the CURRENT engine
 *  after a rules change (commit 51623b2: provenance short-circuits the tag
 *  heuristic; no_github_tag demoted to non-solo; deps scored at their declared
 *  range). A cache hit returns the stored mechanical verdict WITHOUT recomputing
 *  (resolve.mjs), so a rules change leaves the table full of verdicts derived
 *  under the old rules until each row is rewritten. This rewrites them.
 *
 *  Two things make this cheap and safe:
 *
 *  1. NO re-fetch of mechanical signals. Every input computeVerdict reads
 *     (has_provenance, is_minified, has_install_scripts, has_github_tag,
 *     weekly_downloads, description_match, typosquat) is a fixed FACT about
 *     package@version that the OLD code already stored correctly — only the
 *     VERDICT it derived was wrong. So we re-derive the verdict from the stored
 *     row with ZERO network. In particular NO GitHub calls (has_github_tag is
 *     reused), so the GitHub rate limit is never touched.
 *
 *  2. LLM-free. The narrative, author profile, CVE/advisory history and every
 *     other enrich field are PRESERVED verbatim (we spread the existing row and
 *     overwrite only verdict + signals + the dependency-cascade fields). No
 *     summarize() call, no PREWARM budget spent. (Stale narrative TEXT — "no
 *     release tag" prose on a row that is now verified — is a SEPARATE, opt-in
 *     LLM re-enrichment pass; this backfill does not touch summaries.)
 *
 *  The dependency cascade DOES need the parent packument (to resolve each dep to
 *  its DECLARED range, matching the deployed enrich path), so rows WITH
 *  dependencies cost one packument fetch plus the dep resolutions; leaf rows
 *  cost nothing.
 *
 *  Convergence: the worklist IS `verdict != 'verified'`, and clearing only ever
 *  REMOVES a row from it. Leaves clear on the first pass; their parents clear on
 *  the next (the cascade re-reads the now-corrected child rows); repeat until a
 *  full pass changes nothing. Idempotent (recompute is deterministic → a correct
 *  row rewrites to itself → 0 change) and resumable (cursor by package+version,
 *  which INSERT-OR-REPLACE never perturbs). */

import { computeVerdict, cascadeVerdict } from './engine.mjs';
import { checkDependencies, resolveVersion as resolveDependencyVersion } from './dep-tree.mjs';
import { readVerdict as dbReadVerdict, writeVerdict as dbWriteVerdict, rowToVerdict } from './db.mjs';
import { fetchPackument as registryFetchPackument } from './registry.mjs';

/** Re-derive the MECHANICAL verdict (pre-MAL, pre-freshness) from a stored row's
 *  signals — the exact inputs computeMechanical feeds computeVerdict, read back
 *  off the row instead of re-fetched. Pure; no network. */
export function mechanicalVerdictFromRow(row) {
  return computeVerdict({
    mal: [], // MAL is applied live at read-time (finalize), never stored
    has_provenance: row.has_provenance,
    is_minified: row.is_minified,
    has_install_scripts: row.has_install_scripts,
    description_match: row.description_match,
    diff_review: row.diff_review,
    typosquat: row.typosquat_of ? { of: row.typosquat_of, distance: row.typosquat_distance } : null,
    has_github_tag: row.has_github_tag,
    weekly_downloads: row.weekly_downloads,
  });
}

/** Recompute one row under the current engine and persist it iff the verdict,
 *  signals, or dependency-cascade fields actually changed. Returns what happened
 *  so the caller can tally. Everything is injectable for tests. */
export async function recomputeRow(row, opts = {}) {
  const {
    sw,
    fetchImpl = fetch,
    readVerdict = dbReadVerdict,
    writeVerdict = dbWriteVerdict,
    fetchPackument = registryFetchPackument,
    resolveVersion = resolveDependencyVersion,
    packumentCache,
    resolverCache,
  } = opts;

  const base = mechanicalVerdictFromRow(row);

  // Dependency cascade — only rows WITH declared dependencies touch the network.
  const deps = Array.isArray(row.dependencies) ? row.dependencies : [];
  let flagged = [];
  let verified = 0;
  let unknown = 0;
  if (deps.length) {
    // Declared ranges for THIS version, so we score the version actually
    // installed (change #3), not each dep's `latest`. One packument, memoised.
    let ranges = {};
    try {
      const pack = packumentCache && packumentCache.has(row.package)
        ? packumentCache.get(row.package)
        : await fetchPackument(row.package, { fetchImpl });
      if (packumentCache) packumentCache.set(row.package, pack);
      const declared = pack?.versions?.[row.version]?.dependencies;
      if (declared && typeof declared === 'object') ranges = declared;
    } catch {
      ranges = {}; // no packument → fall back to latest (dep-tree default)
    }

    // Memoise (dep@range → version) across the slice so a shared dependency is
    // resolved once. resolverCache is optional; without it the raw resolver runs.
    const resolveImpl = resolverCache
      ? async (name, range) => {
          const key = `${name}@${range ?? 'latest'}`;
          if (resolverCache.has(key)) return resolverCache.get(key);
          const v = await resolveVersion(name, range, { fetchImpl });
          resolverCache.set(key, v);
          return v;
        }
      : resolveVersion;

    const result = await checkDependencies(deps, {
      resolveVersion: resolveImpl,
      readVerdict,
      sw,
      fetchImpl,
      ranges,
    });
    flagged = result.flagged;
    verified = result.verified;
    unknown = result.unknown;
  } else {
    unknown = 0;
    verified = 0;
  }

  let verdict = base.verdict;
  let signals = [...base.verdict_signals];
  const cascaded = cascadeVerdict(verdict, flagged.map((d) => d.verdict));
  if (cascaded !== verdict) {
    verdict = cascaded;
    const signal = flagged.some((d) => d.verdict === 'blocked') ? 'dependency_blocked' : 'dependency_flagged';
    signals = [...new Set([...signals, signal])];
  }

  const next = {
    ...row,
    verdict,
    verdict_signals: signals,
    dependency_flags: flagged,
    dep_verified: deps.length ? verified : row.dep_verified,
    dep_unknown: deps.length ? unknown : row.dep_unknown,
  };

  const changed =
    row.verdict !== next.verdict ||
    JSON.stringify(row.verdict_signals ?? []) !== JSON.stringify(next.verdict_signals) ||
    JSON.stringify(row.dependency_flags ?? []) !== JSON.stringify(next.dependency_flags);

  if (changed) await writeVerdict(sw, next);
  return { package: row.package, version: row.version, from: row.verdict, to: verdict, changed };
}

/** SELECT + recompute one slice of the worklist (verdict != 'verified'), after a
 *  stable (package, version) cursor. Returns a tally plus the cursor to resume
 *  from and whether more rows remain in this pass. */
export async function backfillSlice(sw, opts = {}) {
  const {
    limit = 150,
    afterPackage = '',
    afterVersion = '',
    fetchImpl = fetch,
    readVerdict = dbReadVerdict,
    writeVerdict = dbWriteVerdict,
    fetchPackument = registryFetchPackument,
    concurrency = 5,
  } = opts;
  const cap = Math.min(500, Math.max(1, limit));
  const lanes = Math.min(16, Math.max(1, concurrency));

  const r = await sw.db.query(
    `SELECT * FROM verdicts
      WHERE verdict != 'verified'
        AND (package > ? OR (package = ? AND version > ?))
      ORDER BY package, version
      LIMIT ?`,
    [afterPackage, afterPackage, afterVersion, cap],
  );
  const rawRows = Array.isArray(r?.data) ? r.data : [];
  const rows = rawRows.map(rowToVerdict);

  // Per-slice memo: packuments and dep-version resolutions are shared across the
  // rows in this invocation but not persisted (a fresh worker resets them).
  const packumentCache = new Map();
  const resolverCache = new Map();

  const before = { verified: 0, suspicious: 0, unverified: 0, blocked: 0 };
  const after = { verified: 0, suspicious: 0, unverified: 0, blocked: 0 };
  let processed = 0;
  let changed = 0;
  let errors = 0;

  // Bounded concurrency (default 5) so a slice fits the function time budget and
  // stays polite to the registry. Concurrent recompute of a parent+child within
  // one chunk can read a stale child, but convergence (a later pass) fixes it —
  // correctness rests on repeat-to-stable, not on order.
  for (let i = 0; i < rows.length; i += lanes) {
    const chunk = rows.slice(i, i + lanes);
    await Promise.all(
      chunk.map(async (row) => {
        if (row.verdict in before) before[row.verdict]++;
        try {
          const res = await recomputeRow(row, {
            sw, fetchImpl, readVerdict, writeVerdict, fetchPackument, packumentCache, resolverCache,
          });
          processed++;
          if (res.changed) changed++;
          if (res.to in after) after[res.to]++;
        } catch {
          errors++;
          if (row.verdict in after) after[row.verdict]++; // unchanged on error
        }
      }),
    );
  }

  const last = rows[rows.length - 1];
  return {
    processed,
    changed,
    errors,
    before,
    after,
    hasMore: rows.length === cap,
    nextCursor: last ? { package: last.package, version: last.version } : { package: afterPackage, version: afterVersion },
  };
}
