/** POST /api/osv-refresh?limit=100 — re-check the stalest MAL-cache rows so the
 *  hot set stays inside the 60s freshness window without each request paying a
 *  live OSV round-trip. This is the "monitor the feed every minute" half of the
 *  MAL cache; wire a 1-min cron to it.
 *
 *  Guarded by `Authorization: Bearer <PREWARM_KEY>` (also X-Prewarm-Key header or
 *  body.key, since cron can't set headers). 403 if the secret is unset or wrong.
 *  Bounded by `limit` to cap OSV load per tick. */

import { refreshMalHotSet } from '../_lib/mal-cache.mjs';

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export default async function (req, sw) {
  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const presented = bearer(req) || req.headers.get('x-prewarm-key') || body?.key;
  // Accept the prewarm key OR a dedicated cron key (OSV_REFRESH_KEY), so the
  // scheduled poll can authenticate without sharing the prewarm secret.
  const accepted = [sw.env?.PREWARM_KEY, sw.env?.OSV_REFRESH_KEY].filter(Boolean);
  if (!accepted.length || !accepted.includes(presented)) {
    return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
  }

  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100));
  const summary = await refreshMalHotSet(sw, { limit });
  return Response.json({ ok: true, data: summary });
}
