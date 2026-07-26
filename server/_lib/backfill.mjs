/** Mechanical backfill — reconcile STORED verdict rows with the CURRENT engine
 *  after a rules/signal change. A cache hit returns the stored verdict WITHOUT
 *  recomputing (resolve.mjs), so a rules change leaves the table computed under
 *  the OLD rules until each row is rewritten. This rewrites them — and does it
 *  with ZERO network calls.
 *
 *  Why zero-fetch is both correct and necessary:
 *
 *  1. MECHANICAL verdict from stored signals. Every input computeVerdict reads
 *     (has_provenance, has_github_tag, is_minified, weekly_downloads,
 *     description_match, typosquat) is a fixed FACT the old code already stored
 *     correctly. The install-script signal is the one exception: the fix that
 *     motivated this pass DROPPED `prepare` from the install-time set (it does
 *     not run for registry consumers), so we RE-DERIVE has_install_scripts from
 *     the stored `install_script_types` list, filtered through the corrected
 *     INSTALL_LIFECYCLE — no manifest re-fetch needed, because the raw script
 *     NAMES were already stored.
 *
 *  2. CASCADE by re-reading the stored flags' children. The rule/signal fixes
 *     are all monotone-lenient — they only ever CLEAR a verdict, never add one —
 *     so a dependency that was `verified` cannot newly-flag. The complete set of
 *     children that could still flag a parent is therefore a SUBSET of that
 *     parent's already-stored `dependency_flags`. We re-read each of those
 *     children's CURRENT verdict; any now-`verified` (or vanished → unknown)
 *     drops off. No dep re-resolution, no packument download.
 *
 *  Convergence: the worklist IS `verdict != 'verified'` and clearing only
 *  REMOVES rows from it. A leaf clears the moment its signals re-derive clean; a
 *  parent clears on the pass after its last flagged child does. Repeat full
 *  passes until one changes nothing. Idempotent (a correct row re-derives to
 *  itself → 0 change) and resumable (cursor by package+version).
 *
 *  LIMITATION (documented on purpose): this pass does NOT re-run change #3
 *  (resolve each dependency to its DECLARED range rather than the version stored
 *  in the old flags) — that would require a manifest fetch per row and is what
 *  made the first cut take ~90s/slice. For the fixes this pass targets it is
 *  moot (the divergent children clear anyway), and any residual version-
 *  resolution drift is reconciled by the weekly prewarm (freshDays=7), which
 *  does a full re-enrich. */

import { computeVerdict, cascadeVerdict } from './engine.mjs';
import { INSTALL_LIFECYCLE } from './checks/manifest.mjs';
import { checkDependencies, resolveVersion as resolveDependencyVersion } from './dep-tree.mjs';
import { fetchManifest as registryFetchManifest } from './registry.mjs';
import { readVerdict as dbReadVerdict, writeVerdict as dbWriteVerdict, rowToVerdict } from './db.mjs';

/** Re-derive install-script signals from the stored `install_script_types`
 *  under the CURRENT INSTALL_LIFECYCLE (which no longer counts `prepare`). Falls
 *  back to the stored boolean for very old rows that never stored the list. */
export function correctedInstallScripts(row) {
  const stored = Array.isArray(row.install_script_types) ? row.install_script_types : null;
  if (stored) {
    const kept = stored.filter((t) => INSTALL_LIFECYCLE.includes(t));
    return { types: kept, has: kept.length > 0 };
  }
  return { types: row.install_script_types ?? [], has: !!row.has_install_scripts };
}

/** Re-derive the MECHANICAL verdict (pre-MAL, pre-freshness) from a stored row's
 *  signals — the exact inputs computeMechanical feeds computeVerdict, read back
 *  off the row instead of re-fetched, with the corrected install-script signal.
 *  Pure; no network. */
export function mechanicalVerdictFromRow(row) {
  const { has } = correctedInstallScripts(row);
  return computeVerdict({
    mal: [], // MAL is applied live at read-time (finalize), never stored
    has_provenance: row.has_provenance,
    is_minified: row.is_minified,
    has_install_scripts: has,
    description_match: row.description_match,
    diff_review: row.diff_review,
    typosquat: row.typosquat_of ? { of: row.typosquat_of, distance: row.typosquat_distance } : null,
    has_github_tag: row.has_github_tag,
    weekly_downloads: row.weekly_downloads,
  });
}

/** Recompute one row under the current engine (zero network) and persist it iff
 *  anything material changed. Injectable readVerdict/writeVerdict for tests. */
export async function recomputeRow(row, opts = {}) {
  const { sw, readVerdict = dbReadVerdict, writeVerdict = dbWriteVerdict } = opts;

  const base = mechanicalVerdictFromRow(row);
  const { types: keptScripts, has: hasScripts } = correctedInstallScripts(row);

  // Cascade — re-read the CURRENT verdict of each previously-flagged child (at
  // the version it was stored under). Monotone fixes ⇒ new flags ⊆ old flags, so
  // this is complete: a child now verified (or gone) drops off.
  const oldFlags = Array.isArray(row.dependency_flags) ? row.dependency_flags : [];
  const newFlags = [];
  for (const f of oldFlags) {
    if (!f || typeof f.name !== 'string') continue;
    let child = null;
    try {
      child = await readVerdict(sw, f.name, f.version);
    } catch {
      child = null;
    }
    if (child?.verdict && child.verdict !== 'verified') {
      newFlags.push({ name: f.name, version: f.version, verdict: child.verdict });
    }
  }

  let verdict = base.verdict;
  let signals = [...base.verdict_signals];
  const cascaded = cascadeVerdict(verdict, newFlags.map((d) => d.verdict));
  if (cascaded !== verdict) {
    verdict = cascaded;
    const signal = newFlags.some((d) => d.verdict === 'blocked') ? 'dependency_blocked' : 'dependency_flagged';
    signals = [...new Set([...signals, signal])];
  }

  const cleared = Math.max(0, oldFlags.length - newFlags.length);
  const next = {
    ...row,
    verdict,
    verdict_signals: signals,
    install_script_types: keptScripts,
    has_install_scripts: hasScripts,
    dependency_flags: newFlags,
    dep_verified: (row.dep_verified ?? 0) + cleared,
    dep_unknown: row.dep_unknown,
  };

  const changed =
    row.verdict !== next.verdict ||
    JSON.stringify(row.verdict_signals ?? []) !== JSON.stringify(next.verdict_signals) ||
    JSON.stringify(row.dependency_flags ?? []) !== JSON.stringify(next.dependency_flags) ||
    Boolean(row.has_install_scripts) !== next.has_install_scripts;

  if (changed) await writeVerdict(sw, next);
  return { package: row.package, version: row.version, from: row.verdict, to: verdict, changed };
}

/** SELECT + recompute one slice of the worklist (verdict != 'verified'), after a
 *  stable (package, version) cursor. Zero network — bounded concurrency only
 *  hides DB round-trip latency. Returns a tally, the resume cursor, and whether
 *  more rows remain in this pass. */
export async function backfillSlice(sw, opts = {}) {
  const {
    limit = 150,
    afterPackage = '',
    afterVersion = '',
    readVerdict = dbReadVerdict,
    writeVerdict = dbWriteVerdict,
    concurrency = 8,
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
  const rows = (Array.isArray(r?.data) ? r.data : []).map(rowToVerdict);

  const before = { verified: 0, suspicious: 0, unverified: 0, blocked: 0 };
  const after = { verified: 0, suspicious: 0, unverified: 0, blocked: 0 };
  let processed = 0;
  let changed = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += lanes) {
    const chunk = rows.slice(i, i + lanes);
    await Promise.all(
      chunk.map(async (row) => {
        if (row.verdict in before) before[row.verdict]++;
        try {
          const res = await recomputeRow(row, { sw, readVerdict, writeVerdict });
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
    nextCursor: last
      ? { package: last.package, version: last.version }
      : { package: afterPackage, version: afterVersion },
  };
}

/** Run the dependency check for ONE row that never had one — the gap the
 *  mechanical backfill deliberately left (it skipped deps to stay zero-fetch, so
 *  rows that had never been enriched kept `dep_verified` absent, which
 *  verdictComplete correctly reports as "still checking"). This is the small,
 *  targeted "complete the data" fix: the gate is right — a favourable verdict
 *  whose dependencies were never checked is genuinely incomplete — so we run the
 *  check rather than teaching the gate to call it complete. Unlike the mechanical
 *  pass this DOES fetch (a single-version manifest for the declared ranges, then
 *  dep resolution), but only for the tiny set of rows missing the check.
 *  Injectable for tests. */
export async function completeRowDepCheck(row, opts = {}) {
  const {
    sw,
    fetchImpl = fetch,
    readVerdict = dbReadVerdict,
    writeVerdict = dbWriteVerdict,
    fetchManifest = registryFetchManifest,
    resolveVersion = resolveDependencyVersion,
  } = opts;

  // Declared ranges for THIS exact version — a small single-version manifest,
  // not the full packument (change #3: score the versions actually installed).
  let ranges = {};
  try {
    const m = await fetchManifest(row.package, row.version, { fetchImpl });
    if (m && typeof m.dependencies === 'object' && m.dependencies) ranges = m.dependencies;
  } catch {
    ranges = {}; // no manifest → resolve deps to latest (dep-tree default)
  }

  const deps = await checkDependencies(row.dependencies, {
    resolveVersion,
    readVerdict,
    sw,
    fetchImpl,
    ranges,
  });

  let verdict = row.verdict;
  let signals = Array.isArray(row.verdict_signals) ? [...row.verdict_signals] : [];
  const cascaded = cascadeVerdict(verdict, deps.flagged.map((d) => d.verdict));
  if (cascaded !== verdict) {
    verdict = cascaded;
    const signal = deps.flagged.some((d) => d.verdict === 'blocked') ? 'dependency_blocked' : 'dependency_flagged';
    signals = [...new Set([...signals, signal])];
  }

  const next = {
    ...row,
    verdict,
    verdict_signals: signals,
    dependency_flags: deps.flagged,
    dep_verified: deps.verified, // now a number → the verdict becomes COMPLETE
    dep_unknown: deps.unknown,
  };
  await writeVerdict(sw, next);
  return { package: row.package, version: row.version, from: row.verdict, to: verdict, dep_verified: deps.verified };
}

/** Slice of the "never dep-checked" worklist: verified/any rows that declare
 *  dependencies but have no dep_verified (metadata JSON null). Resumable by
 *  (package, version); idempotent (re-running recomputes the same numbers). */
export async function completeDepChecks(sw, opts = {}) {
  const {
    limit = 50,
    afterPackage = '',
    afterVersion = '',
    githubToken,
    fetchImpl = fetch,
    readVerdict = dbReadVerdict,
    writeVerdict = dbWriteVerdict,
    concurrency = 5,
  } = opts;
  const cap = Math.min(200, Math.max(1, limit));
  const lanes = Math.min(16, Math.max(1, concurrency));

  const r = await sw.db.query(
    `SELECT * FROM verdicts
      WHERE json_extract(metadata, '$.dep_verified') IS NULL
        AND dependencies IS NOT NULL AND dependencies != '[]' AND dependencies != ''
        AND (package > ? OR (package = ? AND version > ?))
      ORDER BY package, version
      LIMIT ?`,
    [afterPackage, afterPackage, afterVersion, cap],
  );
  const rows = (Array.isArray(r?.data) ? r.data : []).map(rowToVerdict);

  let processed = 0;
  let completed = 0;
  let changed = 0;
  let errors = 0;
  for (let i = 0; i < rows.length; i += lanes) {
    const chunk = rows.slice(i, i + lanes);
    const out = await Promise.all(
      chunk.map(async (row) => {
        try {
          const res = await completeRowDepCheck(row, { sw, fetchImpl, readVerdict, writeVerdict });
          return { ok: true, changed: res.to !== res.from };
        } catch {
          return { ok: false };
        }
      }),
    );
    for (const o of out) {
      processed++;
      if (o.ok) { completed++; if (o.changed) changed++; }
      else errors++;
    }
  }

  const last = rows[rows.length - 1];
  return {
    processed,
    completed,
    changed,
    errors,
    hasMore: rows.length === cap,
    nextCursor: last
      ? { package: last.package, version: last.version }
      : { package: afterPackage, version: afterVersion },
  };
}
