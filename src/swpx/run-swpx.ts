/** `swpx <package> [args...]` — the verdict gate in front of `npx`.
 *
 *  resolve → verdict → act:
 *    verified           → print the green one-liner, delegate to real npx.
 *    unverified/suspicious → print the evidence block, STOP (exit 1). The user's
 *                           documented override is to run `npx` directly, per
 *                           the landing page ("your choice, not ours") — so we
 *                           deliberately do not prompt or take a --yes flag
 *                           (which would also collide with npx -y).
 *    blocked            → print the red block, hard refuse (exit 1, no run).
 *    can't resolve / verdict unreachable → fall back to npx unchecked. We are a
 *                           gate, not a wall: our outage must not stop the user.
 *
 *  All verdict messaging goes to STDERR so swpx is transparent on stdout — the
 *  executed program owns stdout. */

import { parseSpec } from './registry.js';
import { decide, renderVerdict } from './render.js';
import { bindDeps, type RunDeps } from './run-common.js';
import { resolveEnforce, stripEnforceFlags, loudUnavailable, refused } from './enforce.js';
import { VerdictUnavailable } from './verdict-client.js';

export interface SwpxOutcome {
  exitCode: number;
  action: 'ran' | 'blocked' | 'stopped' | 'fallback';
}

export async function runSwpx(args: string[], deps: RunDeps = {}): Promise<SwpxOutcome> {
  const d = bindDeps(deps);
  const enforce = deps.enforce ?? resolveEnforce(args);
  const passthrough = stripEnforceFlags(args);

  // The package is the first non-flag arg, so `swpx -y create-next-app` works.
  const pkgArg = passthrough.find((a) => !a.startsWith('-'));
  if (!pkgArg) {
    d.errLog('Usage: swpx <package> [args...]');
    return { exitCode: 1, action: 'stopped' };
  }
  const spec = parseSpec(pkgArg);

  // Couldn't verify → LOUD warning (never silent), then fall back (default) OR
  // refuse (enforce / fail-closed).
  const failOpen = async (rateLimited: boolean, cause?: string): Promise<SwpxOutcome> => {
    loudUnavailable(d.errLog, spec.name, rateLimited, cause);
    if (enforce) {
      refused(d.errLog, spec.name, 'npx');
      return { exitCode: 1, action: 'blocked' };
    }
    return { exitCode: await d.runReal('npx', passthrough), action: 'fallback' };
  };
  const causeOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

  let version: string;
  try {
    version = await d.resolveVersion(spec.name, spec.version);
  } catch (err) {
    return failOpen(false, causeOf(err));
  }

  let verdict;
  try {
    verdict = await d.getVerdict(spec.name, version);
  } catch (err) {
    return failOpen(err instanceof VerdictUnavailable && err.rateLimited, causeOf(err));
  }

  const action = decide(verdict);
  for (const l of renderVerdict(verdict)) d.errLog(l);
  if (action === 'run') {
    return { exitCode: await d.runReal('npx', passthrough), action: 'ran' };
  }
  // unverified/suspicious and blocked both stop swpx; only the exit reason differs.
  return { exitCode: 1, action: action === 'block' ? 'blocked' : 'stopped' };
}
