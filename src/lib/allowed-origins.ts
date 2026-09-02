/**
 * What counts as an exact web address for a cross-origin allowlist.
 *
 * The allowlist is matched byte-for-byte by the platform, so a path, a query, a
 * trailing slash or a wildcard silently never matches anything. Catching that
 * here — before the request — turns a blocked browser call the developer
 * debugs for ten minutes into one sentence at the moment they typed it.
 *
 * Rule: scheme + host + optional port, and nothing else.
 */
export function isExactOrigin(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) return false;
  if (trimmed.includes('*')) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  // `new URL('https://x.dev')` normalizes to pathname '/', so a bare address
  // and one with a trailing slash both arrive here as '/'. Anything deeper is a
  // path, which the allowlist cannot match.
  if (url.pathname !== '/') return false;
  // A trailing slash is not what the platform stores, and `https://x.dev/`
  // never equals `https://x.dev`. Require the exact form.
  return trimmed === url.origin;
}
