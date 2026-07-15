import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import { error, printJson } from '../lib/output.js';

const MCP_URL = process.env.SOMEWHERE_MCP_URL?.replace(/\/$/, '') || 'https://mcp.somewhere.tech/mcp';

type PlatformHelpTool = 'advisor' | 'catalog' | 'docs';

function toolErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = typeof parsed.message === 'string' ? parsed.message : text;
    return typeof parsed.error === 'string' ? `${parsed.error}: ${message}` : message;
  } catch {
    return text;
  }
}

async function callPlatformHelpToolWithToken(
  name: PlatformHelpTool,
  args: Record<string, unknown>,
  token: string,
): Promise<string> {
  const client = new Client({ name: 'somewhere-cli', version: 'unknown' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'somewhere-cli',
      },
    },
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    if (!('content' in result) || !Array.isArray(result.content)) {
      throw new Error(`${name} returned an unexpected response.`);
    }
    const text = result.content
      .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (result.isError) throw new Error(toolErrorMessage(text));
    if (!text) throw new Error(`${name} returned an empty response.`);
    return text;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Call the authoritative MCP-native help surface. Catalog and docs are built
 *  inside mcp.somewhere.tech (they do not have /v1 REST mirrors), and advisor
 *  is executed there after the caller's stored developer key is verified. */
export async function callPlatformHelpTool(
  name: PlatformHelpTool,
  args: Record<string, unknown>,
): Promise<string> {
  const token = getToken();
  try {
    return await callPlatformHelpToolWithToken(name, args, token);
  } catch (err) {
    if (!(err instanceof StreamableHTTPError) || err.code !== 401) throw err;

    // MCP uses the same developer key as the REST API, but it is not routed
    // through ApiClient. Probe the normal authenticated path so ApiClient can
    // perform its existing refresh-on-API_KEY_EXPIRED flow and persist the
    // rotated pair, then retry this MCP call exactly once with the fresh key.
    await new ApiClient(token).call('GET', '/auth/whoami');
    return await callPlatformHelpToolWithToken(name, args, getToken());
  }
}

export function registerAdvisor(program: Command): void {
  program
    .command('advisor <question>')
    .description('Ask the somewhere.tech platform advisor a question')
    .option('--json', 'Print the advisor response in a JSON envelope')
    .action(async (question: string, opts: { json?: boolean }) => {
      try {
        const answer = await callPlatformHelpTool('advisor', { question });
        if (opts.json) {
          printJson({ question, answer });
        } else {
          process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
