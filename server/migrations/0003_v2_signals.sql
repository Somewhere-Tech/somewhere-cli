-- v2 advisory-history and dependency-cascade signals (tsk_f30faf55).
-- Stored as cache-row enrichments: current-version MAL remains live/uncached.
ALTER TABLE verdicts ADD COLUMN known_cves INTEGER;
ALTER TABLE verdicts ADD COLUMN compromised_history TEXT;
ALTER TABLE verdicts ADD COLUMN dependency_flags TEXT;
