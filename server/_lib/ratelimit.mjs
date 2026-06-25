/** A small D1-backed rate limiter for the public verdict API.
 *
 *  One self-resetting row per bucket (an IP, or an api-key hash). A single
 *  atomic UPSERT increments and rolls the window, so concurrent requests don't
 *  race. The limiter NEVER breaks the verdict path: if the store errors, we
 *  allow the request (a rate-limit outage must not deny security checks).
 *
 *  Note: D1-write-per-request is fine at launch traffic; swap to Cloudflare's
 *  native rate-limit binding if this ever becomes the write bottleneck. */

export async function checkRateLimit(sw, bucket, { limit = 200, windowMs = 3_600_000, now = Date.now() } = {}) {
  if (!bucket) return { ok: true, remaining: limit, retryAfterMs: 0 };
  try {
    const reset = now + windowMs;
    const r = await sw.db.query(
      `INSERT INTO rate_limit (bucket, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN reset_at < ? THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at < ? THEN ? ELSE reset_at END
       RETURNING count, reset_at`,
      [bucket, reset, now, now, reset],
    );
    const row = r?.data?.[0];
    if (!row) return { ok: true, remaining: limit, retryAfterMs: 0 };
    const ok = row.count <= limit;
    return {
      ok,
      remaining: Math.max(0, limit - row.count),
      retryAfterMs: ok ? 0 : Math.max(0, row.reset_at - now),
    };
  } catch {
    return { ok: true, remaining: limit, retryAfterMs: 0 }; // never deny on a limiter failure
  }
}

/** The caller's IP (Cloudflare sets cf-connecting-ip), or a stable fallback. */
export function clientIp(req) {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}
