import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NoticeContext, NoticeProvider } from './types.js';
import { getOutdatedWarning, updateProvider } from './providers/update.js';

/** Registered notice sources. Add a provider here to surface a new kind of notice;
 *  it inherits the gate + stderr emission below, so it can never reach stdout,
 *  or agent/piped output. */
const PROVIDERS: NoticeProvider[] = [updateProvider];

/** Commands that manage the CLI update own their terminal output. */
const SKIP_SUBCOMMANDS = new Set(['update']);

/** Commands that own their output stay silent. In particular, an `update`
 * process keeps its old in-memory
 * version after installing the new package, so its generic exit notice would
 * otherwise repeat the update that just succeeded. */
export function subcommandSuppressesNotifications(argv: string[]): boolean {
  const sub = argv[2];
  return !sub || sub.startsWith('-') || SKIP_SUBCOMMANDS.has(sub);
}

function currentVersion(): string {
  try {
    // dist/lib/notify/index.js → package root is three levels up.
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** The one gate every provider inherits. If this returns false, NO provider runs,
 *  so notices can never appear on non-interactive output, in CI, during a
 *  safety/pass-through command, or when the user opted out. */
function notificationsAllowed(argv: string[], isTTY: boolean): boolean {
  if (!isTTY) return false; // agents, pipes, redirects, files
  if (process.env.CI) return false; // CI logs
  if (process.env.SOMEWHERE_NO_NOTIFICATIONS) return false; // global opt-out
  if (subcommandSuppressesNotifications(argv)) return false;
  return true;
}

export interface CollectNoticesOptions {
  isTTY?: boolean;
  outdatedWarning?: (currentVersion: string) => Promise<string | null>;
}

/** Run every provider (gated, in parallel, fail-open) and return the notices to
 *  display. Print these to STDERR after the command (e.g. via process.on('exit'))
 *  so they never touch stdout and land as a parting line.
 *
 *  Non-interactive callers (agents, pipes) get no providers, only the
 *  once-a-day outdated warning (CI and the opt-out get nothing): a CLI a minor release or more behind is the
 *  one notice an agent must see, because current docs describe commands it
 *  does not have yet. */
export async function collectNotices(argv: string[], options: CollectNoticesOptions = {}): Promise<string[]> {
  try {
    const isTTY = options.isTTY ?? Boolean(process.stderr.isTTY);
    if (!notificationsAllowed(argv, isTTY)) {
      // `somewhere docs` prints its own version line, so skip the duplicate.
      if (isTTY || process.env.CI || process.env.SOMEWHERE_NO_NOTIFICATIONS || subcommandSuppressesNotifications(argv)
        || argv[2] === 'docs') return [];
      const warning = await (options.outdatedWarning ?? getOutdatedWarning)(currentVersion()).catch(() => null);
      return warning ? [warning] : [];
    }
    const ctx: NoticeContext = { argv, currentVersion: currentVersion() };
    const results = await Promise.all(PROVIDERS.map((p) => p.getNotice(ctx).catch(() => null)));
    return results.filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return []; // never let the notification pipeline break the CLI
  }
}
