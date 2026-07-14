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

/** Common npm config flags whose value may be a separate argv token. npm exposes
 *  the complete schema through its private @npmcli/config package, which would be
 *  too large and unstable to ship in this wrapper. Keep the global/path/network/
 *  workspace flags that users realistically put before a command here; `--x=y`
 *  forms need no entry because the value is already in the same token. */
const NPM_VALUE_FLAGS = new Set([
  '--audit-level',
  '--auth-type',
  '--before',
  '--ca',
  '--cache',
  '--cafile',
  '--cert',
  '--cpu',
  '--depth',
  '--fetch-retries',
  '--fetch-retry-factor',
  '--fetch-retry-maxtimeout',
  '--fetch-retry-mintimeout',
  '--fetch-timeout',
  '--globalconfig',
  '--https-proxy',
  '--include',
  '--install-strategy',
  '--key',
  '--libc',
  '--local-address',
  '--location',
  '--loglevel',
  '--logs-dir',
  '--maxsockets',
  '--node-options',
  '--noproxy',
  '--omit',
  '--otp',
  '--prefix',
  '--proxy',
  '--registry',
  '--replace-registry-host',
  '--save-prefix',
  '--scope',
  '--script-shell',
  '--tag',
  '--userconfig',
  '--workspace',
  '-C',
  '-L',
  '-w',
]);

export interface SwpmOutcome {
  exitCode: number;
  action: 'ran' | 'blocked' | 'passthrough' | 'fallback';
}

interface PkgRef {
  package: string;
  version: string;
}

interface NpmPositional {
  index: number;
  value: string;
}

/** Return npm's positional tokens while consuming the separate values of the
 *  common config flags above. This is enough to distinguish
 *  `--prefix /x install evil` as command `install`, package `evil`. */
function npmPositionals(args: string[]): NpmPositional[] {
  const out: NpmPositional[] = [];
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!positionalOnly && value === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && value.startsWith('-')) {
      if (!value.includes('=') && NPM_VALUE_FLAGS.has(value) && i + 1 < args.length) i++;
      continue;
    }
    out.push({ index: i, value });
  }
  return out;
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

  // npm accepts config flags (and a `--` terminator) before the subcommand. Parse
  // their common separate-value forms so a flag value cannot hide an install.
  const positionals = npmPositionals(clean);
  const subIdx = positionals[0]?.index ?? -1;
  const sub = positionals[0]?.value;
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

  const explicit = positionals.slice(1).map((arg) => arg.value);
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
