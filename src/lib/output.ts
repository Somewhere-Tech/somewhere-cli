type Style = (value: string) => string;

let jsonOutputMode = false;
let jsonErrorWritten = false;

export function setJsonOutputMode(enabled: boolean): void {
  jsonOutputMode = enabled;
  jsonErrorWritten = false;
}

const useColor = (): boolean =>
  Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

function ansi(open: string, close: string): Style {
  return (value: string) => (useColor() ? `${open}${value}${close}` : value);
}

export const teal = ansi('\x1b[38;2;45;212;191m', '\x1b[39m');
export const dim = ansi('\x1b[2m', '\x1b[22m');
export const bold = ansi('\x1b[1m', '\x1b[22m');
export const red = ansi('\x1b[31m', '\x1b[39m');
export const green = ansi('\x1b[32m', '\x1b[39m');
export const yellow = ansi('\x1b[33m', '\x1b[39m');
export const cyan = ansi('\x1b[36m', '\x1b[39m');

export function success(msg: string) {
  console.log(`${green('✓')} ${msg}`);
}

/**
 * The platform's own refusal, exactly as it should reach `--json`.
 *
 * Both error types that carry one (the API's CliApiError and an MCP tool's
 * PlatformToolError) are matched by shape rather than imported: output.ts sits
 * below client.ts in the import graph. Anything else — a bad flag, a missing
 * file — originated in the CLI and has no code of its own.
 */
export function platformErrorEnvelope(
  cause: unknown,
): { code: string; message: string; extra: Record<string, unknown> } | null {
  if (!(cause instanceof Error)) return null;
  if (cause.name !== 'CliApiError' && cause.name !== 'PlatformToolError') return null;
  const typed = cause as Error & {
    code?: unknown;
    detail?: unknown;
    hint?: unknown;
    data?: unknown;
    meta?: { requestId?: string; traceId?: string; retry?: boolean; retryAfterMs?: number };
  };
  if (typeof typed.code !== 'string' || !typed.code) return null;
  const meta = typed.meta ?? {};
  return {
    code: typed.code,
    message: typeof typed.detail === 'string' ? typed.detail : typed.message,
    extra: {
      ...(typeof typed.hint === 'string' && typed.hint ? { hint: typed.hint } : {}),
      ...(meta.requestId ? { request_id: meta.requestId } : {}),
      ...(meta.traceId ? { trace_id: meta.traceId } : {}),
      ...(typeof meta.retry === 'boolean' ? { retry: meta.retry } : {}),
      ...(typeof meta.retryAfterMs === 'number' ? { retry_after_ms: meta.retryAfterMs } : {}),
      ...(typed.data && typeof typed.data === 'object' ? { data: typed.data } : {}),
    },
  };
}

/**
 * Print a failure. `cause` is the error behind it, when there is one: in
 * `--json` mode a platform refusal keeps its own code, message, hint and
 * request id, and only a failure that began in the CLI says CLI_ERROR.
 */
export function error(msg: string, cause?: unknown) {
  if (jsonOutputMode) {
    if (jsonErrorWritten) return;
    const platform = platformErrorEnvelope(cause);
    if (platform) printJsonError(platform.code, platform.message, platform.extra);
    else printJsonError('CLI_ERROR', stripAnsi(msg));
    return;
  }
  console.error(`${red('✗')} ${msg}`);
}

export function warn(msg: string) {
  console.log(`${yellow('!')} ${msg}`);
}

export function info(msg: string) {
  console.log(`  ${msg}`);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value ?? null, null, 2));
}

export function printJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value ?? null)}\n`);
}

export function printJsonError(
  errorCode: string,
  message: string,
  /** Envelope fields worth machine-reading — today the correlation ids. */
  extra?: Record<string, unknown>,
): void {
  jsonErrorWritten = true;
  printJson({ ok: false, error: errorCode, message, ...(extra ?? {}) });
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function heading(msg: string) {
  console.log(`\n${bold(msg)}\n`);
}

export function table(
  headers: string[],
  rows: string[][],
  widths?: number[],
) {
  const colWidths = widths ??
    headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)) + 2,
    );

  const headerLine = headers
    .map((h, i) => dim(h.toUpperCase().padEnd(colWidths[i])))
    .join('');
  console.log(`  ${headerLine}`);

  for (const row of rows) {
    const line = row
      .map((cell, i) => (cell ?? '').padEnd(colWidths[i]))
      .join('');
    console.log(`  ${line}`);
  }
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function statusDot(status: string): string {
  switch (status) {
    case 'deployed':
    case 'active':
    case 'ready':
      return `${green('●')} Production`;
    case 'draft':
      return `${dim('○')} Preview`;
    case 'archived':
      return `${dim('◌')} Archived`;
    case 'frozen':
      return `${yellow('●')} Frozen`;
    default:
      return status;
  }
}
