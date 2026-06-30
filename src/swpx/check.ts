/** `somewhere check <pkg>[@version] [--json]` (also `swpx check …`) — inspect a
 *  package WITHOUT running or installing anything. Prints the same verdict block
 *  as swpx, or the stable `--json` projection for agents.
 *
 *  Exit code is a severity ladder so it composes in CI / agent loops:
 *    0 verified · 1 unverified/suspicious · 2 blocked · 3 couldn't determine
 *  (unresolvable name or verdict service unreachable). Output is the command's
 *  product, so it goes to STDOUT (errors/unavailability to stderr). */

import { parseSpec } from './registry.js';
import { renderSingle, toJsonVerdict } from './render.js';
import { bindDeps, msg, type RunDeps } from './run-common.js';
import { VerdictUnavailable } from './verdict-client.js';
import type { VerdictLevel } from './types.js';
import { dim, yellow } from '../lib/output.js';

function exitForLevel(level: VerdictLevel): number {
  if (level === 'verified') return 0;
  if (level === 'blocked') return 2;
  return 1; // unverified | suspicious
}

export async function runCheck(
  specArg: string | undefined,
  opts: { json?: boolean } = {},
  deps: RunDeps = {},
): Promise<number> {
  const d = bindDeps(deps);
  if (!specArg) {
    d.errLog('Usage: somewhere check <package>[@version] [--json]');
    return 3;
  }
  const spec = parseSpec(specArg);

  let version: string;
  try {
    version = await d.resolveVersion(spec.name, spec.version);
  } catch (err) {
    d.errLog(`Could not resolve ${spec.name}: ${msg(err)}`);
    return 3;
  }

  let verdict;
  try {
    verdict = await d.getVerdict(spec.name, version);
  } catch (err) {
    const rl = err instanceof VerdictUnavailable && err.rateLimited;
    d.errLog(
      rl
        ? `${yellow('⚠')} Rate limited — couldn't check ${spec.name}. Wait a moment and retry.`
        : `${yellow('⚠')} Could not verify ${spec.name}@${version} — the verdict service was unreachable.`,
    );
    if (!rl) d.errLog(`  ${dim(`Reason: ${err instanceof Error ? err.message : String(err)}`)}`);
    return 3;
  }

  if (opts.json) {
    d.log(JSON.stringify(toJsonVerdict(verdict), null, 2));
  } else {
    for (const l of renderSingle(verdict)) d.log(l);
  }
  return exitForLevel(verdict.verdict);
}
