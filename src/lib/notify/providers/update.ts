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
  /** Last known published version, or null if the last check failed (we still
   *  stamp checkedAt so we don't re-fetch on every command). */
  latest: string | null;
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
    const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as UpdateCache;
    // Guard a corrupt/absent checkedAt: NaN comparisons read as "fresh forever",
    // which would silence updates until the file is hand-deleted.
    if (typeof c?.checkedAt !== 'number') return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(latest: string | null): void {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ checkedAt: Date.now(), latest }) + '\n', { mode: 0o600 });
  } catch {
    // best-effort cache; a failed write just means we re-check next time
  }
}

async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer); // also clear on reject, so a pending timer can't hold the event loop
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
        // Stamp checkedAt even on failure so a blackholed network (captive portal,
        // proxy) doesn't make every command re-pay the fetch — retry is daily.
        const known = latest ?? cache?.latest ?? null;
        writeCache(known);
        cache = { checkedAt: Date.now(), latest: known };
      }
      if (!cache.latest || !isNewer(cache.latest, currentVersion)) return null;
      return (
        `  ${teal('▲ Update available')}  ${dim(currentVersion)} → ${teal(cache.latest)}\n` +
        `  Run ${teal('somewhere update')} to upgrade.  ${dim('(SOMEWHERE_NO_NOTIFICATIONS=1 to silence)')}`
      );
    } catch {
      return null;
    }
  },
};
