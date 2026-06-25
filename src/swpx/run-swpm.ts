/** `swpm <args...>` — the verdict gate in front of `npm`.
 *
 *  Only install-family subcommands are gated (install/i/add/ci); everything else
 *  (run, test, publish, …) passes straight through to npm untouched. For an
 *  install we batch-check the resolved tree and print the summary, then:
 *    - any BLOCKED package  → stop, exit 1, don't install.
 *    - otherwise            → run the real npm install (unverified rows warn but
 *                             don't gate every install).
 *  Couldn't verify (unreachable / unresolvable tree) → LOUD warning then fall
 *  back to npm, OR refuse under enforce. Summary goes to stderr; npm owns stdout. */

import { parseSpec } from './registry.js';
import { renderTree } from './render.js';
import { bindDeps, type RunDeps } from './run-common.js';
import { dim } from '../lib/output.js';
import { resolveEnforce, stripEnforceFlags, loudUnavailable, refused } from './enforce.js';
import { VerdictUnavailable } from './verdict-client.js';
import type { Verdict } from './types.js';

/** npm's own install aliases (including its built-in typo aliases). */
const INSTALL_SUBS = new Set(['install', 'i', 'in', 'ins', 'add', 'ci', 'isntall']);

export interface SwpmOutcome {
  exitCode: number;
  action: 'ran' | 'blocked' | 'passthrough' | 'fallback';
}

interface PkgRef {
  package: string;
  version: string;
}

function alignVerdicts(toCheck: PkgRef[], verdicts: Verdict[]): Verdict[] {
  const byKey = new Map(verdicts.map((v) => [`${v.package}@${v.version}`, v]));
  // A row the service didn't return is "unknown" → surfaced as unverified, never
  // silently counted as verified.
  return toCheck.map(
    (t) =>
      byKey.get(`${t.package}@${t.version}`) ?? {
        package: t.package,
        version: t.version,
        verdict: 'unverified' as const,
      },
  );
}

export async function runSwpm(args: string[], deps: RunDeps = {}): Promise<SwpmOutcome> {
  const d = bindDeps(deps);
  const enforce = deps.enforce ?? resolveEnforce(args);
  const clean = stripEnforceFlags(args);

  const sub = clean[0];
  if (!sub || !INSTALL_SUBS.has(sub)) {
    return { exitCode: await d.runReal('npm', clean), action: 'passthrough' };
  }

  // Couldn't verify the tree → LOUD, then fall back (default) or refuse (enforce).
  const failOpen = async (rateLimited: boolean): Promise<SwpmOutcome> => {
    loudUnavailable(d.errLog, 'this install', rateLimited);
    if (enforce) {
      refused(d.errLog, 'this install', 'npm');
      return { exitCode: 1, action: 'blocked' };
    }
    return { exitCode: await d.runReal('npm', clean), action: 'fallback' };
  };

  const explicit = clean.slice(1).filter((a) => !a.startsWith('-'));
  let toCheck: PkgRef[] = [];
  let directCount = 0;
  try {
    if (explicit.length) {
      toCheck = await Promise.all(
        explicit.map(async (a) => {
          const s = parseSpec(a);
          return { package: s.name, version: await d.resolveVersion(s.name, s.version) };
        }),
      );
      directCount = toCheck.length;
    } else {
      const tree = d.readTree(process.cwd());
      if (tree.locked.length) {
        toCheck = tree.locked;
        const directSet = new Set(tree.directNames);
        directCount = tree.locked.filter((l) => directSet.has(l.package)).length;
      } else if (tree.directNames.length) {
        toCheck = await Promise.all(
          tree.directNames.map(async (name) => ({
            package: name,
            version: await d.resolveVersion(name, tree.ranges[name]),
          })),
        );
        directCount = toCheck.length;
      } else {
        d.errLog(dim('swpm: no dependencies found in package.json — running npm'));
        return { exitCode: await d.runReal('npm', clean), action: 'passthrough' };
      }
    }
  } catch {
    return failOpen(false);
  }

  let verdicts: Verdict[];
  try {
    verdicts = await d.getVerdictBatch(toCheck);
  } catch (err) {
    return failOpen(err instanceof VerdictUnavailable && err.rateLimited);
  }

  const aligned = alignVerdicts(toCheck, verdicts);
  for (const l of renderTree(aligned, directCount)) d.errLog(l);

  if (aligned.some((v) => v.verdict === 'blocked')) {
    return { exitCode: 1, action: 'blocked' };
  }
  return { exitCode: await d.runReal('npm', clean), action: 'ran' };
}
