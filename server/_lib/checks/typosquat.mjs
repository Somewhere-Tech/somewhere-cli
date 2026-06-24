/**
 * typosquat.mjs — verdict-layer helpers for detecting a likely typosquat of a
 * popular npm package.
 *
 * Pure ES module: no imports, no network, no node builtins, no dependencies.
 * Environment-agnostic (Cloudflare Workers + node:test) and fully synchronous.
 */

/**
 * Classic Levenshtein edit distance (insertions, deletions, substitutions),
 * computed with an iterative single-row dynamic-programming table.
 *
 * Defensive: non-string / null / undefined inputs are coerced to "" so the
 * function never throws on garbage. `levenshtein('', x) === x.length`.
 *
 * @param {string} a First string.
 * @param {string} b Second string.
 * @returns {number} The minimum number of single-character edits to turn `a`
 *   into `b`. Always a non-negative integer.
 */
export function levenshtein(a, b) {
  // Coerce anything non-string to a safe empty string.
  const s = typeof a === 'string' ? a : '';
  const t = typeof b === 'string' ? b : '';

  const n = s.length;
  const m = t.length;

  if (n === 0) return m;
  if (m === 0) return n;

  // Single-row DP. `prev[j]` is the distance for the previous source prefix.
  let prev = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  let curr = new Array(m + 1);
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      // deletion, insertion, substitution
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      let min = del < ins ? del : ins;
      if (sub < min) min = sub;
      curr[j] = min;
    }
    // Swap the two row buffers for the next iteration (no reallocation).
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[m];
}

/**
 * @typedef {Object} PopularPackage
 * @property {string} name Package name.
 * @property {number} downloads Weekly download count.
 */

/**
 * @typedef {Object} TyposquatMatch
 * @property {string} of   The popular package this name appears to typosquat.
 * @property {number} distance Edit distance from `name` to that package (1 or 2).
 */

/**
 * Find the most likely typosquat target for `name` among a list of popular
 * packages.
 *
 * A candidate qualifies only when ALL of the following hold:
 *   - it is NOT the exact same name as `name` (distance 0 is skipped),
 *   - its edit distance from `name` is 1 or 2 (3+ is ignored),
 *   - it is MUCH more popular than this package:
 *       target.downloads >= 100 * (selfWeeklyDownloads || 0),
 *     and when `selfWeeklyDownloads` is null/undefined/0/negative, the bar
 *     falls back to a fixed floor: target.downloads >= 100000.
 *
 * Among qualifying candidates the result is the one with the SMALLEST
 * distance; ties are broken by HIGHEST downloads.
 *
 * Defensive: a falsy `name`, a non-array / empty `popular`, or malformed
 * candidate rows never throw — they yield `null` (the safe default).
 *
 * @param {string} name The package name being evaluated.
 * @param {number|null|undefined} selfWeeklyDownloads This package's own weekly
 *   downloads (drives the relative-popularity bar).
 * @param {PopularPackage[]} popular Array of well-known packages.
 * @returns {TyposquatMatch|null} The nearest qualifying typosquat target, or
 *   `null` when nothing qualifies.
 */
export function nearestTyposquat(name, selfWeeklyDownloads, popular) {
  // Guard: falsy/non-string name, or empty/non-array popular list.
  if (!name || typeof name !== 'string') return null;
  if (!Array.isArray(popular) || popular.length === 0) return null;

  // Relative-popularity threshold. A target must clear this download count.
  // selfWeeklyDownloads null/undefined/0/negative/NaN -> fixed 100000 floor.
  const self =
    typeof selfWeeklyDownloads === 'number' &&
    isFinite(selfWeeklyDownloads) &&
    selfWeeklyDownloads > 0
      ? selfWeeklyDownloads
      : 0;
  const threshold = self > 0 ? 100 * self : 100000;

  /** @type {TyposquatMatch|null} */
  let best = null;
  let bestDownloads = -Infinity;

  for (let i = 0; i < popular.length; i++) {
    const cand = popular[i];
    if (!cand || typeof cand !== 'object') continue;

    const candName = cand.name;
    if (typeof candName !== 'string' || candName.length === 0) continue;

    // Skip the package's own name (distance 0).
    if (candName === name) continue;

    const downloads =
      typeof cand.downloads === 'number' && isFinite(cand.downloads)
        ? cand.downloads
        : 0;

    // Must be MUCH more popular than this package.
    if (downloads < threshold) continue;

    const dist = levenshtein(name, candName);
    // Only edit distance 1 or 2 counts as a typosquat candidate.
    if (dist < 1 || dist > 2) continue;

    // Pick smallest distance; break ties by highest downloads.
    if (
      best === null ||
      dist < best.distance ||
      (dist === best.distance && downloads > bestDownloads)
    ) {
      best = { of: candName, distance: dist };
      bestDownloads = downloads;
    }
  }

  return best;
}
