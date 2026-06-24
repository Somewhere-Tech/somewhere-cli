/** The verdict orchestrator: gather every signal for name@version and produce a
 *  verdict row. Split into two steps because MAL advisories are never cached
 *  (a version can be retroactively flagged):
 *
 *    computeMechanical()  — registry/CDN/GitHub signals + the mechanical verdict.
 *                           This is what gets cached in D1.
 *    finalize(row, mal)   — merge the LIVE MAL check on top of a cached row,
 *                           escalating to blocked/suspicious. Mechanical signals
 *                           are authoritative (so we never need to re-fetch on a
 *                           cache hit); MAL only escalates upward.
 *
 *  Every fetch is injected (opts.fetchImpl) so this is testable offline. */

import {
  fetchManifest,
  fetchPackument,
  fetchEntrySource,
  weeklyDownloads,
  publishTime,
} from './registry.mjs';
import { hasGithubTag } from './github.mjs';
import { detectCapabilities } from './checks/capabilities.mjs';
import { analyzeReadability } from './checks/readability.mjs';
import { installScripts, hasProvenance, provenanceRepo } from './checks/manifest.mjs';
import { nearestTyposquat } from './checks/typosquat.mjs';
import { computeVerdict } from './engine.mjs';

/** Gather all mechanical signals and the mechanical verdict (no MAL). */
export async function computeMechanical(name, version, opts = {}) {
  const { fetchImpl = fetch, githubToken, popular = [], now } = opts;

  const [manifest, packument, downloads] = await Promise.all([
    fetchManifest(name, version, { fetchImpl }).catch(() => null),
    fetchPackument(name, { fetchImpl }).catch(() => null),
    weeklyDownloads(name, { fetchImpl }),
  ]);

  const source = manifest ? await fetchEntrySource(name, version, manifest, { fetchImpl }) : '';
  const capabilities = detectCapabilities(source);
  // Only judge readability when we actually fetched source — a missing entry
  // file must not read as "minified" (that would be a false soft signal).
  const isMinified = source ? analyzeReadability(source).minified : false;
  const scripts = installScripts(manifest || {});
  const provenance = hasProvenance(manifest || {});
  const repo = provenanceRepo(manifest || {});
  const tag = await hasGithubTag(repo, version, { fetchImpl, token: githubToken });
  const typo = nearestTyposquat(name, downloads, popular);

  const { verdict, verdict_signals } = computeVerdict({
    mal: [],
    has_provenance: provenance,
    is_minified: isMinified,
    has_install_scripts: scripts.length > 0,
    description_match: null, // LLM backfill fills these later
    diff_review: null,
    typosquat: typo,
    has_github_tag: tag,
    weekly_downloads: downloads,
  });

  return {
    package: name,
    version,
    verdict,
    verdict_signals,
    capabilities,
    has_provenance: provenance,
    provenance_repo: provenance ? repo : null,
    provenance_commit: null,
    is_minified: isMinified,
    has_install_scripts: scripts.length > 0,
    install_script_types: scripts,
    typosquat_of: typo ? typo.of : null,
    typosquat_distance: typo ? typo.distance : null,
    has_github_tag: tag,
    github_repo: repo,
    publish_time: packument ? publishTime(packument, version) : null,
    publisher: manifest?._npmUser?.name ?? null,
    description: manifest?.description ?? null,
    description_match: null,
    description_match_reason: null,
    diff_review: null,
    diff_review_reason: null,
    diff_from_version: null,
    weekly_downloads: downloads,
    computed_at: now ?? new Date().toISOString(),
  };
}

/** Merge a live MAL check onto a (cached or fresh) mechanical row. MAL only
 *  escalates: confirmed → blocked, unconfirmed → at least suspicious. The
 *  mechanical verdict stands when there's no MAL. */
export function finalize(row, mal) {
  const advisories = Array.isArray(mal) ? mal : [];
  if (advisories.length === 0) return { ...row, mal: [] };

  const malOnly = computeVerdict({ mal: advisories });
  if (malOnly.verdict === 'blocked') {
    return { ...row, mal: advisories, verdict: 'blocked', verdict_signals: malOnly.verdict_signals };
  }
  if (malOnly.verdict === 'suspicious') {
    const escalate = row.verdict === 'verified' || row.verdict === 'unverified';
    return {
      ...row,
      mal: advisories,
      verdict: escalate ? 'suspicious' : row.verdict,
      verdict_signals: [...(row.verdict_signals ?? []), ...malOnly.verdict_signals],
    };
  }
  return { ...row, mal: advisories };
}
