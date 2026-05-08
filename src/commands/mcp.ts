import { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../lib/config.js';

const UPSTREAM_URL = 'https://mcp.somewhere.tech/mcp';

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
  program
    .command('mcp')
    .description('Run somewhere.tech MCP server over stdio (proxies to mcp.somewhere.tech)')
    .action(async () => {
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
    });
}
