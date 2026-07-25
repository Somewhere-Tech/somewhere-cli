/** The verdict engine — the heart of swpx (task tsk_f30faf55).
 *
 *  Takes the signals gathered for one package@version and returns the verdict
 *  LEVEL and the list of signals that drove it. This is the contract the CLI
 *  renders against, so the four levels map exactly to the CLI's display:
 *    blocked     → red hard-block (confirmed malware).
 *    suspicious  → yellow evidence block (strong single signal).
 *    unverified  → yellow evidence block ("could not verify").
 *    verified    → green one-liner.
 *
 *  Design rule that this file MUST honour (platform CLAUDE.md rule 9 — no
 *  guardrail blocks normal code): a SINGLE soft signal is never enough to stop a
 *  package. Most of npm has no provenance; flagging all of it would block the
 *  world. Stopping (unverified) needs TWO independent soft signals, matching the
 *  spec's "2 or more of" threshold. The landing-page examples are the fixtures:
 *  create-next-app (network+fs+child_process, has provenance, desc matches) is
 *  VERIFIED; is-odd (no provenance, nothing else) is VERIFIED; some-analytics-
 *  tool (no provenance + minified + install scripts + desc mismatch) is stopped.
 */

/** An MAL advisory attributed only to Amazon Inspector is treated as
 *  unconfirmed: that single source produced 157 false positives in May 2026, so
 *  it warns rather than hard-blocks. Any other (or additional) source confirms. */
function isAmazonOnly(adv) {
  const sources = Array.isArray(adv?.sources) ? adv.sources.map((s) => String(s).toLowerCase()) : [];
  return sources.length > 0 && sources.every((s) => s.includes('amazon') || s.includes('inspector'));
}

/**
 * @param {object} s signals
 * @param {Array<{id:string, sources?:string[]}>} [s.mal] live MAL advisories
 * @param {boolean} [s.has_provenance]
 * @param {boolean} [s.is_minified]
 * @param {boolean} [s.has_install_scripts]
 * @param {'match'|'mismatch'|'unclear'|null} [s.description_match] (LLM, may be absent)
 * @param {'clean'|'suspicious'|'unexplained'|null} [s.diff_review] (LLM, may be absent)
 * @param {{of:string, distance:number}|null} [s.typosquat]
 * @param {0|1|null} [s.has_github_tag]
 * @param {number|null} [s.weekly_downloads]
 * @returns {{verdict:'verified'|'unverified'|'suspicious'|'blocked', verdict_signals:string[]}}
 */
export function computeVerdict(s = {}) {
  const mal = Array.isArray(s.mal) ? s.mal : [];

  // 1) BLOCKED — a confirmed MAL advisory for this exact version.
  const confirmed = mal.filter((m) => m && m.id && !isAmazonOnly(m));
  if (confirmed.length) {
    return { verdict: 'blocked', verdict_signals: confirmed.map((m) => m.id) };
  }

  // 2) SUSPICIOUS — a strong single signal: an unconfirmed advisory, a typosquat,
  //    or an LLM diff review that flagged the version-to-version change.
  const strong = [];
  for (const m of mal) if (m && m.id && isAmazonOnly(m)) strong.push(`mal_unconfirmed:${m.id}`);
  if (s.typosquat && s.typosquat.of) strong.push('typosquat');
  if (s.diff_review === 'suspicious' || s.diff_review === 'unexplained') strong.push(`diff_${s.diff_review}`);
  if (strong.length) return { verdict: 'suspicious', verdict_signals: strong };

  // 3) UNVERIFIED — soft evidence.
  //    (description_mismatch is LLM-derived; absent until the backfill runs.)
  //
  //    RULE 9 (no guardrail blocks legitimate code): `no_provenance`,
  //    `minified` and `no_github_tag` are all ubiquitous — most of npm has no
  //    provenance, many perfectly good packages ship a bundled/minified entry,
  //    and monorepos / CI release flows routinely never push a `v<version>`
  //    tag. These PASSIVE signals, in any combination, must NOT stop a package,
  //    or we'd warn on a huge slice of normal popular installs. So we require
  //    BOTH: two-or-more evidence signals AND at least one ACTIVE signal (an
  //    install script, or an LLM-confirmed description mismatch) — something the
  //    package is actually DOING, not just something it lacks.
  const evidence = [];
  if (s.has_provenance === false) evidence.push('no_provenance');
  if (s.is_minified) evidence.push('minified');
  if (s.has_install_scripts) evidence.push('install_scripts');
  if (s.description_match === 'mismatch') evidence.push('description_mismatch');
  // A missing GitHub release tag is the WEAKEST, most PASSIVE proxy of all: its
  // absence means "a release process we don't recognise", not risk. It may add
  // to the evidence count but can NEVER stop a package on its own. And a
  // cryptographic build attestation (provenance) is a STRONGER origin proof
  // than any git tag, so a package that HAS provenance is never docked for a
  // missing tag at all — the attestation already answers "where did this come
  // from?" better than a tag ever could.
  if (s.has_github_tag === 0 && s.has_provenance !== true) evidence.push('no_github_tag');
  const ACTIVE = new Set(['install_scripts', 'description_mismatch']);
  const hasActive = evidence.some((e) => ACTIVE.has(e));
  if (evidence.length >= 2 && hasActive) {
    return { verdict: 'unverified', verdict_signals: evidence };
  }

  // 4) VERIFIED — nothing tripped the threshold.
  return { verdict: 'verified', verdict_signals: [] };
}

/** Apply dependency cascade: a parent inherits the worst cached dependency
 *  verdict found during ENRICH. Dependency "unverified" is treated as at least
 *  suspicious for the parent because installing the parent also installs the
 *  flagged child. */
export function cascadeVerdict(parentVerdict, depVerdicts = []) {
  const verdicts = Array.isArray(depVerdicts) ? depVerdicts : [];
  if (verdicts.includes('blocked')) return 'blocked';
  if (verdicts.includes('suspicious') || verdicts.includes('unverified')) {
    return parentVerdict === 'blocked' ? 'blocked' : 'suspicious';
  }
  return parentVerdict;
}
