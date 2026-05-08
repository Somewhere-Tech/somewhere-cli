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
| `somewhere deploy ./dist` | Deploy a specific directory |
| `somewhere logs` | Show recent logs |
| `somewhere logs --follow` | Stream logs in real-time |
| `somewhere logs --level error` | Filter by level |
| `somewhere env list` | Show environment variables |
| `somewhere env set KEY value` | Set an env var |
| `somewhere env delete KEY` | Delete an env var |
| `somewhere status` | Show project + workspace status |
| `somewhere open` | Open project URL in browser |
| `somewhere open --dashboard` | Open the dashboard |
| `somewhere dev` | Run local dev with platform env vars |
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

`somewhere deploy` reads all files in the current directory (skipping `node_modules`, `.git`, `.env`, etc.), sends them to the platform, and they're live at `{subdomain}.somewhere.tech`.

Files under `functions/` are deployed as server-side functions (Workers for Platforms).

## What the CLI does NOT do

- No hosting or running code (the platform does that)
- No building or compiling (your tools do that)
- No AI calls (Claude Code / Codex do that via MCP)
- No workspace management (dashboard)
- No billing (dashboard)

## Requirements

Node.js >= 18

## License

MIT © somewhere.tech
