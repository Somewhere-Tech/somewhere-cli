/** Short-TTL cache for MAL (malware) advisories, so the verdict hot path no
 *  longer pays a live OSV round-trip on EVERY request. The block signal must stay
 *  near-real-time, so the TTL is 60s: a version flagged malicious is reflected in
 *  the verdict within at most ~60s (the trade we accept for not hitting OSV on
 *  every call). Stored per (package, version); the stored objects are the full
 *  parsed advisories (sources included — the engine reads them to decide
 *  confirmed-block vs. warn).
 *
 *  Safety properties (this is the block path — they are not optional):
 *   - A cache READ never throws into the verdict path. A D1 hiccup or a missing
 *     table degrades to a pure live query, exactly today's behaviour.
 *   - On an OSV OUTAGE we serve the last-known advisories if they're recent
 *     (≤ STALE_FLOOR), biasing toward STILL BLOCKING a known-bad version rather
 *     than failing open. Only when we have nothing usable do we rethrow, so
 *     resolve.mjs treats it as "no MAL info" — never a silent clean pass. Every
 *     stale serve is logged; nothing is masked.
 *   - The cache is keyed independently of the npm manifest, so a malicious
 *     version that's since been unpublished is still blockable.
 *
 *  DDL is not permitted from sw.db.query on this platform, so the mal_advisories
 *  table is created out-of-band (migration 0006). A missing table simply means
 *  every call is a live query — correct, just not fast. */

import { queryMalAdvisories } from './osv.mjs';

export const MAL_TTL_MS = 60_000; // 60s freshness bound on the block signal
const STALE_FLOOR_MS = 30 * 60_000; // serve stale-on-outage up to 30 min, then give up

function parseAdvisories(s) {
  if (Array.isArray(s)) return s;
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

async function readCache(sw, name, version) {
  try {
    const r = await sw.db.query(
      'SELECT advisories, checked_at FROM mal_advisories WHERE package = ? AND version = ?',
      [name, version],
    );
    return r?.data?.[0] ?? null;
  } catch {
    return null; // no table / D1 hiccup → behave like a miss, never block the verdict
  }
}

async function writeCache(sw, name, version, advisories, nowIso) {
  try {
    await sw.db.query(
      `INSERT OR REPLACE INTO mal_advisories (package, version, advisories, checked_at, ok)
       VALUES (?, ?, ?, ?, 1)`,
      [name, version, JSON.stringify(advisories), nowIso],
    );
  } catch {
    // best-effort cache; returning the verdict matters more than persisting it
  }
}

/** Cache-first MAL lookup. Same return shape as queryMalAdvisories (array of
 *  parsed advisories, sources included) — a drop-in for the verdict path. */
export async function cachedMalAdvisories(
  sw,
  name,
  version,
  { fetchImpl = fetch, ttlMs = MAL_TTL_MS, now = Date.now() } = {},
) {
  const cached = await readCache(sw, name, version);
  if (cached?.checked_at) {
    const age = now - Date.parse(cached.checked_at);
    if (age >= 0 && age < ttlMs) return parseAdvisories(cached.advisories); // fresh — no OSV round-trip
  }

  try {
    const advisories = await queryMalAdvisories(name, version, { fetchImpl });
    await writeCache(sw, name, version, advisories, new Date(now).toISOString());
    return advisories;
  } catch (err) {
    // OSV unreachable. Prefer last-known-recent advisories (keep blocking known-bad)
    // over failing open; only give up when we have nothing usable.
    if (cached?.checked_at) {
      const age = now - Date.parse(cached.checked_at);
      if (age >= 0 && age < STALE_FLOOR_MS) {
        try {
          console.warn(
            `[mal-cache] OSV unreachable for ${name}@${version} — serving advisories cached ${Math.round(age / 1000)}s ago`,
          );
        } catch {
          /* logging is best-effort */
        }
        return parseAdvisories(cached.advisories);
      }
    }
    throw err; // nothing usable — caller (resolve.mjs) treats this as "no MAL info"
  }
}

/** Proactive refresh of the STALEST hot-set rows, so popular packages don't pay
 *  the once-a-minute live round-trip even on the first request of a window. This
 *  is the "monitor the feed" half — driven by a 1-min cron. Oldest-checked first,
 *  bounded by `limit` to cap OSV load per tick. */
export async function refreshMalHotSet(sw, { limit = 100, fetchImpl = fetch, now = Date.now() } = {}) {
  let rows = [];
  try {
    const r = await sw.db.query(
      'SELECT package, version FROM mal_advisories ORDER BY checked_at ASC LIMIT ?',
      [Math.min(Math.max(1, limit), 500)],
    );
    rows = Array.isArray(r?.data) ? r.data : [];
  } catch {
    return { hot: 0, refreshed: 0, flagged: 0, errors: 0, note: 'mal_advisories table unavailable' };
  }

  const nowIso = new Date(now).toISOString();
  let refreshed = 0;
  let flagged = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const advisories = await queryMalAdvisories(row.package, row.version, { fetchImpl });
      await writeCache(sw, row.package, row.version, advisories, nowIso);
      refreshed++;
      if (advisories.length) flagged++;
    } catch {
      errors++;
    }
  }
  return { hot: rows.length, refreshed, flagged, errors };
}
