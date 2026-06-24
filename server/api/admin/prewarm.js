/** POST /api/admin/prewarm?offset=0&limit=50[&enrich=1] — trigger a pre-warm
 *  slice. Guarded by the X-Prewarm-Key header (=== sw.env.PREWARM_KEY); returns
 *  403 if the secret is unset or wrong, so this is never publicly runnable.
 *  Resumable: call repeatedly bumping offset (or wire a cron to do it). Mechanical
 *  only unless enrich=1 (paid LLM backfill). The package list comes from
 *  sw.env.TOP_PACKAGES_URL (a JSON list of names or {name,downloads}); a small
 *  built-in seed lets you validate the pipeline before the real list is set. */

import { prewarmSlice, normalizeNames } from '../../_lib/prewarm.mjs';

const SEED = [
  'react', 'react-dom', 'lodash', 'axios', 'express', 'chalk', 'commander', 'semver',
  'debug', 'typescript', 'vite', 'next', 'left-pad', 'is-odd', 'tslib', 'zod',
];

export default async function (req, sw) {
  const key = req.headers.get('x-prewarm-key');
  if (!sw.env?.PREWARM_KEY || key !== sw.env.PREWARM_KEY) {
    return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
  }

  const url = new URL(req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
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
      // fall back to the seed list rather than failing the whole run
    }
  }

  const summary = await prewarmSlice(sw, {
    names,
    offset,
    limit,
    enrich,
    githubToken: sw.env?.GITHUB_TOKEN,
  });
  return Response.json({ ok: true, data: { source: names === SEED ? 'seed' : 'TOP_PACKAGES_URL', ...summary } });
}
