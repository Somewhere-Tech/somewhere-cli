import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const TAIL_LIMIT = 4_000;
const FILE_LIMIT = 8_000;

export interface LastRunRecord {
  command: string;
  args: string[];
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
  timestamp: string;
}

export interface AdvisorContext {
  project_ref?: string;
  last_run?: LastRunRecord;
  file?: { path: string; content: string };
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

/** Redact credentials before they can enter the local run record or leave this device. */
export function redactAdvisorText(value: string, redactDotenvValues = false): string {
  let redacted = value
    .replace(/\bBearer\s+[^\s'"`]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:smt|smtr|sk|pk|whsec)_[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|secret|password)\s*([:=])\s*([^\s,;]+)/gi,
      (_match, name: string, separator: string) => `${name}${separator} [REDACTED]`,
    );
  if (redactDotenvValues) {
    redacted = redacted.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=).*$/gm, '$1[REDACTED]');
  }
  return redacted;
}

function isDotenvPath(path: string): boolean {
  const name = basename(path);
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

export function buildAdvisorContext(filePath?: string): AdvisorContext | undefined {
  const context: AdvisorContext = {};
  if (filePath) {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('--file must name a regular file.');
    const content = readFileSync(filePath, 'utf8');
    context.file = {
      path: filePath,
      content: tail(redactAdvisorText(content, isDotenvPath(filePath)), FILE_LIMIT),
    };
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

export function contextNotice(context: AdvisorContext | undefined): string {
  return context?.file
    ? `Advisor context attached: explicitly selected file ${context.file.path}.`
    : 'Advisor context not attached; use --file to attach a redacted excerpt.';
}

export function normalizeLastRun(record: LastRunRecord): LastRunRecord {
  return {
    ...record,
    command: redactAdvisorText(record.command),
    args: record.args.map((arg) => redactAdvisorText(arg)),
    stdout_tail: tail(redactAdvisorText(record.stdout_tail), TAIL_LIMIT),
    stderr_tail: tail(redactAdvisorText(record.stderr_tail), TAIL_LIMIT),
  };
}
