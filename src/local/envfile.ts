/**
 * Minimal .env parser for local dev. Values from .env / .env.local in the
 * project root feed sw.env when running functions locally — these files are
 * in the deploy IGNORE list, so nothing here ever leaves the machine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load .env then .env.local (local wins), from the project directory. */
export function loadLocalEnv(dir: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of ['.env', '.env.local']) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    Object.assign(merged, parseEnvFile(readFileSync(path, 'utf-8')));
  }
  return merged;
}
