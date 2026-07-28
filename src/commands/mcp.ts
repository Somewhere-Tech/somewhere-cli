import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
// The @modelcontextprotocol/sdk value imports (transports, UnauthorizedError)
// are LAZY — loaded inside runStdioBridge only. They pull in a large tree
// (zod/hono/ajv), and this module is registered at startup for EVERY command,
// so a top-level import would make `somewhere deploy`/`run` pay for the MCP
// bridge they never use. Types are erased at compile, so they stay static.
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

const UPSTREAM_URL =
  process.env.SOMEWHERE_MCP_URL?.replace(/\/$/, '') || 'https://mcp.somewhere.tech/mcp';

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

  // Lazy-load the SDK only when the bridge actually runs (see import note above).
  const [
    { StdioServerTransport },
    { StreamableHTTPClientTransport, StreamableHTTPError },
    { UnauthorizedError },
  ] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/server/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/auth.js'),
    ]);

  const stdioTransport = new StdioServerTransport();
  const apiClient = new ApiClient(config.token);

  let shuttingDown = false;
  let fatalInFlight = false;
  let refreshInFlight: Promise<void> | null = null;
  let httpTransport: InstanceType<typeof StreamableHTTPClientTransport>;

  const isAuthRejection = (err: unknown): boolean =>
    err instanceof UnauthorizedError
    || (err instanceof StreamableHTTPError && err.code === 401);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await stdioTransport.close(); } catch {}
    try { await httpTransport.close(); } catch {}
  };

  const bindHttpTransport = (
    transport: InstanceType<typeof StreamableHTTPClientTransport>,
  ): void => {
    transport.onmessage = (msg: JSONRPCMessage) => {
      stdioTransport.send(msg).catch((err: unknown) => {
        process.stderr.write(`[somewhere mcp] stdio send failed: ${String(err)}\n`);
      });
    };
    transport.onclose = () => {
      // Closing the superseded transport is part of a successful refresh.
      // Only the currently-active transport is allowed to shut the bridge.
      if (transport === httpTransport) void shutdown();
    };
    transport.onerror = (err) => {
      // send() reports this same error to its caller; that path owns the
      // single-flight refresh + retry so it is not logged or handled twice.
      if (isAuthRejection(err)) return;
      process.stderr.write(`[somewhere mcp] upstream error: ${String(err)}\n`);
    };
  };

  const createHttpTransport = (
    token: string,
  ): InstanceType<typeof StreamableHTTPClientTransport> => {
    const transport = new StreamableHTTPClientTransport(new URL(UPSTREAM_URL), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    bindHttpTransport(transport);
    return transport;
  };

  httpTransport = createHttpTransport(config.token);

  const accessExpiresSoon = (): boolean => {
    const current = loadConfig();
    if (!current?.refresh_token || !current.access_expires_at) return false;
    const expiresAt = Date.parse(current.access_expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
  };

  const renewHttpTransport = async (preemptive = false): Promise<void> => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      // Reuse the CLI's canonical renewal path: refresh after the
      // API confirms API_KEY_EXPIRED, or just before the server-provided access
      // expiry. Both paths rotate and persist the replacement smtr_ pair.
      // INVALID_API_KEY or a revoked refresh credential stays terminal.
      if (preemptive) {
        const refreshed = await apiClient.refreshAccessKey(10_000);
        if (!refreshed) {
          throw new Error('Session renewal returned an incomplete credential pair.');
        }
      } else {
        await apiClient.call('GET', '/auth/whoami', undefined, undefined, {
          timeoutMs: 10_000,
        });
      }
      const renewed = loadConfig();
      if (!renewed?.token) {
        throw new Error('Session renewal completed without a saved access key.');
      }
      const previous = httpTransport;
      const next = createHttpTransport(renewed.token);
      await next.start();
      httpTransport = next;
      await previous.close();
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };

  const forwardUpstream = async (msg: JSONRPCMessage): Promise<void> => {
    // New login configs carry the exact access expiry. Renew before forwarding
    // so a mutating MCP request is never replayed merely because it crossed
    // the 24-hour auth boundary. Older configs retain the 401 fallback below.
    if (accessExpiresSoon()) {
      await renewHttpTransport(true);
    }
    try {
      await httpTransport.send(msg);
      return;
    } catch (err) {
      if (!isAuthRejection(err)) throw err;
    }
    await renewHttpTransport();
    // Exactly one replay. If the replacement is also rejected, fail cleanly;
    // never spin a refresh loop or duplicate a mutating MCP call.
    await httpTransport.send(msg);
  };

  const failBridge = async (err: unknown): Promise<void> => {
    if (fatalInFlight || shuttingDown) return;
    fatalInFlight = true;
    const detail = err instanceof Error ? err.message : String(err);
    emitFatalError(`somewhere.tech session could not be renewed. ${detail}`);
    await shutdown();
    process.exit(1);
  };

  stdioTransport.onmessage = (msg: JSONRPCMessage) => {
    forwardUpstream(msg).catch((err: unknown) => {
      void failBridge(err);
    });
  };

  stdioTransport.onclose = () => { void shutdown(); };

  stdioTransport.onerror = (err) => {
    process.stderr.write(`[somewhere mcp] stdio error: ${String(err)}\n`);
  };

  try {
    await httpTransport.start();
  } catch (err) {
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

// Windows: the `codex` CLI installs as codex.cmd. spawnSync without a shell does
// no PATHEXT resolution (won't find the .cmd) and .cmd needs a shell anyway since
// CVE-2024-27980 — so probes silently reported "not found" on win32. Shell on
// win32 only; args are static identifiers, no injection surface.
const CODEX_SHELL = process.platform === 'win32';

/** Codex owns its own config format, so we drive its CLI instead of writing
 *  the file ourselves. The entry uses the stdio bridge so auth rides the
 *  CLI login rather than a token pasted into Codex config. */
function installCodex(loggedIn: boolean): void {
  const probe = spawnSync('codex', ['--version'], { stdio: 'ignore', shell: CODEX_SHELL });
  if (probe.error || probe.status !== 0) {
    error('Codex CLI not found on PATH.');
    info('Install Codex first, then either re-run this command or add the entry manually:');
    info(dim('  codex mcp add somewhere -- somewhere mcp'));
    process.exit(1);
  }

  const existing = spawnSync('codex', ['mcp', 'get', 'somewhere'], { stdio: 'ignore', shell: CODEX_SHELL });
  if (existing.status === 0) {
    success('Codex already has a "somewhere" MCP server configured.');
    info(dim('To reconfigure: codex mcp remove somewhere, then re-run this command.'));
  } else {
    const add = spawnSync('codex', ['mcp', 'add', 'somewhere', '--', 'somewhere', 'mcp'], { stdio: 'inherit', shell: CODEX_SHELL });
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
  const loggedIn = !!loadConfig()?.token;
  // Write the stdio bridge, NOT a baked token. The bridge reads
  // ~/.somewhere/config.json at every launch, so a re-login never leaves a
  // stale token behind in Claude Code's config (tsk_104fe2d0). This matches
  // Cursor (saveCursorMcpConfig) and Codex (installCodex).
  saveGlobalMcpConfig();
  success(`Claude Code configured (~/.claude.json): ${teal('somewhere')} → somewhere mcp (stdio bridge)`);
  if (!loggedIn) info(`Not logged in yet — run: ${teal('somewhere login')}`);
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
  const codexProbe = spawnSync('codex', ['--version'], { stdio: 'ignore', shell: CODEX_SHELL });
  if (codexProbe.error || codexProbe.status !== 0) {
    info(dim('Codex: CLI not found on PATH — skipped'));
  } else if (spawnSync('codex', ['mcp', 'get', 'somewhere'], { stdio: 'ignore', shell: CODEX_SHELL }).status === 0) {
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
