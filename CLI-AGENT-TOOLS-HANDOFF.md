# Handoff: CLI exposure of the agent-native tools (browser + deploy oracle)

Lane: **tsk_11fc5c0c** · branch **feat/cli-agent-tools** (off master 0.15.0).
Status: **built + tested locally, committed, NOT published.** Founder review required before publish.

## TL;DR

Two new `somewhere` subcommands wrap the agent-native prod endpoints so they're reachable from the CLI, not just MCP:

| Command | Wraps | Purpose |
| --- | --- | --- |
| `somewhere browser [target]` | `POST /v1/browser` | Agent-native browser — drive a URL/project, print the combined **health signal** (console errors, failed requests, JS page errors, DOM map) as grep-able text. |
| `somewhere deploy-check [dir]` | `POST /v1/deploy/check` (+ `/check/run` via `--run`) | **Server-side** pre-deploy oracle — dry-compile the local source on the REAL platform compiler; `--run` compiles + invokes one handler against inputs. |

Files: `src/commands/browser.ts`, `src/commands/check.ts`, registered in `src/index.ts`; tests `test/browser.test.mjs`, `test/check.test.mjs`.

## ⚠️ Naming decision needing founder sign-off

The brief asked for the second command to be named **`somewhere check`**. That name is **already shipped** — `registerSwpx` (src/commands/swpx.ts:43) registers `check [package]` (the swpx npm-package verdict). Two commands can't share a name (commander throws at startup, which I reproduced). I'm the CLI-agent-tools lane, not the swpx lane, so I did **not** touch swpx's `check`.

**Decision:** named the deploy oracle **`somewhere deploy-check`** (sits naturally beside `deploy` / `typecheck`; non-breaking). The `--help` text notes it's "unrelated to `somewhere check`, which is the swpx npm-package verdict."

→ **Founder: confirm `deploy-check`, or pick another name** (e.g. `predeploy`, `precheck`). If you want the oracle to own the bare word `check`, the swpx lane has to rename its package-verdict command first — that's out of this lane.

## `somewhere browser` — flags → request

`target` is a positional: a URL (`https://…`) → request `url`; anything else → `project_id`. Falls back to the linked project (`.somewhere.json`). Explicit `--url` / `--project` override the positional.

| Flag | Effect on `POST /v1/browser` body |
| --- | --- |
| `--project <ref>` | `project_id` |
| `--url <url>` | `url` (any public page, or a path on the project origin) |
| `--path <path>` | step `{ action: 'goto', path }` |
| `--wait <selector>` | step `{ action: 'wait_for', selector }` |
| `--eval <js>` | step `{ action: 'eval', script }` |
| `--screenshot` | step `{ action: 'screenshot' }` (requires a project to store the image) |
| `--viewport <desktop\|mobile>` | `viewport` |
| `--snapshot` | display-only — prints the full DOM map, NOT a step |
| `--json` | print the raw response envelope |

Output (default): grep-able lines — `PASS/FAIL <final_url>`, `console_errors: N`, `page_errors: N`, `failed_requests: N`, `dom: N interactive elements`, then one `console_error:` / `page_error:` / `failed_request:` line per signal, any step `result:`, and `screenshot: <path>` (never the image bytes — keeps it agent/grep friendly, per the brief).

**Exit code:** non-zero when unhealthy = `passed === false` OR any `failed_requests` OR any `page_errors`. Console errors alone are advisory (favicon 404s etc.) and don't fail the gate — they're still printed. (Matches the MCP browser tool's own guidance: `passed` reflects step outcomes only; always read the other signals.)

## `somewhere deploy-check` — flags → request

Collects the same source tree `somewhere deploy` uploads (`src/lib/files.ts` `collectFiles`) and posts it for a dry compile. Needs a project (`--project` or linked).

| Flag | Effect |
| --- | --- |
| (default) | `POST /v1/deploy/check` `{ project_id, files, functions?, binary_files? }` |
| `--run <path>` | `POST /v1/deploy/check/run` — same body **+** `target: { path, method, body?, query? }` (compile, then invoke that handler) |
| `-X/--method`, `-d/--body`, `-q/--query` | populate `target` for `--run` (mirror `somewhere exec`) |
| `--json` | raw envelope |

Output: clean → green "Server-side check clean (real platform compiler) — safe to deploy." (+ any advisory `warnings` and the `build_log`). Errors → structured **file:line** diagnostics with a local code frame, reusing `src/lib/build-errors.ts` `renderBuildError` (we have the source on disk, so frames are real). `--run` prints the handler response like `somewhere run` (logs → status + body, or "Handler threw:").

### The typecheck-vs-deploy-check distinction (explicit in `--help`)

- `somewhere typecheck` — **LOCAL** `tsc --noEmit` on a *pulled* tree on your machine; needs the tsconfig `somewhere pull` scaffolds. Catches TS type errors offline.
- `somewhere exec` / `run` — **LOCAL** execution against your real bindings.
- `somewhere deploy-check` — **SERVER-SIDE**: the *actual platform bundler that `deploy` runs*, no deploy/promote. Catches what only the platform catches — cross-import resolution, bundling, `BUNDLED_DEPLOY_REJECTED` — i.e. the truest "will this deploy succeed?" gate. `--run` is the server-side analog of local `exec`/`run`.

## Endpoint shapes — confirmed vs assumed

I'm logged in, so I probed live (public URL only, per the guardrails):

- **`/v1/browser` response shape is CONFIRMED** via the live MCP `browser` tool against `https://example.com`: `{ passed, final_url, console_errors[], page_errors[], failed_requests[], steps[], screenshots[], dom_outline[], testid_map{} }`. The formatter is defensive about element/signal sub-shapes (string or object).
- **`/v1/browser` and `/v1/deploy/check[/run]` are NOT yet routed on `api.somewhere.tech`** for my dev key — they live in prod worker **912e0fe0**, which isn't promoted to the API host yet. A live `somewhere browser https://example.com` currently returns a clean `NOT_FOUND [HTTP 404]` and exits 1 (verified — the auth/path/error wiring is correct; only the route is missing server-side).

**Assumptions to verify against the real worker before publish** (couldn't probe these live):
1. Browser step action names/fields — `goto{path}`, `eval{script}`, `screenshot` are confirmed from the MCP tool description; **`wait_for{selector}`** is my best guess for the wait step (the MCP desc lists `wait_for[+settled/text/url]` but not the exact field). Confirm the field name.
2. `/v1/deploy/check` request — assumed to accept the same `{ project_id, files, functions, binary_files }` collector payload as `/v1/deploy`.
3. `/v1/deploy/check` response — handled **both** plausible models: errors-as-data (`{ ok:false, errors:[{file,line,column,code?,message}], warnings?, build_log? }`) **and** a thrown `BUILD_ERROR` (same payload as `/v1/deploy`). Both funnel through `renderBuildError`. Confirm which the worker returns.
4. `/v1/deploy/check/run` request/response — assumed `target:{path,method,body?,query?}` in, `{ status, body, logs?, error?, duration_ms?, ok?, errors? }` out (mirrors `run`/`exec`). Confirm field names.

These are isolated in small exported helpers (`buildBrowserBody`, `buildCheckBody`, `buildCheckRunBody`, `checkErrorsToCliError`, `formatBrowserReport`, `formatCheckRunResult`) so adjusting to the real shape is a one-line change + a test tweak, not a rewrite.

## Tests (mock client) — all green

`npm test` → **144 pass, 0 fail** (19 new). New tests mock the API via a local HTTP server (same pattern as `runner-client` / `refresh-on-401`) + unit-test the pure helpers:

- `test/browser.test.mjs` (10): `buildBrowserBody` target precedence + steps + viewport + snapshot-is-not-a-step; real `ApiClient` round-trip asserts `POST /browser` + bearer auth + exact body; `formatBrowserReport` grep-able output + `--snapshot` DOM map; `browserExitCode` health gate.
- `test/check.test.mjs` (9): `buildCheckBody`/`buildCheckRunBody` payload shape (omits empty buckets, appends `target`); round-trips assert `POST /deploy/check` and `/deploy/check/run`; `checkErrorsToCliError` errors-as-data → renderable `BUILD_ERROR`; `formatCheckRunResult` logs/status/body + thrown handler.

Also verified manually: both `--help` screens render the distinction; validation guards (bad `--viewport`, no target, `--screenshot` without project, unlinked dir) fire before any network call; `swpx check` is unaffected.

## Founder review checklist before publish

1. **Confirm the `deploy-check` name** (vs the brief's `check`, which collides with swpx). ← the one open decision.
2. Promote/route worker **912e0fe0** so `/v1/browser` + `/v1/deploy/check[/run]` answer on `api.somewhere.tech`, then run `somewhere browser https://example.com` and `somewhere deploy-check` against a throwaway project to confirm the 4 assumed shapes above; adjust the small helpers if any field differs.
3. Decide the `browser` failure policy (currently: fail on `!passed` / failed_requests / page_errors; console errors advisory) — tune if you want a stricter/looser CI gate.
4. README/changelog mention (out of this lane's scope; `--help` is wired).
5. Version bump + publish (this lane intentionally did neither).

## Guardrails honored

No publish, no tag, no push. Commit on `feat/cli-agent-tools` only. No customer project touched — the one live call was `https://example.com` (public) through my own dev key.
