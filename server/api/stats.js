/** GET /api/stats — usage rollup so we know when to raise the rate limit.
 *
 *  Key-gated (same PREWARM_KEY as the crawler — NOT public). Pass it as
 *  `?key=…`, an `X-Prewarm-Key` header, or a Bearer token. Returns the per-day
 *  request/429 counts split by source (web checker vs CLI), plus how many IPs
 *  are currently throttled — the signal that it's time to bump the limit. Every
 *  query is guarded so a missing table just yields empty data, never a 500. */

function presentedKey(req, url) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return (m && m[1].trim()) || req.headers.get('x-prewarm-key') || url.searchParams.get('key') || null;
}

async function rows(sw, sql, params = []) {
  try {
    const r = await sw.db.query(sql, params);
    return Array.isArray(r?.data) ? r.data : [];
  } catch {
    return [];
  }
}

export default async function (req, sw) {
  const url = new URL(req.url);
  if (!sw.env?.PREWARM_KEY || presentedKey(req, url) !== sw.env.PREWARM_KEY) {
    return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
  }

  const days = Math.min(120, Math.max(1, parseInt(url.searchParams.get('days') ?? '30', 10) || 30));
  const daily = await rows(
    sw,
    'SELECT day, source, requests, blocked FROM usage_daily ORDER BY day DESC, source ASC LIMIT ?',
    [days * 4],
  );

  // Roll the per-source rows up into one entry per day + a grand total.
  const byDay = {};
  const totals = { requests: 0, blocked: 0, web: 0, cli: 0 };
  for (const r of daily) {
    const d = (byDay[r.day] = byDay[r.day] || { day: r.day, requests: 0, blocked: 0, web: 0, cli: 0 });
    d.requests += r.requests;
    d.blocked += r.blocked;
    d[r.source === 'web' ? 'web' : 'cli'] += r.requests;
    totals.requests += r.requests;
    totals.blocked += r.blocked;
    totals[r.source === 'web' ? 'web' : 'cli'] += r.requests;
  }
  const byDayList = Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1));

  // IPs currently over the limit in their live window — the bump signal.
  const now = Date.now();
  const throttled = await rows(
    sw,
    'SELECT COUNT(*) AS n FROM rate_limit WHERE count >= 200 AND reset_at > ?',
    [now],
  );

  return Response.json({
    ok: true,
    data: {
      limit_per_hour: 200,
      throttled_ips_now: throttled[0]?.n ?? 0,
      totals,
      by_day: byDayList,
    },
  });
}
