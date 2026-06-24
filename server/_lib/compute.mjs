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

  if (!manifest) {
    // No manifest for THIS exact version — a 404 (version doesn't exist) or a
    // registry outage. Either way we cannot inspect it, and "could not inspect"
    // must NEVER become "verified" (invariant #4). Throw so the route returns
    // 502 and the CLI fails OPEN to plain npx, rather than vouching for a version
    // we never saw.
    throw new Error(`could not fetch manifest for ${name}@${version}`);
  }

  const source = await fetchEntrySource(name, version, manifest, { fetchImpl });
  const capabilities = detectCapabilities(source);
  // Only judge readability when we actually fetched source — a missing entry
  // file must not read as "minified" (that would be a false soft signal).
  const isMinified = source ? analyzeReadability(source).minified : false;
  const scripts = installScripts(manifest || {});
  const provenance = hasProvenance(manifest || {});
  const repo = provenanceRepo(manifest || {});
  const tag = await hasGithubTag(repo, version, { fetchImpl, token: githubToken });
  const typo = nearestTyposquat(name, downloads, popular);
  // Direct runtime dependencies — the attack surface a clean-looking package can
  // still pull in (a bad actor's own malicious dep). Names only here; the full
  // transitive verdict check is what `swpm install` does. Fed to the narrative.
  const dependencies =
    manifest.dependencies && typeof manifest.dependencies === 'object'
      ? Object.keys(manifest.dependencies)
      : [];

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
    dependencies,
    description_match: null,
    description_match_reason: null,
    diff_review: null,
    diff_review_reason: null,
    diff_from_version: null,
    weekly_downloads: downloads,
    known_cves: 0,
    compromised_history: [],
    dependency_flags: [],
    computed_at: now ?? new Date().toISOString(),
  };
}

/** A placeholder row for a version we could NOT inspect mechanically (manifest
 *  404 / registry outage) but which we still need to render — used only when a
 *  live MAL advisory exists, so finalize() escalates it to blocked/suspicious.
 *  All mechanical signals are unknown/safe defaults; never cached. */
export function minimalRow(name, version, now) {
  return {
    package: name,
    version,
    verdict: 'verified',
    verdict_signals: [],
    capabilities: [],
    has_provenance: false,
    provenance_repo: null,
    provenance_commit: null,
    is_minified: false,
    has_install_scripts: false,
    install_script_types: [],
    typosquat_of: null,
    typosquat_distance: null,
    has_github_tag: null,
    github_repo: null,
    publish_time: null,
    publisher: null,
    description: null,
    dependencies: [],
    description_match: null,
    description_match_reason: null,
    diff_review: null,
    diff_review_reason: null,
    diff_from_version: null,
    weekly_downloads: null,
    known_cves: 0,
    compromised_history: [],
    dependency_flags: [],
    computed_at: now ?? new Date().toISOString(),
  };
}

/** Merge a live MAL check onto a (cached or fresh) mechanical row. MAL only
 *  escalates: confirmed → blocked, unconfirmed → at least suspicious. The
 *  mechanical verdict stands when there's no MAL. */
export function finalize(row, mal) {
  const advisories = Array.isArray(mal) ? mal : [];
  // The engine needs each advisory's internal `sources` array (Amazon-only
  // confirmation rule), but that field is NOT part of the public advisory shape
  // ({ id, summary, disclosed, source, safe_versions }). Strip it before putting
  // advisories on the wire.
  const pub = advisories.map(({ sources, ...rest }) => rest);
  if (advisories.length === 0) return { ...row, mal: [] };

  const malOnly = computeVerdict({ mal: advisories });
  if (malOnly.verdict === 'blocked') {
    return { ...row, mal: pub, verdict: 'blocked', verdict_signals: malOnly.verdict_signals };
  }
  if (malOnly.verdict === 'suspicious') {
    const escalate = row.verdict === 'verified' || row.verdict === 'unverified';
    return {
      ...row,
      mal: pub,
      verdict: escalate ? 'suspicious' : row.verdict,
      verdict_signals: [...(row.verdict_signals ?? []), ...malOnly.verdict_signals],
    };
  }
  return { ...row, mal: pub };
}
