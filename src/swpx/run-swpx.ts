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
import { dim } from '../lib/output.js';
import type { Verdict } from './types.js';

export interface SwpxOutcome {
  exitCode: number;
  action: 'ran' | 'blocked' | 'stopped' | 'fallback';
}

/** The value of npx's -p/--package flag, in either `--package X` / `-p X` or
 *  `--package=X` form — the package npx actually installs. Returns the first such
 *  value (multiple -p flags are rare; noted as a residual). null if absent. */
function packageFlagValue(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--package' || a === '-p') return args[i + 1] ?? null;
    if (a.startsWith('--package=')) return a.slice('--package='.length);
    if (a.startsWith('-p=')) return a.slice('-p='.length);
  }
  return null;
}

export async function runSwpx(args: string[], deps: RunDeps = {}): Promise<SwpxOutcome> {
  const d = bindDeps(deps);
  const enforce = deps.enforce ?? resolveEnforce(args);
  const passthrough = stripEnforceFlags(args);

  // npx's -p/--package names the package that actually gets installed and run; the
  // positional is just the binary to invoke from it (`npx -p typescript tsc`). So
  // grade the --package value when present — otherwise `swpx --package=evil helper`
  // would grade `helper`, print a green "verified", and let npx fetch+run `evil`.
  // Falls back to the first non-flag arg (so `swpx -y create-next-app` still works).
  const pkgArg = packageFlagValue(passthrough) ?? passthrough.find((a) => !a.startsWith('-'));
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

  let verdict: Verdict;
  try {
    verdict = await d.getVerdict(spec.name, version);
  } catch (err) {
    return failOpen(err instanceof VerdictUnavailable && err.rateLimited, causeOf(err));
  }

  if (verdict.verdict !== 'blocked' && !verdict.summary?.trim()) {
    d.errLog(dim('Generating LLM summary…'));
    let enriched: Verdict | null = null;
    try {
      enriched = await d.pollVerdictSummary(spec.name, version);
    } catch {
      // Summary generation is presentation-only. Keep the mechanical verdict.
    }
    if (enriched?.summary?.trim()) {
      verdict = enriched;
    } else {
      d.errLog(dim('LLM summary timed out — continuing with raw verdict metadata.'));
    }
  }

  const action = decide(verdict);
  for (const l of renderVerdict(verdict)) d.errLog(l);
  if (action === 'run') {
    return { exitCode: await d.runReal('npx', passthrough), action: 'ran' };
  }
  // unverified/suspicious and blocked both stop swpx; only the exit reason differs.
  return { exitCode: 1, action: action === 'block' ? 'blocked' : 'stopped' };
}
