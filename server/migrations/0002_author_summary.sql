-- Narrative summary + author reputation (tsk_f30faf55).
-- SQLite has no ADD COLUMN IF NOT EXISTS; run once. The summary is the LLM's
-- human-readable judgment; the author_* columns are the reputation ingredients
-- that feed it.
ALTER TABLE verdicts ADD COLUMN summary TEXT;
ALTER TABLE verdicts ADD COLUMN author_package_count INTEGER;
ALTER TABLE verdicts ADD COLUMN author_total_downloads INTEGER;
ALTER TABLE verdicts ADD COLUMN author_first_publish TEXT;
ALTER TABLE verdicts ADD COLUMN dependencies TEXT;
