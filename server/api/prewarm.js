/** POST /api/prewarm?offset=0&limit=50[&enrich=1] — trigger a pre-warm slice.
 *  Guarded by `Authorization: Bearer <PREWARM_KEY>` (=== sw.env.PREWARM_KEY);
 *  403 if the secret is unset or wrong, so it's never publicly runnable.
 *  Resumable: call repeatedly bumping offset (or wire a cron). Mechanical only
 *  unless enrich=1 (paid LLM description-match — provider/model from
 *  PREWARM_PROVIDER / PREWARM_MODEL env, default deepseek-v4-flash). The package
 *  list comes from sw.env.TOP_PACKAGES_URL (JSON list of names or
 *  {name,downloads}); a small built-in seed validates the pipeline first. */

import { prewarmSlice, enrichPending, normalizeNames } from '../_lib/prewarm.mjs';

const SEED = [
  'react', 'react-dom', 'lodash', 'axios', 'express', 'chalk', 'commander', 'semver',
  'debug', 'typescript', 'vite', 'next', 'left-pad', 'is-odd', 'tslib', 'zod',
];

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export default async function (req, sw) {
  // The body carries the key for the cron path (cron_create can't set headers).
  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  // Accept Bearer header, X-Prewarm-Key header, or body.key (cron).
  const presented = bearer(req) || req.headers.get('x-prewarm-key') || body?.key;
  if (!sw.env?.PREWARM_KEY || presented !== sw.env.PREWARM_KEY) {
    return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
  }

  const url = new URL(req.url);

  // Lazy "do the ones we don't have": enrich cache-miss rows that have no
  // narrative yet. Demand-driven; a cron drives it. (POST /api/prewarm?pending=1)
  if (url.searchParams.get('pending') === '1') {
    const summary = await enrichPending(sw, {
      limit: parseInt(url.searchParams.get('limit') ?? '3', 10) || 3,
      llmProvider: sw.env?.PREWARM_PROVIDER,
      llmModel: sw.env?.PREWARM_MODEL,
    });
    return Response.json({ ok: true, data: { mode: 'pending', ...summary } });
  }

  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
  const enrich = url.searchParams.get('enrich') === '1';

  let names = SEED;
  if (sw.env?.TOP_PACKAGES_URL) {
    try {
      const r = await fetch(sw.env.TOP_PACKAGES_URL);
      if (r.ok) {
        const fromList = normalizeNames(await r.json());
        if (fromList.length) names = fromList;
      }
    } catch {
      // fall back to the seed rather than failing the run
    }
  }

  const summary = await prewarmSlice(sw, {
    names,
    offset,
    limit,
    enrich,
    githubToken: sw.env?.GITHUB_TOKEN,
    llmProvider: sw.env?.PREWARM_PROVIDER,
    llmModel: sw.env?.PREWARM_MODEL,
  });
  return Response.json({ ok: true, data: { source: names === SEED ? 'seed' : 'TOP_PACKAGES_URL', ...summary } });
}
