import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { cliConfigDir, loadProjectConfig } from './config.js';

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

function readLastRun(): LastRunRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(`${cliConfigDir()}/last-run.json`, 'utf8')) as LastRunRecord;
    return typeof parsed?.command === 'string' && Array.isArray(parsed.args) ? normalizeLastRun(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function isDotenvPath(path: string): boolean {
  const name = basename(path);
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

export function buildAdvisorContext(filePath?: string): AdvisorContext | undefined {
  const project = loadProjectConfig();
  const context: AdvisorContext = {};
  if (project?.project_id) context.project_ref = project.project_id;
  const lastRun = readLastRun();
  if (lastRun) context.last_run = lastRun;
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
  if (!context) return 'Advisor context not attached.';
  const attached = [
    context.project_ref ? 'linked project' : null,
    context.last_run ? 'last run' : null,
    context.file ? `file ${context.file.path}` : null,
  ].filter((value): value is string => value !== null);
  return `Advisor context attached: ${attached.join(', ')}.`;
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
