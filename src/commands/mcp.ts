import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  CURSOR_MCP_PATH,
  hasCursorMcpConfig,
  hasGlobalMcpConfig,
  loadConfig,
  saveCursorMcpConfig,
  saveGlobalMcpConfig,
} from '../lib/config.js';
import { ApiClient } from '../lib/client.js';
import { dim, error, info, success, teal } from '../lib/output.js';

const UPSTREAM_URL = 'https://mcp.somewhere.tech/mcp';

const INSTALL_HOSTS = ['codex', 'claude-code', 'cursor'] as const;
type InstallHost = (typeof INSTALL_HOSTS)[number];

const RESTART_HINT =
  'MCP hosts load tools when a session starts. Open a NEW session (or restart the host), then look for tools named mcp__somewhere__*.';

// Emit a JSON-RPC error notification on stdout so MCP hosts surface a clear
// message instead of a generic crash. id=null because it's not a response to
// any specific request.
function emitFatalError(message: string): void {
  const payload = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32001, message },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

export function registerMcp(program: Command) {
  const mcp = program
    .command('mcp')
    .description('Run somewhere.tech MCP server over stdio (proxies to mcp.somewhere.tech)')
    .action(runStdioBridge);

  // Hidden alias: docs/llms-full.md taught `somewhere mcp stdio` — keep it
  // true rather than breaking copies already cached in agents and scrapes.
  mcp
    .command('stdio', { hidden: true })
    .description('Alias of bare `somewhere mcp`')
    .action(runStdioBridge);

  mcp
    .command('install <host>')
    .description(`Configure an MCP host to use somewhere.tech (${INSTALL_HOSTS.join(', ')})`)
    .action(runInstall);

  mcp
    .command('doctor')
    .description('Check MCP setup: login, token validity, server reachability, host configs')
    .action(async () => {
      await runDoctor(program.version() ?? 'unknown');
    });
}

/* ─── stdio bridge (bare `somewhere mcp`) ─────────────────────────── */

async function runStdioBridge(): Promise<void> {
  const config = loadConfig();
  if (!config?.token) {
    emitFatalError('Not logged in. Run: somewhere login');
    process.exit(1);
  }

  const httpTransport = new StreamableHTTPClientTransport(new URL(UPSTREAM_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${config.token}` },
    },
  });

  const stdioTransport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (reason?: Error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason instanceof UnauthorizedError) {
      emitFatalError('somewhere.tech rejected the API key. Run: somewhere login');
    }
    try { await stdioTransport.close(); } catch {}
    try { await httpTransport.close(); } catch {}
  };

  stdioTransport.onmessage = (msg: JSONRPCMessage) => {
    httpTransport.send(msg).catch((err: unknown) => {
      if (err instanceof UnauthorizedError) {
        void shutdown(err);
        process.exit(1);
      }
      process.stderr.write(`[somewhere mcp] upstream send failed: ${String(err)}\n`);
    });
  };

  httpTransport.onmessage = (msg: JSONRPCMessage) => {
    stdioTransport.send(msg).catch((err: unknown) => {
      process.stderr.write(`[somewhere mcp] stdio send failed: ${String(err)}\n`);
    });
  };

  stdioTransport.onclose = () => { void shutdown(); };
  httpTransport.onclose = () => { void shutdown(); };

  stdioTransport.onerror = (err) => {
    process.stderr.write(`[somewhere mcp] stdio error: ${String(err)}\n`);
  };
  httpTransport.onerror = (err) => {
    if (err instanceof UnauthorizedError) {
      void shutdown(err);
      process.exit(1);
    }
    process.stderr.write(`[somewhere mcp] upstream error: ${String(err)}\n`);
  };

  try {
    await httpTransport.start();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      emitFatalError('somewhere.tech rejected the API key. Run: somewhere login');
      process.exit(1);
    }
    emitFatalError(`Failed to connect to mcp.somewhere.tech: ${String(err)}`);
    process.exit(1);
  }

  try {
    await stdioTransport.start();
  } catch (err) {
    emitFatalError(`Failed to start stdio transport: ${String(err)}`);
    process.exit(1);
  }
}

/* ─── somewhere mcp install <host> ────────────────────────────────── */

function runInstall(host: string): void {
  if (!(INSTALL_HOSTS as readonly string[]).includes(host)) {
    error(`Unknown host "${host}". Supported: ${INSTALL_HOSTS.join(', ')}`);
    process.exit(1);
  }
  const loggedIn = !!loadConfig()?.token;
  switch (host as InstallHost) {
    case 'codex': installCodex(loggedIn); break;
    case 'claude-code': installClaudeCode(); break;
    case 'cursor': installCursor(loggedIn); break;
  }
}

/** Codex owns its own config format, so we drive its CLI instead of writing
 *  the file ourselves. The entry uses the stdio bridge so auth rides the
 *  CLI login rather than a token pasted into Codex config. */
function installCodex(loggedIn: boolean): void {
  const probe = spawnSync('codex', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    error('Codex CLI not found on PATH.');
    info('Install Codex first, then either re-run this command or add the entry manually:');
    info(dim('  codex mcp add somewhere -- somewhere mcp'));
    process.exit(1);
  }

  const existing = spawnSync('codex', ['mcp', 'get', 'somewhere'], { stdio: 'ignore' });
  if (existing.status === 0) {
    success('Codex already has a "somewhere" MCP server configured.');
    info(dim('To reconfigure: codex mcp remove somewhere, then re-run this command.'));
  } else {
    const add = spawnSync('codex', ['mcp', 'add', 'somewhere', '--', 'somewhere', 'mcp'], { stdio: 'inherit' });
    if (add.status !== 0) {
      error('`codex mcp add` failed (see output above).');
      process.exit(1);
    }
    success(`Codex configured: ${teal('somewhere')} → somewhere mcp (stdio bridge)`);
  }

  if (!loggedIn) info(`Not logged in yet — run: ${teal('somewhere login')}`);
  printVerify('codex');
}

function installClaudeCode(): void {
  const config = loadConfig();
  if (!config?.token) {
    error('Not logged in. Run: somewhere login');
    info(dim('`somewhere login` configures Claude Code automatically — no separate install step needed.'));
    process.exit(1);
  }
  saveGlobalMcpConfig(config.token);
  success(`Claude Code configured (~/.claude.json): ${teal('somewhere')} → ${UPSTREAM_URL}`);
  printVerify('claude-code');
}

function installCursor(loggedIn: boolean): void {
  saveCursorMcpConfig();
  success(`Cursor configured (${CURSOR_MCP_PATH}): ${teal('somewhere')} → somewhere mcp (stdio bridge)`);
  if (!loggedIn) info(`Not logged in yet — run: ${teal('somewhere login')}`);
  printVerify('cursor');
}

function printVerify(host: InstallHost): void {
  info('');
  switch (host) {
    case 'codex':
      info(`Verify: ${teal('codex mcp list')} should show "somewhere".`);
      break;
    case 'claude-code':
      info(`Verify: run ${teal('/mcp')} inside Claude Code — "somewhere" should be listed.`);
      break;
    case 'cursor':
      info('Verify: Cursor Settings → MCP should list "somewhere".');
      break;
  }
  info(RESTART_HINT);
  info(dim('Full setup check: somewhere mcp doctor'));
}

/* ─── somewhere mcp doctor ────────────────────────────────────────── */

async function runDoctor(version: string): Promise<void> {
  let failures = 0;
  const fail = (msg: string, fix?: string) => {
    failures++;
    error(msg);
    if (fix) info(dim(`fix: ${fix}`));
  };

  info(`somewhere CLI ${version}`);
  info('');

  // 1. Login config present
  const config = loadConfig();
  if (config?.token) {
    success(`Logged in as ${teal(config.user.email || '(unknown)')} (~/.somewhere/config.json)`);
  } else {
    fail('Not logged in — no token in ~/.somewhere/config.json.', 'somewhere login');
  }

  // 2. Token actually valid against the API. /auth/whoami is the endpoint
  // that accepts smt_ keys (verified 2026-06-09: /auth/platform-me rejects
  // a key that whoami and the MCP server both accept).
  if (config?.token) {
    try {
      const me = await new ApiClient(config.token).call<{ user?: { email?: string } }>('GET', '/auth/whoami');
      success(`Token valid (${me.user?.email ?? config.user.email ?? 'unknown account'})`);
    } catch (err) {
      fail(
        `Token rejected by api.somewhere.tech: ${err instanceof Error ? err.message : String(err)}`,
        'somewhere login',
      );
    }
  }

  // 3. MCP server reachability — a real initialize round-trip, not a ping.
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (config?.token) headers.Authorization = `Bearer ${config.token}`;
    const res = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'somewhere-mcp-doctor', version },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      success('MCP server reachable — initialize accepted (mcp.somewhere.tech)');
    } else if (res.status === 401 && !config?.token) {
      success('MCP server reachable (responded 401 — expected without a login)');
    } else if (res.status === 401) {
      fail('MCP server reachable but it rejected the token.', 'somewhere login');
    } else {
      fail(`MCP server responded ${res.status} to initialize.`);
    }
  } catch (err) {
    fail(`Cannot reach ${UPSTREAM_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Host configs — informational, not failures: not everyone uses every host.
  info('');
  info('Host configs:');
  if (hasGlobalMcpConfig()) {
    success('Claude Code: "somewhere" entry in ~/.claude.json');
  } else {
    info(dim('Claude Code: not configured — somewhere mcp install claude-code (or just somewhere login)'));
  }
  const codexProbe = spawnSync('codex', ['--version'], { stdio: 'ignore' });
  if (codexProbe.error || codexProbe.status !== 0) {
    info(dim('Codex: CLI not found on PATH — skipped'));
  } else if (spawnSync('codex', ['mcp', 'get', 'somewhere'], { stdio: 'ignore' }).status === 0) {
    success('Codex: "somewhere" MCP server configured');
  } else {
    info(dim('Codex: not configured — somewhere mcp install codex'));
  }
  if (hasCursorMcpConfig()) {
    success(`Cursor: "somewhere" entry in ${CURSOR_MCP_PATH}`);
  } else {
    info(dim('Cursor: not configured — somewhere mcp install cursor'));
  }

  info('');
  info(RESTART_HINT);
  process.exit(failures > 0 ? 1 : 0);
}
