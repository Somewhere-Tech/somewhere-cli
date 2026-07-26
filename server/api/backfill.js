/** POST /api/backfill?limit=150[&after=<pkg>&after_version=<ver>] — recompute one
 *  slice of the stale worklist (verdict != 'verified') under the CURRENT engine.
 *  Mechanical + dependency cascade only; NO LLM, narratives preserved.
 *
 *  Guarded by `Authorization: Bearer <PREWARM_KEY>` (also X-Prewarm-Key header or
 *  body.key, so a cron can drive it). 403 if the secret is unset or wrong.
 *
 *  Resumable + convergent, driven from OUTSIDE:
 *    1. one PASS = call repeatedly, feeding back `nextCursor`, until `hasMore` is
 *       false. Leaves clear on pass 1.
 *    2. repeat whole passes (cursor reset) until a pass reports `changed: 0`
 *       across all slices — parents clear as their children do. Cap the passes.
 *  Idempotent: a correct row recomputes to itself (0 change), so re-running is
 *  safe, as is interrupting mid-pass (already-written rows are correct).
 *
 *  POST /api/backfill?count=1 — read-only worklist size by level (no writes),
 *  for before/after monitoring. */

import { backfillSlice, completeDepChecks } from '../_lib/backfill.mjs';

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function worklistCounts(sw) {
  const r = await sw.db.query(
    "SELECT verdict, COUNT(*) AS n FROM verdicts WHERE verdict != 'verified' GROUP BY verdict",
  );
  const rows = Array.isArray(r?.data) ? r.data : [];
  const out = { suspicious: 0, unverified: 0, blocked: 0, total: 0 };
  for (const row of rows) {
    if (row.verdict in out) out[row.verdict] = row.n;
    out.total += row.n;
  }
  // Rows that declare dependencies but never had a dep check (dep_verified
  // absent) — these render as pending/incomplete until `?depcheck=1` runs.
  let missing_depcheck = 0;
  try {
    const m = await sw.db.query(
      "SELECT COUNT(*) AS n FROM verdicts WHERE json_extract(metadata,'$.dep_verified') IS NULL AND dependencies IS NOT NULL AND dependencies != '[]' AND dependencies != ''",
    );
    missing_depcheck = m?.data?.[0]?.n ?? 0;
  } catch {
    // best-effort metric
  }
  return { ...out, missing_depcheck };
}

export default async function (req, sw) {
  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const presented = bearer(req) || req.headers.get('x-prewarm-key') || body?.key;
  if (!sw.env?.PREWARM_KEY || presented !== sw.env.PREWARM_KEY) {
    return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
  }

  const url = new URL(req.url);

  // Read-only worklist size — for the before/after snapshot.
  if (url.searchParams.get('count') === '1') {
    return Response.json({ ok: true, data: { mode: 'count', remaining: await worklistCounts(sw) } });
  }

  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '150', 10) || 150));
  const afterPackage = url.searchParams.get('after') ?? body?.after ?? '';
  const afterVersion = url.searchParams.get('after_version') ?? body?.after_version ?? '';

  // Complete the dependency check for rows that never had one (dep_verified
  // absent) — the gap the zero-fetch mechanical pass left. This mode fetches
  // (a small manifest per row), so it is separate from the mechanical slice.
  if (url.searchParams.get('depcheck') === '1') {
    const summary = await completeDepChecks(sw, {
      limit,
      afterPackage,
      afterVersion,
      githubToken: sw.env?.GITHUB_TOKEN,
    });
    return Response.json({ ok: true, data: { mode: 'depcheck', ...summary } });
  }

  const summary = await backfillSlice(sw, { limit, afterPackage, afterVersion });
  return Response.json({ ok: true, data: { mode: 'slice', ...summary } });
}
