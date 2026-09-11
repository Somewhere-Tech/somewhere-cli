# `somewhere browser <url>` default (EYES) reported 0 interactive elements — pfb_57c43192d553

Branch: `sessions/cli-eyes-dom` (from `master` @ 5915315, 0.32.2). Not published, not pushed.

## Reviewer command

Exact command the reviewer ran, and what it prints now (run against the live
platform from this branch's build, 2026-09-11):

```
$ node dist/index.js browser https://example.com          # == `somewhere browser https://example.com`
PASS https://example.com/
console_errors: 0
page_errors: 0
failed_requests: 0
dom: 1 interactive element
screenshot: page — captured inline (image bytes — not shown in the terminal; re-run with --store for a viewable link, or --json for the base64)

$ node dist/index.js browser --url https://example.com --snapshot
PASS https://example.com/
console_errors: 0
page_errors: 0
failed_requests: 0
dom: 1 interactive element
screenshot: page — captured inline (…)
dom: a div > p:nth-of-type(2) > a [visible] "Learn more"
```

On 0.32.2 the first command printed `dom: 0 interactive elements` while the
second printed `dom: 1 interactive element`. Reproduced on this checkout before
the fix.

Rich control page (two inputs, a textarea, three buttons, one hidden):

```
$ node dist/index.js browser https://notes-authenticated-retry-20260911.somewhere.site
PASS https://notes-authenticated-retry-20260911.somewhere.site/
dom: 7 interactive elements            # --snapshot on the same URL lists exactly 7 map lines
```

VERIFY mode (`--project npm-probe-20260911`) still answers, and prints
`dom: 0 interactive elements` — that page genuinely has no controls, and the
response carried the (empty) map, which is why it is still reported as a count.

## Root cause

Two halves of one seam, confirmed on the wire before any code was changed:

1. **The request never asked for the map.** `buildBrowserBody`
   (`src/commands/browser.ts`) added `dom` to the `include` array *only* when
   `--snapshot` was passed. The live platform returns the DOM section only when
   it is asked for — a bare `{"url": "https://example.com"}` call comes back
   with **no `dom_outline` key at all**, while the same call with
   `include: ["dom"]` returns the one link example.com has:

   ```
   $ node dist/index.js browser https://example.com --json | keys
   console_errors, page_errors, failed_requests, steps, screenshots,
   accessibility_layout, rendered_text, final_url, passed, environment, …   # no dom_outline
   $ node dist/index.js browser https://example.com --include dom --json
   dom_outline: [{"tag":"a","text":"Learn more","selector":"div > p:nth-of-type(2) > a","visible":true}]
   ```

   (`accessibility_layout` is a prose advisory string, not a DOM summary — no
   map was already being returned under another name.)

2. **The formatter turned "absent" into "zero".** `formatBrowserReport` did
   `const dom = r.dom_outline ?? []` and then unconditionally printed
   `dom: ${dom.length} interactive element(s)`. A section that was never
   requested, never returned, or that failed to collect therefore rendered as
   the factual claim *"this page has 0 interactive controls"*.

The default report prints the count, so the default request has to ask for the
map — the rule `--snapshot` already followed since tsk_bdd72f02c2. That earlier
fix repaired the `--snapshot` path only and left the default path claiming zero.

## Fix

`src/commands/browser.ts`

- `buildBrowserBody` now adds `dom` to `include` on **every** call (added after
  the `--include` CSV, so an explicit `--include network,dom` keeps its order
  and nothing duplicates). `--snapshot`'s own add is now covered by this.
- `formatBrowserReport` distinguishes the three states:
  - map present → `dom: N interactive element(s)` (unchanged, `0` included);
  - map absent with a known reason → `dom: unavailable (<reason>)`;
  - map absent with no reason → `dom: not read (the response carried no
    interactive-element map — this is not a count of zero)`.
  `--snapshot` prints map lines only when there is a map.
- `BrowserResult` gained `dom_error?: string`; `--include`'s help says the DOM
  map is always requested so `dom` there is redundant.

`src/lib/browser-run.ts` (local loopback browser) — same false claim, other
seam: when the vendored DOM probe threw, the report kept `dom_outline: []` and
printed `dom: 0 interactive elements` next to the probe's own console error. It
now leaves `dom_outline` undefined and sets `dom_error`, so the run says
`dom: unavailable (DOM probe failed: …)`. `dom_outline` on `LocalBrowserReport`
is therefore optional; no consumer read it as required (`verify.ts` does not
read it at all).

No change to `--snapshot` output, to the exit-code contract, or to the VERIFY
flow.

## Tests

New/updated in `test/browser.test.mjs`. Its mock platform now mirrors the
confirmed live behaviour — it returns `dom_outline` **only** when the request
body's `include` contains `dom` — so a call that forgets to ask fails here
instead of only in production.

Both directions, per the brief:

1. `default EYES prints the real interactive-element count` — bare
   `browser https://example.com` against a stub holding one element prints
   `dom: 1 interactive element` (and the request asked for `dom`).
2. `default EYES says the DOM was not read rather than claiming zero` — stub
   returns no DOM section even when asked (an older platform): output matches
   `^dom: not read` and never `interactive element`.
3. `default EYES still reports a genuinely empty page as zero` — stub returns
   `dom_outline: []` → `dom: 0 interactive elements`.
4. `--snapshot` fixtures (`--snapshot requests the DOM section`, `… alongside
   steps`, `… merges with --include without duplicating`, `--snapshot prints the
   full DOM map`) are unchanged and green.
5. `--project` VERIFY fixtures (`existing --wait/--eval/--screenshot
   combinations remain on the legacy step contract`) unchanged and green.

Formatter units: missing map → not read; empty map → zero; `dom_error` →
`unavailable (<reason>)`; `--snapshot` on a missing map prints no map lines.

**Fixtures deliberately changed** (they encoded the defect — the default request
body carried no `include`):

- `test/browser.test.mjs`: `without --snapshot the DOM section stays opt-in` →
  `the default report asks for the DOM section`; the `buildBrowserBody`
  target-precedence `deepEqual`s and the `request shape` body now carry
  `include: ['dom']`; `--include markdown` now yields `['markdown', 'dom']`.
- `test/json-output.test.mjs`: the asserted default browser body is now
  `{ url, include: ['dom'] }`.

## Verification

Repo gates: `npm test` = `tsc` (typecheck/build) + `node --test test/*.test.mjs`.
There is no lint script or lint config in this repo.

```
$ npm test            # in a space-free checkout of this branch
ℹ tests 474
ℹ pass 473
ℹ fail 0
ℹ skipped 1
```

Baseline at `master` (5915315) in the same space-free checkout: 467 tests,
466 pass, 0 fail, 1 skipped.

**Environment note:** run the suite from a path with **no spaces**. This
worktree lives under `/Volumes/Extreme Pro/…`, and eight pre-existing tests
(`test/agent-neutral-copy.test.mjs`, `test/platform-help.test.mjs`,
`test/http-proxy.test.mjs`) build filesystem paths from `import.meta.url`
without `fileURLToPath`, so the `%20` breaks them. They fail identically at
`master` in this worktree and pass at `master` in `/tmp`, i.e. they are
path-sensitive, not related to this change. Not fixed here (out of lane).
