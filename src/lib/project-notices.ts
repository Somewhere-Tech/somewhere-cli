import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApiClient } from './client.js';

export interface ProjectNotice {
  id: string;
  title: string;
  body_md: string;
  severity: 'info' | 'action_required' | 'critical';
  action_hint: string;
  target_runtime_version: number;
  current_runtime_version: number | null;
  created_at: number;
}

interface ProjectNoticeResponse {
  project_id: string;
  notices: ProjectNotice[];
}

interface LocalNoticeState {
  shown: Record<string, string>;
}

// Notices are optional context on the deploy path. They must never consume the
// normal API timeout budget before deploy progress even starts.
const PROJECT_NOTICE_TIMEOUT_MS = 3_000;

export interface ShowProjectNoticeOptions {
  now?: number;
  statePath?: string;
  write?: (line: string) => void;
}

function localDay(now: number): string {
  const date = new Date(now);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}

function readState(path: string): LocalNoticeState {
  if (!existsSync(path)) return { shown: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LocalNoticeState>;
    return parsed.shown && typeof parsed.shown === 'object' ? { shown: parsed.shown } : { shown: {} };
  } catch {
    return { shown: {} };
  }
}

function compact(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function formatProjectNotice(notice: ProjectNotice): string {
  const severity = notice.severity === 'action_required' ? 'action required' : notice.severity;
  return `[somewhere notice · ${severity}] ${compact(notice.title, 120)} — ${compact(notice.action_hint, 220)}`;
}

export async function showProjectNotices(
  client: ApiClient,
  projectRef: string,
  options: ShowProjectNoticeOptions = {},
): Promise<ProjectNotice[]> {
  const now = options.now ?? Date.now();
  const day = localDay(now);
  const statePath = options.statePath ?? join(homedir(), '.somewhere', 'project-notices.json');
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  try {
    const response = await client.call<ProjectNoticeResponse>(
      'GET',
      `/projects/${encodeURIComponent(projectRef)}/notices`,
      undefined,
      undefined,
      { timeoutMs: PROJECT_NOTICE_TIMEOUT_MS },
    );
    const state = readState(statePath);
    const unseen = response.notices.filter((notice) => state.shown[`${response.project_id}:${notice.id}`] !== day);
    if (unseen.length === 0) return [];

    for (const notice of unseen) write(formatProjectNotice(notice));

    const shown = Object.fromEntries(Object.entries(state.shown).filter(([, shownDay]) => shownDay === day));
    for (const notice of unseen) shown[`${response.project_id}:${notice.id}`] = day;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ shown }, null, 2) + '\n', { mode: 0o600 });
    return unseen;
  } catch {
    // Advisories are additive context. A lookup or local-state failure must
    // never block deploy/dev or change their exit status.
    return [];
  }
}
