import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dim, teal } from './output.js';

const PACKAGE = '@somewhere-tech/cli';
const CACHE_PATH = join(homedir(), '.somewhere', 'update-check.json');
const REGISTRY = `https://registry.npmjs.org/${PACKAGE.replace('/', '%2F')}/latest`;
const ONE_DAY = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1000;

// `somewhere <sub>` forms that must stay quiet: the pass-throughs (their own bins
// already bypass this file, but `somewhere swpx …` reaches here) and `update` itself.
const SKIP_SUBCOMMANDS = new Set(['swpx', 'swpm', 'x', 'm', 'npx', 'npm', 'update']);

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

function currentVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Numeric major.minor.patch compare, ignoring pre-release tags. Returns true when
 *  `a` is strictly newer than `b`, and false on anything unparseable (exported for
 *  tests — string compare would call 1.9.0 newer than 1.10.0). */
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

/** Returns a one-time "update available" notice (for stderr), or null. Throttled
 *  to one npm check per day (cached). Silent on non-interactive output, CI, the
 *  pass-through/update subcommands, and when SOMEWHERE_NO_UPDATE_NOTIFIER is set —
 *  so it never pollutes agent or piped output. Fail-open: any error returns null.
 *
 *  Print the result to STDERR after the command (e.g. via process.on('exit')) so
 *  it never touches stdout and lands as a parting line. */
export async function computeUpdateNotice(argv: string[]): Promise<string | null> {
  try {
    if (!process.stderr.isTTY) return null;
    if (process.env.CI || process.env.SOMEWHERE_NO_UPDATE_NOTIFIER) return null;

    const sub = argv[2];
    if (!sub || sub.startsWith('-') || SKIP_SUBCOMMANDS.has(sub)) return null;

    const current = currentVersion();
    let cache = readCache();
    if (!cache || Date.now() - cache.checkedAt > ONE_DAY) {
      const latest = await fetchLatest();
      if (latest) {
        writeCache(latest);
        cache = { checkedAt: Date.now(), latest };
      }
    }

    if (!cache?.latest || !isNewer(cache.latest, current)) return null;

    return (
      `\n  ${teal('▲ Update available')}  ${dim(current)} → ${teal(cache.latest)}\n` +
      `  Run ${teal('somewhere update')} to upgrade.  ${dim('(SOMEWHERE_NO_UPDATE_NOTIFIER=1 to silence)')}\n`
    );
  } catch {
    return null; // never let an update check break the CLI
  }
}
