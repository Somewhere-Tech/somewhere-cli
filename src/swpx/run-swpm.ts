/** `swpm <args...>` — the verdict gate in front of `npm`.
 *
 *  Only install-family subcommands are gated (install/i/add/ci); everything else
 *  (run, test, publish, …) passes straight through to npm untouched. For an
 *  install we batch-check the resolved tree and print the summary, then:
 *    - any BLOCKED package  → stop, exit 1, don't install.
 *    - otherwise            → run the real npm install (unverified rows are
 *                             surfaced as warnings, not gates: a transitive dep
 *                             lacking provenance must not halt every install).
 *  Verdict service unreachable or an unresolvable tree → fall back to npm
 *  unchecked (a gate, not a wall). Summary goes to stderr; npm owns stdout. */

import { parseSpec } from './registry.js';
import { renderTree } from './render.js';
import { bindDeps, msg, type RunDeps } from './run-common.js';
import { dim } from '../lib/output.js';
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
  // A row the service didn't return is "unknown", which we surface as
  // unverified — never silently counted as verified.
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
  const sub = args[0];
  if (!sub || !INSTALL_SUBS.has(sub)) {
    return { exitCode: await d.runReal('npm', args), action: 'passthrough' };
  }

  const explicit = args.slice(1).filter((a) => !a.startsWith('-'));
  let toCheck: PkgRef[] = [];
  let directCount = 0;
  try {
    if (explicit.length) {
      // `swpm install foo bar@2` — check exactly what was named.
      toCheck = await Promise.all(
        explicit.map(async (a) => {
          const s = parseSpec(a);
          return { package: s.name, version: await d.resolveVersion(s.name, s.version) };
        }),
      );
      directCount = toCheck.length;
    } else {
      // `swpm install` — check the project's resolved tree.
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
        return { exitCode: await d.runReal('npm', args), action: 'passthrough' };
      }
    }
  } catch (err) {
    d.errLog(dim(`swpm: couldn't resolve the dependency tree (${msg(err)}) — running npm unchecked`));
    return { exitCode: await d.runReal('npm', args), action: 'fallback' };
  }

  let verdicts: Verdict[];
  try {
    verdicts = await d.getVerdictBatch(toCheck);
  } catch {
    d.errLog(dim('swpm: verdict service unavailable — running npm unchecked'));
    return { exitCode: await d.runReal('npm', args), action: 'fallback' };
  }

  const aligned = alignVerdicts(toCheck, verdicts);
  for (const l of renderTree(aligned, directCount)) d.errLog(l);

  if (aligned.some((v) => v.verdict === 'blocked')) {
    return { exitCode: 1, action: 'blocked' };
  }
  return { exitCode: await d.runReal('npm', args), action: 'ran' };
}
