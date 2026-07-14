/** `swpx <package> [args...]` — the verdict gate in front of `npx`.
 *
 *  resolve → verdict → act:
 *    verified           → print a clear running headline plus the full evidence
 *                         checklist, then delegate to real npx.
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
import { green } from '../lib/output.js';

export interface SwpxOutcome {
  exitCode: number;
  action: 'ran' | 'blocked' | 'stopped' | 'fallback';
}

/** Values of npx's repeatable -p/--package flag, in either `--package X` /
 *  `-p X` or `--package=X` form. These are every package npx will install. */
function packageFlagValues(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--package' || a === '-p') {
      if (args[i + 1]) values.push(args[++i]);
    } else if (a.startsWith('--package=')) {
      values.push(a.slice('--package='.length));
    } else if (a.startsWith('-p=')) {
      values.push(a.slice('-p='.length));
    }
  }
  return values;
}

export async function runSwpx(args: string[], deps: RunDeps = {}): Promise<SwpxOutcome> {
  const d = bindDeps(deps);
  const enforce = deps.enforce ?? resolveEnforce(args);
  const passthrough = stripEnforceFlags(args);

  // npx's repeatable -p/--package names every package that actually gets installed;
  // the positional is just the binary to invoke (`npx -p typescript tsc`). Grade
  // all package values when present — otherwise one unchecked package could ride
  // behind a verified first value or positional command.
  // Falls back to the first non-flag arg (so `swpx -y create-next-app` still works).
  const packageFlags = packageFlagValues(passthrough);
  const positionalPackage = passthrough.find((a) => !a.startsWith('-'));
  const pkgArgs = packageFlags.length ? packageFlags : positionalPackage ? [positionalPackage] : [];
  if (!pkgArgs.length) {
    d.errLog('Usage: swpx <package> [args...]');
    return { exitCode: 1, action: 'stopped' };
  }
  const specs = pkgArgs.map(parseSpec);
  const npxCommand = `npx ${passthrough.join(' ')}`;

  // Couldn't verify → LOUD warning (never silent), then fall back (default) OR
  // refuse (enforce / fail-closed).
  const failOpen = async (packageName: string, rateLimited: boolean, cause?: string): Promise<SwpxOutcome> => {
    loudUnavailable(d.errLog, packageName, rateLimited, cause);
    if (enforce) {
      refused(d.errLog, packageName, 'npx');
      return { exitCode: 1, action: 'blocked' };
    }
    return { exitCode: await d.runReal('npx', passthrough), action: 'fallback' };
  };
  const causeOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

  let versions: string[];
  try {
    versions = await Promise.all(specs.map((spec) => d.resolveVersion(spec.name, spec.version)));
  } catch (err) {
    return failOpen(pkgArgs.join(', '), false, causeOf(err));
  }

  let verdicts;
  try {
    verdicts = await Promise.all(specs.map((spec, i) => d.getVerdict(spec.name, versions[i])));
  } catch (err) {
    return failOpen(
      pkgArgs.join(', '),
      err instanceof VerdictUnavailable && err.rateLimited,
      causeOf(err),
    );
  }

  const actions = verdicts.map(decide);
  if (actions.every((action) => action === 'run')) {
    d.errLog(green(`✓ Verified — running ${npxCommand}`));
  }
  for (const verdict of verdicts) {
    for (const l of renderVerdict(verdict, npxCommand)) d.errLog(l);
  }
  if (actions.every((action) => action === 'run')) {
    return { exitCode: await d.runReal('npx', passthrough), action: 'ran' };
  }
  // unverified/suspicious and blocked both stop swpx; only the exit reason differs.
  return { exitCode: 1, action: actions.includes('block') ? 'blocked' : 'stopped' };
}
