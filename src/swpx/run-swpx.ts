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
import { decide, renderBlocked, renderEvidence, renderVerified } from './render.js';
import { bindDeps, msg, type RunDeps } from './run-common.js';
import { dim } from '../lib/output.js';

export interface SwpxOutcome {
  exitCode: number;
  action: 'ran' | 'blocked' | 'stopped' | 'fallback';
}

export async function runSwpx(args: string[], deps: RunDeps = {}): Promise<SwpxOutcome> {
  const d = bindDeps(deps);

  // The package is the first non-flag arg, so `swpx -y create-next-app` works.
  const pkgArg = args.find((a) => !a.startsWith('-'));
  if (!pkgArg) {
    d.errLog('Usage: swpx <package> [args...]');
    return { exitCode: 1, action: 'stopped' };
  }
  const spec = parseSpec(pkgArg);

  let version: string;
  try {
    version = await d.resolveVersion(spec.name, spec.version);
  } catch (err) {
    d.errLog(dim(`swpx: couldn't resolve ${spec.name} (${msg(err)}) — running npx unchecked`));
    return { exitCode: await d.runReal('npx', args), action: 'fallback' };
  }

  let verdict;
  try {
    verdict = await d.getVerdict(spec.name, version);
  } catch {
    d.errLog(dim('swpx: verdict service unavailable — running npx unchecked'));
    return { exitCode: await d.runReal('npx', args), action: 'fallback' };
  }

  switch (decide(verdict)) {
    case 'run':
      d.errLog(renderVerified(verdict));
      return { exitCode: await d.runReal('npx', args), action: 'ran' };
    case 'block':
      for (const l of renderBlocked(verdict)) d.errLog(l);
      return { exitCode: 1, action: 'blocked' };
    default:
      for (const l of renderEvidence(verdict)) d.errLog(l);
      return { exitCode: 1, action: 'stopped' };
  }
}
