/** Shared types for the swpx / swpm verdict layer.
 *
 *  The verdict API lives on the `npm` platform project (npm.somewhere.tech),
 *  NOT the /v1 control plane. It is unauthenticated (free, no login) — the CLI
 *  hits it with a plain fetch, independent of `somewhere login`. See
 *  verdict-client.ts.
 *
 *  The `Verdict` shape mirrors the D1 `verdicts` row (tsk_f30faf55) plus the
 *  live MAL advisory check, which is NOT cached (a version can be retroactively
 *  flagged). The `--json` output is a stable PROJECTION of this (toJsonVerdict)
 *  — that projection is the public contract shown on npm.somewhere.tech, so it
 *  is intentionally narrower than the internal row. */

export type VerdictLevel = 'verified' | 'unverified' | 'suspicious' | 'blocked';

/** A live OSV / GitHub-Advisory malware advisory for this exact version. */
export interface MalAdvisory {
  /** e.g. "MAL-2025-09-384". */
  id: string;
  /** One-line human summary, e.g. "credential-harvesting via preinstall hook". */
  summary?: string;
  /** Disclosure date as shown to the user, e.g. "2025-09-15". */
  disclosed?: string;
  /** Attribution, e.g. "OpenSSF / OSV". */
  source?: string;
  /** Known-safe versions of the same package, e.g. ["4.0.0", "4.2.0"]. */
  safe_versions?: string[];
}

/** Past package compromise across any version (cached enrich signal). */
export interface CompromisedHistory {
  id: string;
  /** Published date, normalized by the backend as YYYY-MM-DD when known. */
  published?: string;
}

/** Cached dependency verdict that cascaded into the parent package. */
export interface DependencyFlag {
  name: string;
  version: string;
  verdict: VerdictLevel;
}

/** Full verdict for one package@version as returned by the verdict API. Every
 *  signal field is optional so the renderers degrade gracefully on a partial
 *  payload (e.g. a cache row written before the LLM backfill ran). */
export interface Verdict {
  package: string;
  version: string;
  verdict: VerdictLevel;
  /** Names of the signals that drove the verdict (backend's stop logic). */
  verdict_signals?: string[];
  /** ["network", "fs", "child_process", "process.env"] — empty = no system access. */
  capabilities?: string[];
  has_provenance?: boolean;
  provenance_commit?: string | null;
  provenance_repo?: string | null;
  is_minified?: boolean;
  has_install_scripts?: boolean;
  install_script_types?: string[];
  typosquat_of?: string | null;
  typosquat_distance?: number | null;
  /** 1 = tag exists, 0 = no tag, null = not checked / no repo. */
  has_github_tag?: 0 | 1 | null;
  github_repo?: string | null;
  publish_time?: string | null;
  publisher?: string | null;
  weekly_downloads?: number | null;
  description?: string | null;
  description_match?: 'match' | 'mismatch' | 'unclear' | null;
  description_match_reason?: string | null;
  diff_review?: 'clean' | 'suspicious' | 'unexplained' | null;
  diff_review_reason?: string | null;
  diff_from_version?: string | null;
  /** Live MAL advisories for this version (uncached). Empty/absent = none. */
  mal?: MalAdvisory[];
  /** Direct runtime dependency names (from the manifest). */
  dependencies?: string[];
  /** Count of historical CVE/GHSA advisories across all versions. */
  known_cves?: number | null;
  /** Historical MAL advisories across all versions. */
  compromised_history?: CompromisedHistory[];
  /** Direct dependencies with cached non-verified verdicts. */
  dependency_flags?: DependencyFlag[];
  /** The LLM's human-readable judgment (enrich backfill). */
  summary?: string | null;
  /** Author reputation ingredients (enrich backfill) — feed the narrative. */
  author_package_count?: number | null;
  author_total_downloads?: number | null;
  author_first_publish?: string | null;
  /** SPDX license id from the manifest, e.g. "MIT". null = unlicensed/unknown. */
  license?: string | null;
  /** True if THIS version's publisher differs from the previous version's (an
   *  account-takeover tell); false = same publisher; null = couldn't determine. */
  maintainer_changed?: boolean | null;
  /** The publisher of the previous version (shown when maintainer_changed). */
  previous_publisher?: string | null;
  /** Source-repo maintenance (GitHub): archived flag, last push, open issues. */
  repo_archived?: boolean | null;
  repo_last_commit?: string | null;
  repo_open_issues?: number | null;
  /** 'proven' when provenance cryptographically links repo↔package, else
   *  'unverified'. Surfaced via the provenance row + the repo link. */
  publisher_repo_match?: 'proven' | 'unverified' | null;
  /** Dependency-tree breakdown counts (enrich): cached-verified, and not-yet-
   *  cached ("unknown"). dependency_flags carries the non-verified ones. */
  dep_verified?: number | null;
  dep_unknown?: number | null;
  computed_at?: string;
}

/** The stable `--json` projection (the contract on the landing page). */
export interface JsonSignals {
  provenance: boolean;
  readable: boolean;
  install_scripts: string[];
  capabilities: string[];
  description_match: boolean;
  mal_advisories: string[];
  typosquat_distance: number | null;
  age_hours: number | null;
}

export interface JsonVerdict {
  package: string;
  version: string;
  verdict: VerdictLevel;
  signals: JsonSignals;
}

/** What the CLI does with a verdict before touching the real npm/npx:
 *  - run:   verified — delegate to the real tool.
 *  - stop:  unverified / suspicious — show evidence, let the user override.
 *  - block: blocked — confirmed malware, hard refuse. */
export type Action = 'run' | 'stop' | 'block';
