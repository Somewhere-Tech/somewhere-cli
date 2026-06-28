-- Short-TTL cache of MAL (malware) advisories per (package, version), so the
-- verdict hot path reads D1 instead of a live OSV round-trip on every request.
-- The 60s freshness bound on the block signal is enforced in code (mal-cache.mjs);
-- this table is just the store. `advisories` is a JSON array of parsed advisories
-- (sources included). `checked_at` is the ISO time of the last successful OSV check.
--
-- DDL is not permitted from sw.db.query inside functions on this platform, so this
-- is applied out-of-band via `somewhere db query --project npm`.
CREATE TABLE IF NOT EXISTS mal_advisories (
  package    TEXT NOT NULL,
  version    TEXT NOT NULL,
  advisories TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (package, version)
);
