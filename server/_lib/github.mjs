/** "Does this version have a GitHub release tag?" — a cheap legitimacy signal
 *  (real projects tag releases). Pure URL parsing + an injected fetch.
 *
 *  Auth: pass a token (GITHUB_TOKEN) to lift the rate limit from 60 to 5,000
 *  req/hr — essential for the overnight pre-warm. Without a repo, a non-GitHub
 *  repo, or an API error we return null ("not checked"), never 0 — a missing
 *  signal must not masquerade as a negative one. */

/** Parse "owner/repo" out of a repository URL. Returns null for non-GitHub. */
export function parseRepoSlug(url) {
  if (!url || typeof url !== 'string') return null;
  const cleaned = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
  const m = cleaned.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** 1 if a v-prefixed OR bare tag for `version` exists, 0 if neither, null if we
 *  couldn't check (no/!github repo, or API error). */
export async function hasGithubTag(repoUrl, version, { fetchImpl = fetch, token } = {}) {
  const slug = parseRepoSlug(repoUrl);
  if (!slug) return null;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'swpx-verdict' };
  if (token) headers.authorization = `Bearer ${token}`;

  for (const tag of [`v${version}`, version]) {
    let res;
    try {
      res = await fetchImpl(
        `https://api.github.com/repos/${slug.owner}/${slug.repo}/git/refs/tags/${encodeURIComponent(tag)}`,
        { headers },
      );
    } catch {
      return null; // network/transport error — unknown, not "no tag"
    }
    if (res.status === 200) return 1;
    if (res.status === 403 || res.status === 401 || res.status >= 500) return null; // rate-limited/auth/outage
    // 404 → this exact tag doesn't exist; try the next form.
  }
  return 0;
}
