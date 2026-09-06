// MCP SDK values stay lazy: this module is registered for every CLI command,
// but only platform-tool commands should pay the SDK startup cost.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ApiClient } from './client.js';
import { getToken, loadConfig } from './config.js';

const MCP_BASE_URL =
  process.env.SOMEWHERE_MCP_URL?.replace(/\/$/, '') || 'https://mcp.somewhere.tech/mcp';

let isSdkAuthError: (err: unknown) => boolean = () => false;

export interface PlatformToolCallOptions {
  allTools?: boolean;
}

export class PlatformToolError extends Error {
  constructor(
    public readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformToolError';
  }
}

function mcpUrl(allTools: boolean): URL {
  const url = new URL(MCP_BASE_URL);
  if (allTools) url.searchParams.set('groups', 'all');
  return url;
}

export function mcpAccessExpiresSoon(): boolean {
  const config = loadConfig();
  if (!config?.refresh_token || !config.access_expires_at) return false;
  const expiresAt = Date.parse(config.access_expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
}

/** Reuse ApiClient's canonical cli-pair rotation and persistence path. */
export async function refreshMcpAccessToken(preemptive: boolean): Promise<string> {
  const token = getToken();
  const client = new ApiClient(token);
  if (preemptive) {
    const refreshed = await client.refreshAccessKey(10_000);
    if (!refreshed) {
      throw new Error('Session renewal returned an incomplete credential pair.');
    }
  } else {
    await client.call('GET', '/auth/whoami', undefined, undefined, { timeoutMs: 10_000 });
  }
  return getToken();
}

export function isMcpAuthRejection(err: unknown): boolean {
  if (isSdkAuthError(err)) return true;
  if (!(err instanceof Error)) return false;
  const candidate = err as Error & { code?: unknown };
  return candidate.code === 401;
}

export async function createPlatformMcpTransport(
  token: string,
  options: PlatformToolCallOptions & { userAgent?: string } = {},
): Promise<StreamableHTTPClientTransport> {
  const [{ StreamableHTTPClientTransport, StreamableHTTPError }, { UnauthorizedError }] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/auth.js'),
    ]);
  isSdkAuthError = (err: unknown): boolean =>
    err instanceof UnauthorizedError
    || (err instanceof StreamableHTTPError && err.code === 401);
  return new StreamableHTTPClientTransport(mcpUrl(options.allTools === true), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}),
      },
    },
  });
}

async function connectClient(
  token: string,
  options: PlatformToolCallOptions,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'somewhere-cli', version: 'unknown' });
  const transport = await createPlatformMcpTransport(token, {
    ...options,
    userAgent: 'somewhere-cli',
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

async function withPlatformClient<T>(
  options: PlatformToolCallOptions,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  let token = getToken();
  if (mcpAccessExpiresSoon()) token = await refreshMcpAccessToken(true);

  const attempt = async (accessToken: string): Promise<T> => {
    const connection = await connectClient(accessToken, options);
    try {
      return await operation(connection.client);
    } finally {
      await connection.close();
    }
  };

  try {
    return await attempt(token);
  } catch (err) {
    if (!isMcpAuthRejection(err)) throw err;
  }

  token = await refreshMcpAccessToken(false);
  return attempt(token);
}

export async function listPlatformTools(
  options: PlatformToolCallOptions = {},
): Promise<Tool[]> {
  return withPlatformClient(options, async (client) => {
    const result = await client.listTools();
    return result.tools;
  });
}

function textFromResult(result: CallToolResult): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> =>
      block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function toolErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      message?: unknown;
      next_step?: unknown;
      hint?: unknown;
    };
    const message = typeof parsed.message === 'string' ? parsed.message : text;
    const code = typeof parsed.error === 'string' ? `${parsed.error}: ` : '';
    const next = typeof parsed.next_step === 'string'
      ? parsed.next_step
      : typeof parsed.hint === 'string'
        ? parsed.hint
        : null;
    return `${code}${message}${next ? ` Next: ${next}` : ''}`;
  } catch {
    return text;
  }
}

export async function callPlatformToolRaw(
  name: string,
  args: Record<string, unknown>,
  options: PlatformToolCallOptions = {},
): Promise<CallToolResult> {
  const invocationArgs = ['job_create', 'ingest'].includes(name) && args.idempotency_key === undefined
    ? { ...args, idempotency_key: crypto.randomUUID() }
    : args;
  const result = await withPlatformClient(options, (client) =>
    client.callTool({ name, arguments: invocationArgs }));
  const typed = result as CallToolResult;
  if (typed.isError) {
    throw new PlatformToolError(name, toolErrorMessage(textFromResult(typed)));
  }
  return typed;
}

export function platformToolResultValue(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textFromResult(result);
  if (text) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return result.content;
}

export async function callPlatformTool(
  name: string,
  args: Record<string, unknown>,
  options: PlatformToolCallOptions = {},
): Promise<unknown> {
  return platformToolResultValue(await callPlatformToolRaw(name, args, options));
}

export async function callPlatformHelpTool(
  name: 'advisor' | 'catalog' | 'docs',
  args: Record<string, unknown>,
): Promise<string> {
  const result = await callPlatformToolRaw(name, args);
  const text = textFromResult(result);
  if (!text) throw new PlatformToolError(name, `${name} returned an empty response.`);
  return text;
}
