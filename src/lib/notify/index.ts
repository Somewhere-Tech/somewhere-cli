import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NoticeContext, NoticeProvider } from './types.js';
import { updateProvider } from './providers/update.js';
// import { advisoryProvider } from './providers/advisory.js'; // dormant — see that file

/** Registered notice sources. Add a provider here to surface a new kind of notice;
 *  it inherits the gate + stderr emission below, so it can never reach stdout,
 *  agent/piped output, or swpx/swpm verdict grading. */
const PROVIDERS: NoticeProvider[] = [updateProvider];

/** `somewhere <sub>` forms that must stay silent: the verdict/safety pass-throughs
 *  (their own bins already bypass this entry, but `somewhere swpx …` reaches here)
 *  and the machine-oriented npx/npm aliases. */
const SKIP_SUBCOMMANDS = new Set(['swpx', 'swpm', 'x', 'm', 'npx', 'npm', 'update']);

/** Commands that own their output or run in a safety-sensitive pass-through
 * stay silent. In particular, an `update` process keeps its old in-memory
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
function notificationsAllowed(argv: string[]): boolean {
  if (!process.stderr.isTTY) return false; // agents, pipes, redirects, files
  if (process.env.CI) return false; // CI logs
  if (process.env.SOMEWHERE_NO_NOTIFICATIONS) return false; // global opt-out
  if (subcommandSuppressesNotifications(argv)) return false;
  return true;
}

/** Run every provider (gated, in parallel, fail-open) and return the notices to
 *  display. Print these to STDERR after the command (e.g. via process.on('exit'))
 *  so they never touch stdout and land as a parting line. */
export async function collectNotices(argv: string[]): Promise<string[]> {
  try {
    if (!notificationsAllowed(argv)) return [];
    const ctx: NoticeContext = { argv, currentVersion: currentVersion() };
    const results = await Promise.all(PROVIDERS.map((p) => p.getNotice(ctx).catch(() => null)));
    return results.filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return []; // never let the notification pipeline break the CLI
  }
}
