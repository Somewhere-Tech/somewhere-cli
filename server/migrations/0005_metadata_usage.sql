-- 0005 — extended signal storage + usage counters.
--
-- `metadata` (JSON) on verdicts holds the signals added after v2: license,
-- maintainer-change (previous_publisher + maintainer_changed), repo maintenance
-- (archived / last_commit / open_issues), publisher↔repo match, and the
-- dependency breakdown counts (dep_verified / dep_unknown). `usage_daily` counts
-- verdict requests + 429s per day, split by source (web checker vs CLI).
--
-- APPLIED to the live `npm` project DB via `somewhere db query` on 2026-06-27.
-- DDL issued from a function's `sw.db` is rejected on this platform. THIS FILE
-- is the source of truth and what a fresh DB needs; request handlers assume it
-- has been applied and never attempt schema changes.
-- (ALTER ADD COLUMN is not idempotent; run once on a fresh DB.)

ALTER TABLE verdicts ADD COLUMN metadata TEXT;

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'cli',
  requests INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);
