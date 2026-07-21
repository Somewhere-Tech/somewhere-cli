# @somewhere-tech/cli

CLI for [somewhere.tech](https://somewhere.tech). Like `gh` for GitHub, `vercel` for Vercel.

## Install

```bash
npm install -g @somewhere-tech/cli
```

Or run directly:

```bash
npx somewhere-cli deploy
```

From a project folder, that single command deploys anonymously when no account
is configured and prints the live URL, claim URL, and expiry. The scoped package
name works too: `npx @somewhere-tech/cli deploy`.

## Quick start

```bash
somewhere login          # OAuth in browser, stores API key
somewhere init           # Create project, write .somewhere.json + .mcp.json
somewhere deploy         # Deploy current directory
somewhere logs           # Stream logs
somewhere open           # Open in browser
```

After `somewhere init`, Claude Code and Codex auto-connect via the `.mcp.json` it writes. Just start coding.

## Commands

| Command | What it does |
|---|---|
| `somewhere login` | Authenticate via browser (Google OAuth) |
| `somewhere auth login` | Alias of `somewhere login` |
| `somewhere logout` | Clear stored credentials |
| `somewhere whoami` | Show current user, plan, project count |
| `somewhere init` | Create project + write `.somewhere.json` + `.mcp.json` |
| `somewhere init --link` | Link to an existing project |
| `somewhere projects` | List all projects with status |
| `somewhere project create <name>` | Create a new project |
| `somewhere project view [name]` | Show project details |
| `somewhere project delete <name>` | Delete with email confirmation |
| `somewhere deploy` | Deploy current directory to linked project |
| `somewhere deploy --dry-run` | Preview the deploy diff without shipping |
| `somewhere deploy --scope functions` | Deploy backend only (leave the site untouched) |
| `somewhere deploy --force` | Intentionally overwrite remote changes made since this machine last deployed |
| `somewhere pull` | Download a project's live deployed source + scaffold tsconfig/package.json for local typechecking |
| `somewhere typecheck` | Loads the pulled `tsconfig.json` explicitly (equivalent to project-wide `tsc --noEmit`) — catches a dropped import (TS2304) with file:line; do not append source-file args, which bypass the project config |
| `somewhere logs` | Show recent logs |
| `somewhere logs --follow` | Stream logs in real-time |
| `somewhere logs --level error` | Filter by level |
| `somewhere run <script.js>` | Run a one-off script once against the project's live bindings (`sw.db`/`sw.fs`/`sw.ai`…) and print its return value + logs — no deploy |
| `somewhere errors` | Show the most recent exceptions (endpoint, status, error, time) — the curated error view |
| `somewhere rollback` | Revert production to the previous deployed version |
| `somewhere env list` | Show environment variables |
| `somewhere env set KEY value` | Set an env var |
| `somewhere env delete KEY` | Delete an env var |
| `somewhere env pull` | Write a local `.env` listing the keys the project expects (values blank — secrets never leave the platform) |
| `somewhere status` | Show project + workspace status |
| `somewhere open` | Open project URL in browser |
| `somewhere open --dashboard` | Open the dashboard |
| `somewhere api GET /v1/projects` | Raw API call with auto-auth |
| `somewhere advisor "<question>"` | Ask the authenticated platform advisor (`--json` for automation) |
| `somewhere docs [topic]` | Read public text docs or an MCP manual topic such as `sw.db` (`--json` supported) |
| `somewhere catalog` | Browse the live platform tool catalog (`--json` for the raw catalog) |
| `somewhere mcp` | Run MCP server over stdio (proxies to mcp.somewhere.tech) |
| `somewhere mcp install <host>` | Configure an MCP host (`codex`, `claude-code`, `cursor`) |
| `somewhere mcp doctor` | Check MCP setup: login, token, server reachability, host configs |
| `swpx <package>` | Run a package with `npx` after a verdict check (also `somewhere npx`) |
| `swpm install` | Run `npm install` after checking the resolved tree (also `somewhere npm`) |
| `somewhere check <pkg>` | Inspect a package's verdict without running it (`--json` for agents) |

Short alias: `sw` works everywhere `somewhere` does.

## Verify npm packages before you run them: `swpx` / `swpm`

`swpx` and `swpm` are thin gates in front of `npx` and `npm`. Before anything
executes or installs, they check the package against the verdict database at
[npm.somewhere.tech](https://npm.somewhere.tech) and show you what's known.
**They are never in the byte path** — npm's own CDN serves the package, same
bytes, same speed. We only serve the verdict.

```bash
swpx create-next-app my-app     # verified → passes through to npx
swpx some-sketchy-tool          # flagged → stops, shows evidence, you decide
swpm install                    # checks the whole tree, blocks confirmed malware
somewhere check left-pad        # just the verdict, nothing runs
somewhere check left-pad --json # raw verdict object, for agents / CI
```

What you see:

```
$ swpx create-next-app my-app
✓ create-next-app@15.2.0 — network, fs, child_process ✓ matches "Create Next.js apps"

$ swpx some-analytics-tool
⚠ some-analytics-tool@2.1.0 — could not verify
  ⚠ No provenance (source unverifiable)
  ⚠ Has install scripts (postinstall)
  ⚠ Capabilities don't match description: "lightweight date formatter"
  Run npx some-analytics-tool to proceed unverified.

$ swpx @ctrl/tinycolor@4.1.1
✖ BLOCKED — @ctrl/tinycolor@4.1.1
  MAL-2025-09-384: credential-harvesting via preinstall hook
  This version is confirmed malware. Do not install.
```

**How it behaves**

- **Verified** packages pass straight through to the real `npx` / `npm`.
- **Flagged** (unverified / suspicious) packages stop with evidence. The override
  is exactly what the message says — run plain `npx` yourself. We don't nag.
- **Confirmed malware** is hard-blocked (`swpx` exits 1; `swpm install` refuses
  the whole install). For `swpm`, unverified *transitive* deps are surfaced as
  warnings but don't block the install — only confirmed malware does.
- **Pending LLM summaries are explicit.** The wrapper prints
  `Generating LLM summary…` and polls briefly before the install decision. If
  generation times out, it says so and continues with the raw verdict metadata.
- **A gate, not a wall.** If the verdict service is unreachable, you get normal
  npm behaviour (a dim note, then the real tool runs). Our outage never stops you.
- **No account, no login.** The verdict service is public and free.

`somewhere check` exit codes (for scripting / agents): `0` verified, `1`
unverified/suspicious, `2` blocked, `3` couldn't determine (bad name or service
down). `SWPX_DRY_RUN=1` prints the decision and the command that *would* run
without executing it. Point the CLI at a staging verdict service with
`SWPX_VERDICT_URL`.

## Auth flow

`somewhere login` opens your browser, you sign in with Google, the platform redirects back to a local server with your API key. The key is stored in `~/.somewhere/config.json` (mode 600).

The CLI configures every MCP host (Claude Code, Cursor, Codex) to use the **stdio bridge** (`somewhere mcp`), not a baked-in token. The bridge re-reads `~/.somewhere/config.json` on every launch, so a later `somewhere login` (which rotates your key) never leaves a stale token behind — no manual config editing, ever. If your stored key is a refreshable cli-pair key, the CLI also swaps in a fresh access key automatically on expiry, so a long-running agent session never logs itself out.

## Init flow

`somewhere init` creates a project on the platform and writes two files:

- **`.somewhere.json`** — project ID, name, subdomain. The CLI reads this to know which project you're working on.
- **`.mcp.json`** — MCP server config pointing at the `somewhere mcp` stdio bridge. Claude Code and Codex auto-discover this and connect to the platform using your live login. No token baked into the file, no manual config.

After init, `claude "build me a booking app"` works immediately.

## Deploy

`somewhere deploy` reads all files in the current directory (skipping `node_modules`, `.git`, `.env`, etc.), sends them to the platform, and they're live at `{subdomain}.somewhere.tech`. Deploy **raw source** — the platform compiles JSX/TSX, resolves npm imports, and bundles for you. Don't run a build step first.

Files under `functions/` (and root-level `api/` and `_lib/`) are deployed as server-side functions.

Files under `public/` deploy at the site root, matching Vite's convention: `public/images/logo.png` serves as `/images/logo.png`.

To exclude local-only files from deploy, add gitignore-style patterns to `.somewhereignore` in the project root. The CLI also respects the root `.gitignore`. `.somewhereignore` is applied after `.gitignore`, so it can add deploy-only excludes or `!` re-includes. Built-in safety excludes such as `node_modules`, `.git`, `.env`, `dist`, and dotfiles still apply.

After each successful linked deploy or pull, the CLI records the current deployed version in `.somewhere.json`. If the project changed elsewhere since that version, the next deploy refuses before overwriting anything and names the changed files. Run `somewhere pull` to bring remote source back locally, or `somewhere deploy --force --yes` to overwrite intentionally.

### Deploy options

| Flag | What it does |
|---|---|
| `--scope functions` | Deploy only the backend functions; leave the site untouched |
| `--scope static` | Deploy only the site; leave functions untouched |
| `--dry-run` | Show what would change (added / modified / removed) without deploying |
| `--replace-functions` | Drop deployed functions not present locally (repo-as-truth; default keeps them) |
| `--project <id>` | Deploy to a specific project instead of the linked one |
| `--force` | Overwrite remote changes even when this machine has an older deployed version |
| `--yes` | Skip the `--force` confirmation prompt |

After a successful deploy the CLI prints a **build log** — the entry chunk, each compiled chunk with its size, each function with its size, and any compiler warnings.

```bash
somewhere deploy --dry-run            # preview the diff first
somewhere deploy --scope functions    # ship a backend fix without touching the site
somewhere deploy --force --yes        # overwrite remote edits intentionally
```

## Optional cloud development

The default workflow is `somewhere pull` → edit → `somewhere typecheck` →
`somewhere deploy`, followed by verification on the public live URL. Database,
files, one-off scripts, deployed functions, and Browser all use that same live
project.

`somewhere dev`, `somewhere dev --local`, `somewhere exec`, and
`somewhere promote` are preserved advanced commands for the isolated
cloud-development environment. Cloud development is off by default, including
on paid accounts, and requires both a paid plan and explicit platform
enablement. Without it, these commands return `CLOUD_DEV_NOT_ENABLED` before
creating cloud-development resources.

## Client-side code: use the SDK

The CLI deploys and manages projects. For **client-side code** (browser / Node app talking to your backend), install the SDK — a Supabase-shaped client so existing code ports with one import swap:

```bash
npm i @somewhere-tech/sdk
```

```js
import { createClient } from '@somewhere-tech/sdk';
const db = createClient(URL, KEY);
const { data, error } = await db.from('todos').select('*');
```

Inside deployed functions you use the `sw` runtime directly (`sw.db.query(...)`, `sw.auth`, `sw.email`, …) — no SDK needed there.

## What the CLI does NOT do

- No hosting or running code (the platform does that)
- No building or compiling — **deploy raw source; the platform compiles it**
- No application AI calls (the `advisor` command only exposes the platform-help expert)
- No workspace management (dashboard)
- No billing (dashboard)

## Requirements

Node.js >= 18

## License

MIT © somewhere.tech
