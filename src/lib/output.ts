import chalk from 'chalk';

export const teal = chalk.hex('#2dd4bf');
export const dim = chalk.dim;
export const bold = chalk.bold;
export const red = chalk.red;
export const green = chalk.green;
export const yellow = chalk.yellow;

export function success(msg: string) {
  console.log(`${green('✓')} ${msg}`);
}

export function error(msg: string) {
  console.error(`${red('✗')} ${msg}`);
}

export function warn(msg: string) {
  console.log(`${yellow('!')} ${msg}`);
}

export function info(msg: string) {
  console.log(`  ${msg}`);
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
      return `${green('●')} Live`;
    case 'draft':
      return `${dim('○')} Draft`;
    case 'archived':
      return `${dim('◌')} Archived`;
    case 'frozen':
      return `${yellow('●')} Frozen`;
    default:
      return status;
  }
}
