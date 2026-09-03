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

function readCache(cachePath = CACHE_PATH): UpdateCache | null {
  try {
    const c = JSON.parse(readFileSync(cachePath, 'utf8')) as UpdateCache;
    // Guard a corrupt/absent checkedAt: NaN comparisons read as "fresh forever",
    // which would silence updates until the file is hand-deleted.
    if (typeof c?.checkedAt !== 'number') return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(latest: string | null, checkedAt: number, cachePath = CACHE_PATH): void {
  try {
    const dir = dirname(cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ checkedAt, latest }) + '\n', { mode: 0o600 });
  } catch {
    // best-effort cache; a failed write just means we re-check next time
  }
}

export interface UpdateNoticeOptions {
  cachePath?: string;
  fetchLatest?: () => Promise<string | null>;
  now?: () => number;
}

/** Resolve the ambient update notice without changing the installed CLI. The
 * injectable clock/cache/fetch keep both version directions and daily
 * throttling deterministic in tests. */
export async function getUpdateNotice(
  currentVersion: string,
  options: UpdateNoticeOptions = {},
): Promise<string | null> {
  const cachePath = options.cachePath ?? CACHE_PATH;
  const now = options.now ?? Date.now;
  const getLatest = options.fetchLatest ?? fetchLatest;
  let cache = readCache(cachePath);
  const checkedAt = now();
  if (!cache || checkedAt - cache.checkedAt > ONE_DAY) {
    const latest = await getLatest();
    // Stamp checkedAt even on failure so a blackholed network (captive portal,
    // proxy) doesn't make every command re-pay the fetch — retry is daily.
    const known = latest ?? cache?.latest ?? null;
    writeCache(known, checkedAt, cachePath);
    cache = { checkedAt, latest: known };
  }
  if (!cache.latest || !isNewer(cache.latest, currentVersion)) return null;
  return `${teal('▲ somewhere CLI update available')}  ${dim(currentVersion)} → ${teal(cache.latest)}  Run ${teal('somewhere update')} to upgrade.`;
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
      return await getUpdateNotice(currentVersion);
    } catch {
      return null;
    }
  },
};
