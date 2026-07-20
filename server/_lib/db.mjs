/** D1 cache for verdict rows (sw.db). MAL advisories are deliberately NOT stored
 *  — they're re-checked live on every request (see compute.finalize). JSON
 *  columns (arrays) are stringified on write and parsed on read; rowToVerdict is
 *  pure so the (de)serialization round-trip is unit-tested without a database. */

/** Map a raw D1 row to the verdict shape the API returns (and the CLI renders). */
export function rowToVerdict(row) {
  const json = (s) => {
    if (Array.isArray(s)) return s;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const intOrNull = (x) => (x === null || x === undefined ? null : Number(x));
  let meta = {};
  try { meta = JSON.parse(row.metadata) || {}; } catch { /* null / no metadata column yet */ }
  return {
    package: row.package,
    version: row.version,
    verdict: row.verdict,
    verdict_signals: json(row.verdict_signals) ?? [],
    capabilities: json(row.capabilities) ?? [],
    has_provenance: !!row.has_provenance,
    provenance_commit: row.provenance_commit ?? null,
    provenance_repo: row.provenance_repo ?? null,
    is_minified: !!row.is_minified,
    has_install_scripts: !!row.has_install_scripts,
    install_script_types: json(row.install_script_types) ?? [],
    typosquat_of: row.typosquat_of ?? null,
    typosquat_distance: intOrNull(row.typosquat_distance),
    has_github_tag: intOrNull(row.has_github_tag),
    github_repo: row.github_repo ?? null,
    publish_time: row.publish_time ?? null,
    publisher: row.publisher ?? null,
    description: row.description ?? null,
    description_match: row.description_match ?? null,
    description_match_reason: row.description_match_reason ?? null,
    diff_review: row.diff_review ?? null,
    diff_review_reason: row.diff_review_reason ?? null,
    diff_from_version: row.diff_from_version ?? null,
    weekly_downloads: intOrNull(row.weekly_downloads),
    summary: row.summary ?? null,
    author_package_count: intOrNull(row.author_package_count),
    author_total_downloads: intOrNull(row.author_total_downloads),
    author_first_publish: row.author_first_publish ?? null,
    dependencies: json(row.dependencies) ?? [],
    known_cves: intOrNull(row.known_cves) ?? 0,
    compromised_history: json(row.compromised_history) ?? [],
    dependency_flags: json(row.dependency_flags) ?? [],
    license: meta.license ?? null,
    publisher_repo_match: meta.publisher_repo_match ?? null,
    maintainer_changed: meta.maintainer_changed ?? null,
    previous_publisher: meta.previous_publisher ?? null,
    repo_archived: meta.repo_archived ?? null,
    repo_last_commit: meta.repo_last_commit ?? null,
    repo_open_issues: meta.repo_open_issues ?? null,
    dep_verified: meta.dep_verified ?? null,
    dep_unknown: meta.dep_unknown ?? null,
    computed_at: row.computed_at,
  };
}

/** The INSERT column order (also the VALUES order). */
const INSERT_COLUMNS = [
  'package', 'version', 'computed_at', 'has_provenance', 'provenance_commit', 'provenance_repo',
  'has_install_scripts', 'install_script_types', 'is_minified', 'capabilities', 'typosquat_of',
  'typosquat_distance', 'has_github_tag', 'github_repo', 'publish_time', 'publisher', 'description',
  'description_match', 'description_match_reason', 'diff_review', 'diff_review_reason',
  'diff_from_version', 'weekly_downloads', 'verdict', 'verdict_signals',
  'summary', 'author_package_count', 'author_total_downloads', 'author_first_publish', 'dependencies',
  'known_cves', 'compromised_history', 'dependency_flags', 'metadata',
];

const INSERT_SQL = `INSERT OR REPLACE INTO verdicts
  (${INSERT_COLUMNS.join(', ')})
  VALUES (${INSERT_COLUMNS.map(() => '?').join(',')})`;

/** Build the positional params for INSERT from a verdict row (pure, testable). */
export function verdictToParams(v) {
  const b = (x) => (x ? 1 : 0);
  const jb = (x) => JSON.stringify(x ?? []);
  return [
    v.package,
    v.version,
    v.computed_at,
    b(v.has_provenance),
    v.provenance_commit ?? null,
    v.provenance_repo ?? null,
    b(v.has_install_scripts),
    jb(v.install_script_types),
    b(v.is_minified),
    jb(v.capabilities),
    v.typosquat_of ?? null,
    v.typosquat_distance ?? null,
    v.has_github_tag ?? null,
    v.github_repo ?? null,
    v.publish_time ?? null,
    v.publisher ?? null,
    v.description ?? null,
    v.description_match ?? null,
    v.description_match_reason ?? null,
    v.diff_review ?? null,
    v.diff_review_reason ?? null,
    v.diff_from_version ?? null,
    v.weekly_downloads ?? null,
    v.verdict,
    jb(v.verdict_signals),
    v.summary ?? null,
    v.author_package_count ?? null,
    v.author_total_downloads ?? null,
    v.author_first_publish ?? null,
    jb(v.dependencies),
    v.known_cves ?? 0,
    jb(v.compromised_history),
    jb(v.dependency_flags),
    JSON.stringify({
      license: v.license ?? null,
      publisher_repo_match: v.publisher_repo_match ?? null,
      maintainer_changed: v.maintainer_changed ?? null,
      previous_publisher: v.previous_publisher ?? null,
      repo_archived: v.repo_archived ?? null,
      repo_last_commit: v.repo_last_commit ?? null,
      repo_open_issues: v.repo_open_issues ?? null,
      dep_verified: v.dep_verified ?? null,
      dep_unknown: v.dep_unknown ?? null,
    }),
  ];
}

export async function readVerdict(sw, name, version) {
  const r = await sw.db.query('SELECT * FROM verdicts WHERE package = ? AND version = ?', [name, version]);
  const row = r?.data?.[0];
  return row ? rowToVerdict(row) : null;
}

export async function writeVerdict(sw, v) {
  await sw.db.query(INSERT_SQL, verdictToParams(v));
}
