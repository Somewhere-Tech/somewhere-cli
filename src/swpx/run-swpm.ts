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

  // npm accepts config flags (and a `--` terminator) BEFORE the subcommand, so the
  // command is the first non-flag token, not necessarily clean[0]. Keying off
  // clean[0] let `swpm -g install evil` / `swpm -- install evil` skip the gate
  // silently. (Residual: a value-flag whose value precedes the sub, e.g.
  // `swpm --prefix /x install`, can still hide it — needs npm's flag schema.)
  const subIdx = clean.findIndex((a) => !a.startsWith('-'));
  const sub = subIdx === -1 ? undefined : clean[subIdx];
  if (!sub || !INSTALL_SUBS.has(sub)) {
    return { exitCode: await d.runReal('npm', clean), action: 'passthrough' };
  }

  // Couldn't verify the tree → LOUD, then fall back (default) or refuse (enforce).
  const failOpen = async (rateLimited: boolean, cause?: string): Promise<SwpmOutcome> => {
    loudUnavailable(d.errLog, 'this install', rateLimited, cause);
    if (enforce) {
      refused(d.errLog, 'this install', 'npm');
      return { exitCode: 1, action: 'blocked' };
    }
    return { exitCode: await d.runReal('npm', clean), action: 'fallback' };
  };
  const causeOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const explicit = clean.slice(subIdx + 1).filter((a) => !a.startsWith('-'));
  let toCheck: PkgRef[] = [];
  let directCount = 0;
  const directPackageNames = new Set<string>();
  try {
    if (explicit.length) {
      toCheck = await Promise.all(
        explicit.map(async (a) => {
          const s = parseSpec(a);
          return { package: s.name, version: await d.resolveVersion(s.name, s.version) };
        }),
      );
      directCount = toCheck.length;
      for (const pkg of toCheck) directPackageNames.add(pkg.package);
    } else {
      const tree = d.readTree(process.cwd());
      for (const name of tree.directNames) directPackageNames.add(name);
      if (tree.locked.length) {
        toCheck = tree.locked;
        const directSet = new Set(tree.directNames);
        directCount = tree.locked.filter((l) => directSet.has(l.package)).length;
        // A dep added to package.json AFTER the lockfile was written isn't in
        // `locked`, but `npm install` will add it — resolve + check those too, or
        // they'd install unchecked behind a clean "N verified" summary.
        const lockedNames = new Set(tree.locked.map((l) => l.package));
        const missing = tree.directNames.filter((n) => !lockedNames.has(n));
        if (missing.length) {
          const extra = await Promise.all(
            missing.map(async (name) => ({
              package: name,
              version: await d.resolveVersion(name, tree.ranges[name]),
            })),
          );
          toCheck = [...toCheck, ...extra];
          directCount += extra.length;
        }
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
  } catch (err) {
    return failOpen(false, causeOf(err));
  }

  let verdicts: Verdict[];
  try {
    verdicts = await d.getVerdictBatch(toCheck);
  } catch (err) {
    return failOpen(err instanceof VerdictUnavailable && err.rateLimited, causeOf(err));
  }

  const aligned = alignVerdicts(toCheck, verdicts);
  const pendingIndexes = aligned
    .map((verdict, index) => ({ verdict, index }))
    .filter(({ verdict }) =>
      directPackageNames.has(verdict.package)
      && (verdict.verdict === 'unverified' || verdict.verdict === 'suspicious')
      && !verdict.summary?.trim())
    .map(({ index }) => index);
  if (pendingIndexes.length > 0) {
    d.errLog(dim('Generating LLM summary…'));
    const refreshed = await Promise.all(
      pendingIndexes.map(async (index) => {
        const verdict = aligned[index];
        try {
          return await d.pollVerdictSummary(verdict.package, verdict.version);
        } catch {
          return null;
        }
      }),
    );
    let unresolved = 0;
    refreshed.forEach((verdict, resultIndex) => {
      const alignedIndex = pendingIndexes[resultIndex];
      if (verdict?.summary?.trim()) aligned[alignedIndex] = verdict;
      else unresolved++;
    });
    if (unresolved > 0) {
      d.errLog(dim(
        unresolved === 1
          ? 'LLM summary timed out — continuing with raw verdict metadata.'
          : `LLM summaries timed out for ${unresolved} packages — continuing with raw verdict metadata.`,
      ));
    }
  }
  for (const l of renderTree(aligned, directCount)) d.errLog(l);

  // Halt on a hard block OR any level we don't recognize as installable. Known
  // installable levels warn but proceed (unverified/suspicious); an unrecognized
  // or future-harsher level (e.g. "quarantined") must NOT install behind a warn.
  const INSTALLABLE = new Set(['verified', 'unverified', 'suspicious']);
  if (aligned.some((v) => !INSTALLABLE.has(v.verdict))) {
    return { exitCode: 1, action: 'blocked' };
  }
  return { exitCode: await d.runReal('npm', clean), action: 'ran' };
}
