/** GET /api/verdict/:pkg/:version — the verdict for one package@version.
 *
 *  The CLI URL-encodes the package name as a SINGLE path segment (so
 *  `@ctrl/tinycolor` arrives as `%40ctrl%2Ftinycolor`); we read the segments
 *  straight off the path and decode, which is independent of how the platform
 *  injects route params. Returns the `{ ok, data, enriched }` envelope the CLI
 *  unwraps (the CLI ignores `enriched`; the web checker uses it to decide whether
 *  to re-poll for the richer signals). Verified packages are the common case;
 *  everything degrades to a useful answer rather than an error, because a verdict
 *  outage must never block an install.
 *
 *  Query params (both optional, both no-ops for the CLI's normal call):
 *    ?from=web   — tag the request source for usage metrics (CLI omits it).
 *    ?enrich=1   — fill the richer signals (advisory history, CVE count,
 *                  dependency cascade, narrative) for a non-blocked row we
 *                  haven't enriched yet. The web checker's delayed recall sets
 *                  this; guarded so a failure returns the mechanical verdict. */

import { resolveVerdict } from '../../../_lib/resolve.mjs';
import { checkRateLimit, clientIp } from '../../../_lib/ratelimit.mjs';
import { enrichRow } from '../../../_lib/prewarm.mjs';
import { readVerdict, writeVerdict } from '../../../_lib/db.mjs';

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Per-day, per-source request + 429 counters. Schema is owned by migration
 *  0005; metrics remain best-effort and NEVER throw into the verdict path.
 *  `source` is 'web' (the live checker) or 'cli'. */
async function track(sw, source, blocked) {
  try {
    await sw.db.query(
      `INSERT INTO usage_daily (day, source, requests, blocked) VALUES (?, ?, 1, ?)
       ON CONFLICT(day, source) DO UPDATE SET requests = requests + 1, blocked = blocked + ?`,
      [today(), source, blocked, blocked],
    );
  } catch {
    // metrics must never break the verdict path
  }
}

export default async function (req, sw) {
  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean); // [api, verdict, pkg, version]
  const pkg = decodeURIComponent(segments[2] ?? '');
  const version = decodeURIComponent(segments[3] ?? '');
  if (!pkg || !version) {
    return Response.json(
      { ok: false, error: 'BAD_REQUEST', message: 'package and version are required' },
      { status: 400 },
    );
  }
  const source = url.searchParams.get('from') === 'web' ? 'web' : 'cli';

  const rl = await checkRateLimit(sw, `v:${clientIp(req)}`);
  await track(sw, source, rl.ok ? 0 : 1);
  if (!rl.ok) {
    return Response.json(
      { ok: false, error: 'RATE_LIMITED', message: 'Too many requests — try again shortly.' },
      { status: 429, headers: { 'retry-after': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  try {
    let verdict = await resolveVerdict(sw, pkg, version);

    // The web checker shows a fast mechanical verdict, then re-polls with
    // ?enrich=1 to fill the richer signals. We skip blocked rows (a block is
    // decisive — nothing to enrich) and already-enriched rows (summary present).
    if (url.searchParams.get('enrich') === '1' && verdict.verdict !== 'blocked' && !verdict.summary) {
      try {
        const raw = await readVerdict(sw, pkg, version);
        if (raw) {
          await enrichRow(sw, raw, {
            llmProvider: sw.env?.PREWARM_PROVIDER,
            llmModel: sw.env?.PREWARM_MODEL,
            githubToken: sw.env?.GITHUB_TOKEN,
          });
          await writeVerdict(sw, raw);
          verdict = await resolveVerdict(sw, pkg, version);
        }
      } catch {
        // enrich is best-effort — keep the mechanical verdict on any failure
      }
    }

    return Response.json(
      { ok: true, data: verdict, enriched: Boolean(verdict.summary) },
      { headers: { 'cache-control': 'public, max-age=60' } },
    );
  } catch (err) {
    // Compute failed (registry unreachable, etc.). 502 so the CLI falls back to
    // plain npx rather than treating a bad gateway as a clean pass.
    return Response.json(
      { ok: false, error: 'VERDICT_UNAVAILABLE', message: String(err?.message || err) },
      { status: 502 },
    );
  }
}
