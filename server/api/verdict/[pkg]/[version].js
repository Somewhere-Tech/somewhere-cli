/** GET /api/verdict/:pkg/:version — the verdict for one package@version.
 *
 *  The CLI URL-encodes the package name as a SINGLE path segment (so
 *  `@ctrl/tinycolor` arrives as `%40ctrl%2Ftinycolor`); we read the segments
 *  straight off the path and decode, which is independent of how the platform
 *  injects route params. Returns the `{ ok, data }` envelope the CLI unwraps.
 *  Verified packages are the common case; everything degrades to a useful answer
 *  rather than an error, because a verdict outage must never block an install. */

import { resolveVerdict } from '../../../_lib/resolve.mjs';

export default async function (req, sw) {
  const segments = new URL(req.url).pathname.split('/').filter(Boolean); // [api, verdict, pkg, version]
  const pkg = decodeURIComponent(segments[2] ?? '');
  const version = decodeURIComponent(segments[3] ?? '');
  if (!pkg || !version) {
    return Response.json(
      { ok: false, error: 'BAD_REQUEST', message: 'package and version are required' },
      { status: 400 },
    );
  }

  try {
    const verdict = await resolveVerdict(sw, pkg, version);
    return Response.json(
      { ok: true, data: verdict },
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
