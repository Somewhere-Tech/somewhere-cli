# Handoff — clear re-login error instead of bare 401 (tsk_8ba2113d)

Branch: `fix/login-refresh-clear-error` (off master 0.15.0). **Not published, not version-tagged.** Founder review required before publish.

## TL;DR

When a cli-pair access key expires and the stored config has **no `refresh_token`**
(old-format `{ token, user }` login, pre–refresh-flow), `ApiClient` used to re-throw
the bare `API_KEY_EXPIRED` 401. It now throws a clear, actionable
`SESSION_EXPIRED` error that names the cause and the one-line fix
(`run somewhere login`). One-line behavior change in `src/lib/client.ts`,
covered by a flipped TDD test. Build + 125 tests green.

## What 0.15.0 already did vs. what this change adds

`ApiClient.call()` catches `API_KEY_EXPIRED` and calls `refreshAccessKey()`:

| Situation | 0.15.0 behavior | After this change |
|---|---|---|
| Refresh token present, valid | Refresh + retry once (✓ unchanged) | unchanged |
| Refresh token present, **expired/revoked** (`INVALID_REFRESH_TOKEN`) | Throws clear `SESSION_EXPIRED` "run `somewhere login`" (✓ already good) | unchanged |
| **No refresh token** (old-format config) | `refreshAccessKey()` returned `false` → `call()` re-threw the **bare `API_KEY_EXPIRED`** 401 ← **the bug** | Throws clear `SESSION_EXPIRED` "run `somewhere login`" naming the old-login cause |
| Malformed refresh response | returned `false` → re-throw original 401 | unchanged (still `false`; original 401 is the honest signal here) |

So 0.15.0 had **partial** handling — only the *dead refresh token* path was friendly.
The *no refresh token* path (exactly the founder's config: `{token,user}`, `rotated=0`)
fell through to the bare 401. That gap is what this change closes. No existing behavior
was duplicated.

### The code change (`src/lib/client.ts`)
- `refreshAccessKey()`: the `if (!refreshToken) return false;` early-out now **throws**
  a `CliApiError('SESSION_EXPIRED', '…old login format… run `somewhere login`…', 401)`.
  We only reach this line *after* an `API_KEY_EXPIRED`, so "no refresh token" here
  unambiguously means "expired access key that can't be auto-renewed" → re-login is the
  correct, only fix.
- `call()`'s `if (!refreshed) throw err` now only handles the rare malformed-response
  `false`; comment updated.
- Doc comments on `call()` and `refreshAccessKey()` updated to match. No signature change
  (`refreshAccessKey` still returns `Promise<boolean>`; it just no longer returns `false`
  for the no-token case).

### Test (`test/refresh-on-401.test.mjs`)
The pre-existing test `no refresh token → original API_KEY_EXPIRED propagates` **encoded
the bug** (asserted the bare 401). It was flipped (TDD red→green) to
`expired key + no refresh token (old-format config) → clear re-login error, not a bare 401`,
which asserts: the error is a `CliApiError`, `code !== 'API_KEY_EXPIRED'`, the message
matches `/somewhere login/` and `/refresh token|old login/i`, and the refresh endpoint was
never hit. Verified failing against the old code (`Expected "actual" to be strictly unequal
to: 'API_KEY_EXPIRED'`) before the fix, passing after.

## ⚠️ Important correction to the brief's mental model — does this reach the MCP tool result?

The brief assumed the **stdio MCP server uses `ApiClient`/`refreshAccessKey`**. It does
**not**. `src/commands/mcp.ts` `runStdioBridge()` is a **transparent JSON-RPC proxy**:
it bakes `config.token` into a `StreamableHTTPClientTransport` pointed at
`https://mcp.somewhere.tech/mcp` once at startup and forwards raw messages. **MCP tool
calls never touch `ApiClient` and never call `refreshAccessKey()`.** The
`"Could not list projects to resolve … (HTTP 401)"` string the agent saw is **not in this
repo** (confirmed: absent from all tracked source) — it is produced **server-side by the
upstream `mcp.somewhere.tech` worker's tool handler**.

What that means for "the clear error reaches the MCP tool result":

- **CLI command path (deploy, project list, errors, db, env, run, status, …)** — these
  *do* go through `ApiClient.call()`. This change fixes them: the user now sees the clear
  `SESSION_EXPIRED` message instead of a bare `[API_KEY_EXPIRED, HTTP 401]`. ✅ Done & tested.
- **stdio bridge, transport-level 401** (upstream rejects the bearer on the HTTP request) —
  already handled in 0.15.0: the bridge emits
  `somewhere.tech rejected the API key. Run: somewhere login`. ✅ Already clear.
- **stdio bridge, in-tool-result 401** (upstream returns HTTP 200 with an `isError` tool
  result like `"Could not list projects to resolve … (HTTP 401)"`) — the bridge passes this
  through verbatim; **the CLI cannot rewrite it.** This is the path the founder observed,
  and it can only be fixed **server-side in the `mcp.somewhere.tech` / API worker** (neither
  is in this repo — `server/` here is the *swpx package-verdict worker*, unrelated). ⛔ Not
  fixable from the CLI.

**Bottom line:** this CLI change makes every `ApiClient`-backed surface clear, but the
specific MCP-tool-result 401 the founder saw needs a **server-side** change. See follow-up #1.

## Silent migration (brief item #2) — SKIPPED, needs a server endpoint

Goal: if an old-format access key is still valid, transparently mint + persist a
`refresh_token` so the user is upgraded without re-login.

**Verification result: no suitable endpoint exists / can't be confirmed from this repo.**
- The API/auth worker is **not in this repo** (only the swpx verdict worker is), so the
  `/v1/keys/cli-pair/*` surface can't be read here directly.
- The platform `auth` docs (`docs({topic:'auth'})`) expose only:
  - `POST /v1/keys/cli-pair` — mint a *fresh* ephemeral 24h key (this is re-pairing, i.e.
    effectively a re-login; it does not "upgrade in place").
  - `POST /v1/keys/cli-pair/refresh` — exchange an existing **`refresh_token`** for a new
    pair (no use here — the whole problem is the absence of a refresh token).
- There is **no documented endpoint that mints a refresh token for an already-valid access
  key**. Building silent migration would require one.

Per the brief, silent migration is **skipped**; filed as follow-up #2. The fix shipped here
(clear re-login prompt) is the safe, complete CLI-side outcome.

## Server-side follow-ups to file (not built here)

1. **MCP worker: friendly auth error in tool results.** In `mcp.somewhere.tech` (and/or the
   API worker it calls), when a tool's downstream call returns `API_KEY_EXPIRED`/401, return
   an MCP tool result that says *"Your somewhere session expired — run `somewhere login` in
   your terminal to re-authenticate"* instead of the raw
   `"Could not list projects to resolve … (HTTP 401)"`. This is the only way the founder's
   exact symptom gets a clear message, because the stdio bridge just proxies tool results.
2. **(Optional) cli-pair upgrade endpoint** to enable CLI silent migration, e.g.
   `POST /v1/keys/cli-pair/upgrade` (or have the existing pair/login flow return a
   `refresh_token`): given a *valid* `smt_` cli-pair access key, mint + return an `smtr_`
   refresh token so the CLI can persist it and stop forcing ~24h re-logins on old configs.
   If/when this lands, the CLI can transparently call it on first use of a no-`refresh_token`
   config (before erroring) — small follow-up in `refreshAccessKey()`.

## Verification / gate

- `npm test` → **exit 0**; `tsc` build clean; **125 passed, 0 failed** (incl. the new test
  and the two sibling refresh tests).
- Note: `node_modules` was stale on checkout — `semver`/`@types/semver` (declared in
  `package.json`) were not installed, so `tsc` failed until `npm install`. This reconciled
  `node_modules` only; **`package.json` and `package-lock.json` are unchanged** (not in the
  diff). Pre-existing environment drift, unrelated to this fix.

## Files changed (this branch)
- `src/lib/client.ts` — throw clear `SESSION_EXPIRED` on no-refresh-token expiry (+ comments).
- `test/refresh-on-401.test.mjs` — flipped the bug-locking test to assert the clear error.
- `CLI-REFRESH-FIX-HANDOFF.md` — this file.

## What the founder must review before publish
1. **Message wording/code:** reused `SESSION_EXPIRED` (same code as the dead-refresh-token
   case — both mean "re-login"). If you'd rather distinguish them (e.g. `LOGIN_REQUIRED`),
   it's a one-line change + test tweak. Confirm the user-facing copy reads well.
2. **Scope reality:** accept that the CLI change covers `ApiClient`-backed surfaces and that
   the **MCP-tool-result 401 needs the server-side follow-up #1** — the CLI alone cannot fix
   the exact `"Could not list projects to resolve … (HTTP 401)"` the agent saw.
3. **Silent migration:** confirm you want follow-up #2 endpoint built (server side) before any
   CLI auto-upgrade work.
4. Then publish per your normal flow (no version bump / tag was made here).
