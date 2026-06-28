# swpx verdict API (`server/`) — LIVE

The backend for `swpx` / `swpm`. It is **deployed and live** at
**https://npm.somewhere.tech** (the `npm` somewhere.tech project). It is **NOT**
part of the `@somewhere-tech/cli` npm package — it lives in this repo only so the
work reviews together. The CLI's `package.json` `files` allowlist excludes
`server/`, so publishing the CLI never ships this.

> **This directory is the whole project — page AND API.** `index.html` is the
> landing page (npm.somewhere.tech); `api/` is the verdict API. They deploy
> together from here. `.somewhere.json` links this directory to the live project,
> so `somewhere deploy` needs no flags.

## What it is

A **verdict layer**, not a registry or mirror. npm's CDN serves the bytes; we
serve a verdict from D1. For one `package@version` we gather mechanical signals
(provenance, install scripts, readability, capabilities, GitHub tag, typosquat),
combine them with a stop-logic engine, and apply malware (MAL) advisories on top.

```
GET  /api/verdict/:pkg/:version  → cache hit, or compute+cache, then MAL → verdict
POST /api/verdict/batch          → same for a resolved tree (swpm install)
POST /api/prewarm                → compute+cache a slice of the top-N list (key-guarded)
POST /api/osv-refresh            → re-check the stalest MAL-cache rows (key-guarded; cron)
GET  /api/stats                  → usage rollup (key-guarded)
```

## Deploy — ONE command, from THIS directory

```
cd server
somewhere deploy .            # deploys page + functions together; removes nothing
```

- `.somewhere.json` resolves the project (`npm`), so **no `--project` flag needed**.
- Default scope deploys **both** the page and the functions. Everything in this
  dir is the source of truth, so nothing gets wiped.
- **Do NOT use `--scope functions` or `--scope static` alone** — each replaces only
  its half and DELETES the other half's files (this is how the page once lost its
  reference files). A full `somewhere deploy .` is the safe, normal path.
- Always preview first: `somewhere deploy . --dry-run`. If it lists anything under
  "Removed", stop and look — a clean deploy from here removes nothing.
- Deploys roll the warm pool (~5 min); the API may be briefly slow right after.
- Rollback: `somewhere project rollback` (or `project_rollback` MCP).

## Database migrations are MANUAL

**DDL does not run from `sw.db.query` inside functions** (CREATE/ALTER silently
no-op on this platform). The `migrations/*.sql` files are the record; you apply
them yourself with the developer CLI:

```
somewhere db query --project npm "<the SQL from the migration file>"
```

Applied migrations (all already live):

| File | Table |
|---|---|
| `0001_verdicts.sql` | `verdicts` (the mechanical-verdict cache) |
| `0002`–`0004` | author/summary cols, v2 signal cols, rate-limit table |
| `0005_metadata_usage.sql` | `metadata` JSON col on `verdicts`, `usage_daily` table |
| `0006_mal_cache.sql` | `mal_advisories` (the 60s MAL cache — see below) |

After adding a migration file, **apply it via `db query` before (or right after)
the deploy** — the code degrades gracefully if a table is missing, but the
feature stays off until the table exists.

## MAL (malware) advisory cache + the refresh cron

MAL advisories are the authoritative block signal. They used to be fetched live
from OSV on **every** verdict request (slow). Now:

- `_lib/mal-cache.mjs` caches the MAL result per `(package, version)` with a
  **60s TTL**. Hot path reads D1; OSV is hit at most once per package per minute.
  At most ~60s behind a brand-new advisory. On an OSV outage it serves
  last-known-recent advisories (keeps blocking known-bad) and only gives up when
  it has nothing usable — never a silent clean pass. Keyed independently of the
  npm manifest, so an unpublished malicious version is still blockable.
- `api/osv-refresh.js` re-checks the stalest cache rows; a **1-minute cron**
  (`osv-mal-refresh`, created via `cron_create`) drives it so the hot set stays
  fresh. It authenticates with **`OSV_REFRESH_KEY`** (a dedicated key, NOT
  `PREWARM_KEY` — `PREWARM_KEY` is in use by the `swpx-lazy-enrich` cron, so
  don't rotate it). Check it: `cron_list({ project_id: 'npm' })`.

## Env / secrets (set on the `npm` project; values are write-only)

| Key | Purpose |
|---|---|
| `GITHUB_TOKEN` | Tag-exists + repo-maintenance checks at 5,000 req/hr. Absent → those signals return `null` (degrade, not break). |
| `PREWARM_KEY` | Guards `POST /api/prewarm` + `/api/stats`. **In use by the `swpx-lazy-enrich` cron — do not rotate without updating that cron's payload.** |
| `OSV_REFRESH_KEY` | Guards `POST /api/osv-refresh` (the MAL refresh cron). |
| `PREWARM_PROVIDER` / `PREWARM_MODEL` | Override the enrich LLM (see below). |
| `TOP_PACKAGES_URL` | JSON list of names (or `{name,downloads}`) for the real top-N prewarm. **Absent → a 16-package seed**, not the real list. |

## Pre-warm (the paid enrich)

Mechanical verdicts are free. The **narrative + description-match** enrich is one
`sw.ai.chat` call per package (`_lib/llm.mjs` → `summarize`), default
`openai`/`gpt-5.4-mini` on the flex tier, overridable via
`PREWARM_PROVIDER`/`PREWARM_MODEL`. Paid models need one-time activation in the
dashboard (else enrich degrades to `null`; mechanical verdicts unaffected).

```
# mechanical only (free), resumable — bump offset until remaining = 0:
curl -X POST "https://npm.somewhere.tech/api/prewarm?offset=0&limit=50" \
     -H "content-type: application/json" -d '{"key":"<PREWARM_KEY>"}'

# add &enrich=1 for the paid narrative backfill.
```

`prewarmSlice` skips anything computed in the last 7 days, so re-runs are cheap.
Set `TOP_PACKAGES_URL` first or it runs the 16-package seed.

## Tests

Every `_lib` module has a `*.test.mjs` (node:test, no network):

```
cd server && node --test     # 195 pass
```

Test files live in `_lib/` and deploy as inert modules (nothing imports them at
runtime, so they're never compiled/routed) — harmless, just along for the ride.

## Known gaps (intentional)

- **Typosquat** runs only when a `popular` list is supplied; derive it from
  `TOP_PACKAGES_URL` when that carries download counts (follow-up).
- **Diff-review LLM** (version-to-version delta) is not built; the engine accepts
  a `diff_review` signal, the backfill that produces it is a follow-up.
- **Capability detection is a static over-approximation** — `network`/`fs`/
  `child_process` can match inside comments or string literals. It never drives a
  stop by itself; it's display + an LLM input. Comment/string-stripping is a
  follow-up.
- **Degraded entry-source caching**: if the manifest loads but the CDN entry-file
  fetch fails, capabilities/`is_minified` compute from empty source and cache.
  Self-heals on the `freshDays` recompute.
