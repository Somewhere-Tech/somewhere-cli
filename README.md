# @somewhere-tech/cli

CLI for [somewhere.tech](https://somewhere.tech). Like `gh` for GitHub, `vercel` for Vercel.

## Install

```bash
npm install -g @somewhere-tech/cli
```

Or run directly:

```bash
npx @somewhere-tech/cli init
```

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
| `somewhere pull` | Download a project's deployed source to the current directory |
| `somewhere logs` | Show recent logs |
| `somewhere logs --follow` | Stream logs in real-time |
| `somewhere logs --level error` | Filter by level |
| `somewhere env list` | Show environment variables |
| `somewhere env set KEY value` | Set an env var |
| `somewhere env delete KEY` | Delete an env var |
| `somewhere status` | Show project + workspace status |
| `somewhere open` | Open project URL in browser |
| `somewhere open --dashboard` | Open the dashboard |
| `somewhere dev` | Hot-deploy watcher — save a file, it goes live in seconds (no local server) |
| `somewhere api GET /v1/projects` | Raw API call with auto-auth |
| `somewhere mcp` | Run MCP server over stdio (proxies to mcp.somewhere.tech) |

Short alias: `sw` works everywhere `somewhere` does.

## Auth flow

`somewhere login` opens your browser, you sign in with Google, the platform redirects back to a local server with your API key. The key is stored in `~/.somewhere/config.json` (mode 600).

## Init flow

`somewhere init` creates a project on the platform and writes two files:

- **`.somewhere.json`** — project ID, name, subdomain. The CLI reads this to know which project you're working on.
- **`.mcp.json`** — MCP server config with your API key. Claude Code and Codex auto-discover this and connect to the platform. No manual config.

After init, `claude "build me a booking app"` works immediately.

## Deploy

`somewhere deploy` reads all files in the current directory (skipping `node_modules`, `.git`, `.env`, etc.), sends them to the platform, and they're live at `{subdomain}.somewhere.tech`. Deploy **raw source** — the platform compiles JSX/TSX, resolves npm imports, and bundles for you. Don't run a build step first.

Files under `functions/` (and root-level `api/` and `_lib/`) are deployed as server-side functions.

### Deploy options

| Flag | What it does |
|---|---|
| `--scope functions` | Deploy only the backend functions; leave the site untouched |
| `--scope static` | Deploy only the site; leave functions untouched |
| `--dry-run` | Show what would change (added / modified / removed) without deploying |
| `--replace-functions` | Drop deployed functions not present locally (repo-as-truth; default keeps them) |
| `--project <id>` | Deploy to a specific project instead of the linked one |

After a successful deploy the CLI prints a **build log** — the entry chunk, each compiled chunk with its size, each function with its size, and any compiler warnings.

```bash
somewhere deploy --dry-run            # preview the diff first
somewhere deploy --scope functions    # ship a backend fix without touching the site
```

## Hot reload: `somewhere dev`

```sh
somewhere dev
```

Starts a file watcher that hot-deploys on every save — no local server, no
emulator. Edit a file, save, and it's live on the real platform in a couple of
seconds with full `sw.*` context. Single-file saves ship as incremental patches;
compile errors show up in the terminal immediately (with the file + line) and the
previous working version keeps serving until you fix it.

```
$ somewhere dev
✓ Synced 3 files
👀 Watching /my-app for changes
🌐 https://my-app.somewhere.tech

[13:41:01] src/main.tsx → ✓ live (1.2s, v2)
[13:41:18] api/users.ts → ✗ compile failed (1.4s)  ← previous version still live
[13:41:24] api/users.ts → ✓ live (0.9s, v3)
```

Passing a command (`somewhere dev npm run dev`) keeps the legacy behavior — run
your own process locally with `SOMEWHERE_PROJECT_ID` / `SOMEWHERE_URL` injected.

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
- No AI calls (Claude Code / Codex do that via MCP)
- No workspace management (dashboard)
- No billing (dashboard)

## Requirements

Node.js >= 18

## License

MIT © somewhere.tech
