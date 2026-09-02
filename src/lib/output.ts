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

export function error(msg: string) {
  if (jsonOutputMode) {
    if (!jsonErrorWritten) printJsonError('CLI_ERROR', stripAnsi(msg));
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

export function printJsonError(errorCode: string, message: string): void {
  jsonErrorWritten = true;
  printJson({ ok: false, error: errorCode, message });
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
