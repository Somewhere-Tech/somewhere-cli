/** Client for the verdict API hosted on the `npm` platform project.
 *
 *  This is NOT the /v1 control plane and NOT the runner — it's the public,
 *  unauthenticated verdict service at npm.somewhere.tech (FAQ: "Free, no
 *  login"). So this client deliberately does not touch ApiClient or the stored
 *  developer key. Override the host for staging/tests via SWPX_VERDICT_URL.
 *
 *  Reachability is a product guarantee, inverted: if the verdict API is down,
 *  the user must still get normal npm behaviour ("a gate, not a wall"). So every
 *  failure here raises VerdictUnavailable and the command layer falls back to
 *  the real npx/npm. We never block on our own outage. */

import type { Verdict } from './types.js';
import type { FetchLike, FetchResponse } from './registry.js';

const VERDICT_BASE =
  process.env.SWPX_VERDICT_URL?.replace(/\/$/, '') || 'https://npm.somewhere.tech';

/** Budget for one verdict lookup. It sits in front of every `npx`, so it must
 *  fail to fallback rather than stall — but 4s was too tight for the COLD path
 *  (fresh DNS/TLS from the client + a cold worker + a first-time uncached compute),
 *  which spuriously tripped the fail-open banner on the very first call while every
 *  warm call after was instant. 8s comfortably covers a cold uncached lookup;
 *  override with SWPX_VERDICT_TIMEOUT_MS (e.g. lower it for strict fail-fast in CI). */
const VERDICT_TIMEOUT_MS = Number(process.env.SWPX_VERDICT_TIMEOUT_MS) || 8000;

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<FetchResponse>;

/** Raised whenever the verdict couldn't be obtained — network error, timeout,
 *  non-2xx, or unparseable body. The command layer treats it as "fall back to
 *  the real tool", never as "block". */
export class VerdictUnavailable extends Error {
  /** True when the service answered 429 — a throttle, not an outage/tampering. */
  readonly rateLimited: boolean;
  constructor(message: string, rateLimited = false) {
    super(message);
    this.name = 'VerdictUnavailable';
    this.rateLimited = rateLimited;
  }
}

/** Accept either a bare verdict object or a `{ ok, data }` envelope. */
function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && 'ok' in body) {
    const env = body as { ok?: boolean; data?: unknown; error?: string; message?: string };
    if (env.ok === true) return env.data;
    throw new VerdictUnavailable(env.message || env.error || 'verdict API returned ok:false');
  }
  return body;
}

function timeoutSignal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(VERDICT_TIMEOUT_MS);
  } catch {
    return undefined; // very old runtime — let the request run without our timeout
  }
}

/** Look up one package@version. Throws VerdictUnavailable on any failure. */
export async function getVerdict(
  name: string,
  version: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<Verdict> {
  const url = `${VERDICT_BASE}/api/verdict/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let res: FetchResponse;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: timeoutSignal() });
  } catch (err) {
    throw new VerdictUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new VerdictUnavailable(`verdict API returned ${res.status}`, res.status === 429);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VerdictUnavailable('verdict API returned a non-JSON body');
  }
  const v = unwrap(body) as Verdict | undefined;
  if (!v || typeof v !== 'object' || typeof (v as Verdict).verdict !== 'string') {
    throw new VerdictUnavailable('verdict API returned an unexpected shape');
  }
  // Trust the caller's resolved coordinates over whatever the row echoes back.
  return { ...v, package: name, version };
}

/** Batch-check a resolved tree. Throws VerdictUnavailable on any failure so the
 *  caller can fall back to a plain `npm install`. The returned array is aligned
 *  to the input order; any row the service omits is dropped (caller treats a
 *  missing row as "unknown", not "verified"). */
export async function getVerdictBatch(
  pkgs: Array<{ package: string; version: string }>,
  fetchImpl: FetchLike = defaultFetch,
): Promise<Verdict[]> {
  if (pkgs.length === 0) return [];
  const url = `${VERDICT_BASE}/api/verdict/batch`;
  let res: FetchResponse;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages: pkgs }),
      signal: timeoutSignal(),
    });
  } catch (err) {
    throw new VerdictUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new VerdictUnavailable(`verdict API returned ${res.status}`, res.status === 429);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VerdictUnavailable('verdict API returned a non-JSON body');
  }
  const data = unwrap(body);
  const results = Array.isArray(data)
    ? data
    : (data as { results?: unknown })?.results;
  if (!Array.isArray(results)) {
    throw new VerdictUnavailable('verdict API batch returned an unexpected shape');
  }
  return results.filter(
    (v): v is Verdict => !!v && typeof v === 'object' && typeof (v as Verdict).verdict === 'string',
  );
}

export const verdictBaseUrl = VERDICT_BASE;
