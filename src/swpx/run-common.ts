/** Shared dependency-injection seam for the three run functions
 *  (run-swpx / run-swpm / check). Every external effect — registry resolution,
 *  the verdict API, spawning the real tool, reading the lockfile, and the two
 *  output streams — is overridable, so the orchestration logic is unit-tested
 *  with spies and never touches the network or spawns a process. Production
 *  callers pass `{}` and get the real implementations. */

import { resolveVersion as realResolveVersion } from './registry.js';
import {
  getVerdict as realGetVerdict,
  getVerdictBatch as realGetVerdictBatch,
  pollVerdictSummary as realPollVerdictSummary,
} from './verdict-client.js';
import { runReal as realRunReal } from './spawn.js';
import { readTree as realReadTree, type ResolvedTree } from './tree.js';
import type { Verdict } from './types.js';

export interface RunDeps {
  resolveVersion?: (name: string, version: string | undefined) => Promise<string>;
  getVerdict?: (name: string, version: string) => Promise<Verdict>;
  getVerdictBatch?: (pkgs: Array<{ package: string; version: string }>) => Promise<Verdict[]>;
  pollVerdictSummary?: (name: string, version: string) => Promise<Verdict | null>;
  runReal?: (cmd: 'npx' | 'npm', args: string[]) => Promise<number>;
  readTree?: (dir: string) => ResolvedTree;
  /** stdout — the command's product (check output, --json). */
  log?: (s: string) => void;
  /** stderr — verdict messaging + warnings, so wrapper noise stays off stdout. */
  errLog?: (s: string) => void;
  /** Test override for the fail-closed policy (production resolves it from
   *  flags/env/config via enforce.ts). */
  enforce?: boolean;
}

export interface BoundDeps {
  resolveVersion: (name: string, version: string | undefined) => Promise<string>;
  getVerdict: (name: string, version: string) => Promise<Verdict>;
  getVerdictBatch: (pkgs: Array<{ package: string; version: string }>) => Promise<Verdict[]>;
  pollVerdictSummary: (name: string, version: string) => Promise<Verdict | null>;
  runReal: (cmd: 'npx' | 'npm', args: string[]) => Promise<number>;
  readTree: (dir: string) => ResolvedTree;
  log: (s: string) => void;
  errLog: (s: string) => void;
}

export function bindDeps(deps: RunDeps): BoundDeps {
  return {
    resolveVersion: deps.resolveVersion ?? ((n, v) => realResolveVersion(n, v)),
    getVerdict: deps.getVerdict ?? ((n, v) => realGetVerdict(n, v)),
    getVerdictBatch: deps.getVerdictBatch ?? ((p) => realGetVerdictBatch(p)),
    pollVerdictSummary: deps.pollVerdictSummary ?? ((n, v) => realPollVerdictSummary(n, v)),
    runReal: deps.runReal ?? realRunReal,
    readTree: deps.readTree ?? realReadTree,
    log: deps.log ?? ((s) => console.log(s)),
    errLog: deps.errLog ?? ((s) => console.error(s)),
  };
}

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
