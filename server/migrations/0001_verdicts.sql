-- swpx / swpm verdict cache (tsk_f30faf55).
-- One row per package@version. MAL advisories are NOT stored here — they are
-- checked live against OSV on every request (a version can be retroactively
-- flagged), so caching them would be unsafe.
CREATE TABLE IF NOT EXISTS verdicts (
  package TEXT NOT NULL,
  version TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  has_provenance INTEGER NOT NULL DEFAULT 0,
  provenance_commit TEXT,
  provenance_repo TEXT,
  has_install_scripts INTEGER NOT NULL DEFAULT 0,
  install_script_types TEXT,          -- JSON array
  is_minified INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT,                  -- JSON array: ["network","fs","child_process","process.env"]
  typosquat_of TEXT,
  typosquat_distance INTEGER,
  has_github_tag INTEGER,             -- 1 / 0 / NULL (not checked)
  github_repo TEXT,
  publish_time TEXT,
  publisher TEXT,
  description TEXT,
  description_match TEXT,             -- "match" | "mismatch" | "unclear" | NULL  (LLM backfill)
  description_match_reason TEXT,
  diff_review TEXT,                   -- "clean" | "suspicious" | "unexplained" | NULL (LLM backfill)
  diff_review_reason TEXT,
  diff_from_version TEXT,
  weekly_downloads INTEGER,           -- popularity at compute time (typosquat / no-tag gating)
  verdict TEXT NOT NULL,              -- "verified" | "unverified" | "suspicious" | "blocked" (mechanical; MAL escalates at read)
  verdict_signals TEXT,              -- JSON array of triggered signal names
  PRIMARY KEY (package, version)
);
CREATE INDEX IF NOT EXISTS idx_verdicts_package ON verdicts(package);
CREATE INDEX IF NOT EXISTS idx_verdicts_verdict ON verdicts(verdict);
