# swpx verdict API (`server/`)

The backend for `swpx` / `swpm` (task **tsk_f30faf55**). It deploys to the
**`npm` somewhere.tech project** (npm.somewhere.tech) and is **NOT** part of the
`@somewhere-tech/cli` npm package — it lives in this repo only so the whole lane
reviews together. The CLI's `package.json` `files` allowlist excludes `server/`,
so publishing the CLI never ships this.

> **Not deployed yet.** Everything here is built + unit-tested offline. Deploying
> to the live `npm` project, setting secrets, and running the (paid) pre-warm are
> the morning steps — see the checklist below.

## What it is

A **verdict layer**, not a registry or mirror. npm's CDN serves the bytes; we
serve a verdict from D1. For one `package@version` we gather mechanical signals
(provenance, install scripts, readability, capabilities, GitHub tag, typosquat),
combine them with a stop-logic engine, and check live MAL advisories on top.

```
GET /api/verdict/:pkg/:version   → cache hit, or compute+cache, then LIVE MAL → verdict
POST /api/verdict/batch          → same for a resolved tree (swpm install)
POST /api/admin/prewarm          → compute+cache a slice of the top-N list (guarded)
```

MAL advisories are **never cached** (a version can be retroactively flagged), so
they run live on every request and only ever *escalate* a cached mechanical
verdict (→ blocked / suspicious).

## Files

| Path | What |
|---|---|
| `_lib/engine.mjs` | The verdict stop-logic (the CLI's contract). |
| `_lib/checks/*.mjs` | Pure detectors: capabilities, readability, manifest (scripts/provenance), typosquat. |
| `_lib/osv.mjs` `registry.mjs` `github.mjs` | Live-API glue (MAL, manifest/entry-source/downloads, tag-exists). |
| `_lib/compute.mjs` | Orchestrator: `computeMechanical` (cacheable) + `finalize` (live MAL merge). |
| `_lib/db.mjs` | D1 read/write + (de)serialization. |
| `_lib/resolve.mjs` | cache → compute → live MAL, shared by both routes. |
| `_lib/llm.mjs` | Description-match backfill (prompts + parser pure; `sw.ai` call flagged). |
| `_lib/prewarm.mjs` | Resumable pre-warm slice. |
| `api/verdict/[pkg]/[version].js` `api/verdict/batch.js` | The routes. |
| `api/admin/prewarm.js` | Guarded pre-warm trigger. |
| `migrations/0001_verdicts.sql` | The `verdicts` table. |

Every `_lib` module has a `*.test.mjs`. Run them: `cd server && npm test`
(node:test, no network). **145 tests pass.**

## Morning deploy checklist

1. **Confirm the `sw.ai` call shape.** `_lib/llm.mjs` `callModel()` is a best
   guess — verify against `docs({ topic: 'sw.ai' })` before any `enrich=1` run.
   (Mechanical verdicts don't need it; the LLM is async backfill only.)
2. **Apply the migration** to the `npm` project's database (`migrations/0001_verdicts.sql`).
3. **Set env / secrets** on the project:
   - `GITHUB_TOKEN` — for the tag-exists checks at 5,000 req/hr (the local
     `gh` CLI is authed as `uzihaq` with `repo`+`read:org`; `gh auth token`
     gives a usable token). Without it tag checks return `null` (degrade, not break).
   - `PREWARM_KEY` — secret for `POST /api/admin/prewarm`.
   - `TOP_PACKAGES_URL` *(optional)* — JSON list of names (or `{name,downloads}`)
     for the real top-10k; absent → a 16-package seed validates the pipeline.
   - npm read-only token *(optional)* — only speeds the crawl; the registry API
     works unauthenticated.
4. **Deploy** `server/` as the project root (`somewhere deploy` from `server/`).
   Smoke: `curl https://npm.somewhere.tech/api/verdict/left-pad/1.3.0`.
5. **Point the CLI at it** — the CLI already defaults to `https://npm.somewhere.tech`;
   no change needed. (Staging: `SWPX_VERDICT_URL`.)
6. **Pre-warm** — call `POST /api/admin/prewarm?offset=0&limit=50` repeatedly
   (bump `offset`) or wire a cron. Add `&enrich=1` only when you want the paid
   description-match backfill (~$1 across 10k per the spec budget).

## Known gaps (intentional, for the morning)

- **`sw.ai` shape** unverified (item 1 above). Pure prompt/parser are tested.
- **Live response shapes** (OSV vuln fields, npm manifest `dist.attestations`,
  GitHub refs) are coded to the documented shapes and unit-tested with fixtures,
  but the first live deploy should spot-check a real malware case
  (`@ctrl/tinycolor@4.1.1`) and a clean one (`create-next-app`).
- **Typosquat** runs only when a `popular` list is supplied (item 9 in the spec
  is post-MVP); the admin endpoint doesn't build one yet. Easy follow-up: derive
  it from `TOP_PACKAGES_URL` when it carries download counts.
- **Diff-review LLM** (spec item 8) is not built yet — engine already accepts a
  `diff_review` signal; the backfill that produces it is a follow-up.
