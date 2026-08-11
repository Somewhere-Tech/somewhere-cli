import { loadProjectConfig } from './config.js';

export function resolveProjectRef(explicit: string | undefined): string {
  if (explicit) return explicit;
  const config = loadProjectConfig();
  if (config?.project_id) return config.project_id;
  throw new Error('No project. Pass --project <slug-or-id> or run from a linked directory.');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function unwrapPlatformData(value: unknown): unknown {
  if (isRecord(value) && value.ok === true && 'data' in value) return value.data;
  return value;
}

export function compactRecord(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

export function parseCommaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function truncateText(value: unknown, max = 72): string {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
