/**
 * manifest.mjs — install-time signal extraction for the swpx/swpm "verdict layer".
 *
 * Pure ESM. No imports, no network, no node builtins, no dependencies.
 * Environment-agnostic (Cloudflare Workers + node:test) and fully synchronous.
 *
 * A "manifest" here is the JSON object the npm registry returns for ONE package
 * version (e.g. the value at `versions["1.2.3"]` of a packument, or the body of
 * `registry.npmjs.org/<pkg>/<version>`). Every function is defensive: garbage,
 * undefined, null, or wrong-typed input yields the documented safe default and
 * never throws.
 */

/**
 * The npm lifecycle scripts that run automatically at install time. These are
 * the only `scripts` keys that can execute arbitrary code on a consumer's
 * machine during `npm install` (`test`, `build`, etc. do NOT auto-run on
 * install and are intentionally excluded).
 * @type {readonly string[]}
 */
const INSTALL_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * Narrow an unknown value to a non-null, non-array plain object.
 * @param {unknown} v
 * @returns {boolean}
 */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Return the sorted subset of install-time lifecycle scripts that are present
 * with a truthy string value in `manifest.scripts`.
 *
 * Only `preinstall`, `install`, `postinstall`, and `prepare` are considered —
 * these are the scripts npm auto-runs at install time. Non-lifecycle scripts
 * (`test`, `build`, `start`, …) are ignored. A script key whose value is not a
 * truthy string (empty string, number, null, undefined, object) is treated as
 * absent.
 *
 * @param {unknown} manifest - npm version manifest object.
 * @returns {string[]} Sorted lifecycle script names present (e.g. ["postinstall", "preinstall"]). Empty array on missing/garbage input.
 */
export function installScripts(manifest) {
  if (!isObject(manifest)) return [];
  const scripts = manifest.scripts;
  if (!isObject(scripts)) return [];
  const present = [];
  for (const name of INSTALL_LIFECYCLE) {
    const val = scripts[name];
    if (typeof val === 'string' && val.length > 0) present.push(name);
  }
  // Sorted alphabetically for deterministic output.
  return present.sort();
}

/**
 * Whether the manifest declares any install-time lifecycle script.
 *
 * @param {unknown} manifest - npm version manifest object.
 * @returns {boolean} True iff at least one of preinstall/install/postinstall/prepare is present with a truthy string value.
 */
export function hasInstallScripts(manifest) {
  return installScripts(manifest).length > 0;
}

/**
 * Whether the manifest carries an npm provenance attestation.
 *
 * npm publishes provenance by attaching `dist.attestations` (an object with
 * `url` + `provenance`). We treat the presence of a non-null, truthy
 * `dist.attestations` value as the provenance signal — we do not require a
 * specific inner shape, only that the registry attached the attestations blob.
 *
 * @param {unknown} manifest - npm version manifest object.
 * @returns {boolean} True iff manifest.dist.attestations is present and non-null. False on missing/garbage input.
 */
export function hasProvenance(manifest) {
  if (!isObject(manifest)) return false;
  const dist = manifest.dist;
  if (!isObject(dist)) return false;
  const attestations = dist.attestations;
  // Non-null, non-undefined => provenance blob present. Objects, strings, etc.
  // all count; only null/undefined/false-y absence does not.
  return attestations !== null && attestations !== undefined && attestations !== false;
}

/**
 * Strip a leading `git+` scheme prefix and a trailing `.git` suffix from a
 * repository URL string, returning a normalized form. Whitespace is trimmed.
 * @param {string} url
 * @returns {string}
 */
function normalizeRepoUrl(url) {
  let out = url.trim();
  if (out.startsWith('git+')) out = out.slice(4);
  if (out.endsWith('.git')) out = out.slice(0, -4);
  return out;
}

/**
 * Best-effort repository URL for the package version — the repo a later step
 * would check a GitHub tag/release against.
 *
 * Resolution order:
 *   1. `manifest.repository.url` (string) — normalized.
 *   2. `manifest.repository` is itself a string — normalized.
 *   3. Otherwise `null`.
 *
 * Normalization strips a leading `git+` and a trailing `.git`. A purely
 * empty/blank source yields `null`.
 *
 * @param {unknown} manifest - npm version manifest object.
 * @returns {string | null} Normalized repository URL, or null if none resolvable.
 */
export function provenanceRepo(manifest) {
  if (!isObject(manifest)) return null;
  const repo = manifest.repository;
  if (isObject(repo)) {
    const url = repo.url;
    if (typeof url === 'string' && url.trim().length > 0) {
      return normalizeRepoUrl(url);
    }
    return null;
  }
  if (typeof repo === 'string' && repo.trim().length > 0) {
    return normalizeRepoUrl(repo);
  }
  return null;
}
