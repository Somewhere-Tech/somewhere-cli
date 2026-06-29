import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dim, teal } from '../../output.js';
import type { NoticeProvider } from '../types.js';

const PACKAGE = '@somewhere-tech/cli';
const CACHE_PATH = join(homedir(), '.somewhere', 'update-check.json');
const REGISTRY = `https://registry.npmjs.org/${PACKAGE.replace('/', '%2F')}/latest`;
const ONE_DAY = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1000;

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

/** Numeric major.minor.patch compare, ignoring pre-release tags. Returns true when
 *  `a` is strictly newer than `b`, false on anything unparseable (exported for
 *  tests — a string compare would call 1.9.0 newer than 1.10.0). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.split('-')[0].split('.').map((n) => Number(n));
  const pa = parse(a);
  const pb = parse(b);
  if (pa.length < 3 || pb.length < 3 || [...pa, ...pb].some((n) => Number.isNaN(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ checkedAt: Date.now(), latest }) + '\n', { mode: 0o600 });
  } catch {
    // best-effort cache; a failed write just means we re-check next time
  }
}

async function fetchLatest(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(REGISTRY, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/** Notice provider: a newer @somewhere-tech/cli is published. Self-throttled to one
 *  npm check per day (cached in ~/.somewhere/update-check.json). The pipeline's
 *  central gate already ensured this only runs on interactive, non-CI, non-pass-
 *  through commands, so this provider just answers "is there an update?". */
export const updateProvider: NoticeProvider = {
  id: 'cli-update',
  async getNotice({ currentVersion }) {
    try {
      let cache = readCache();
      if (!cache || Date.now() - cache.checkedAt > ONE_DAY) {
        const latest = await fetchLatest();
        if (latest) {
          writeCache(latest);
          cache = { checkedAt: Date.now(), latest };
        }
      }
      if (!cache?.latest || !isNewer(cache.latest, currentVersion)) return null;
      return (
        `  ${teal('▲ Update available')}  ${dim(currentVersion)} → ${teal(cache.latest)}\n` +
        `  Run ${teal('somewhere update')} to upgrade.  ${dim('(SOMEWHERE_NO_NOTIFICATIONS=1 to silence)')}`
      );
    } catch {
      return null;
    }
  },
};
