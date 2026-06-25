-- Rate-limit buckets for the public verdict API (tsk_f30faf55).
-- One self-resetting row per caller (IP or key hash); see _lib/ratelimit.mjs.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
