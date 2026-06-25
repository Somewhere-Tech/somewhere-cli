/** POST /api/verdict/batch  { packages: [{ package, version }, ...] }
 *  → { ok, data: { results: Verdict[] } }
 *
 *  Used by `swpm install` to check a resolved tree in one round-trip. Rows the
 *  service can't produce are simply omitted — the CLI treats a missing row as
 *  "unverified", never as "verified", so dropping one fails safe. Bounded to
 *  keep a single request's work in check; the CLI sends the resolved tree, which
 *  for a post-prewarm cache is mostly hits. */

import { resolveVerdict } from '../../_lib/resolve.mjs';
import { checkRateLimit, clientIp } from '../../_lib/ratelimit.mjs';

const MAX_PACKAGES = 200;
const CONCURRENCY = 8;

export default async function (req, sw) {
  const rl = await checkRateLimit(sw, `v:${clientIp(req)}`);
  if (!rl.ok) {
    return Response.json(
      { ok: false, error: 'RATE_LIMITED', message: 'Too many requests — try again shortly.' },
      { status: 429, headers: { 'retry-after': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'BAD_JSON', message: 'expected a JSON body' }, { status: 400 });
  }

  const packages = (Array.isArray(body?.packages) ? body.packages : [])
    .filter((p) => p && typeof p.package === 'string' && typeof p.version === 'string')
    .slice(0, MAX_PACKAGES);

  const results = [];
  // Bounded concurrency: a worker is a single CPU budget, so we cap parallel
  // fetches rather than firing all N at once.
  for (let i = 0; i < packages.length; i += CONCURRENCY) {
    const slice = packages.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      slice.map((p) =>
        resolveVerdict(sw, p.package, p.version).catch(() => null),
      ),
    );
    for (const v of settled) if (v) results.push(v);
  }

  return Response.json({ ok: true, data: { results } });
}
