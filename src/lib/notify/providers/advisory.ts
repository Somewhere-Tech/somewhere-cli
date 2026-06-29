import type { NoticeProvider } from '../types.js';

/** DORMANT — the pipe for "a package you previously ran through swpx/swpm now has
 *  a security advisory." Not registered in ../index.ts yet; wire it when we want it.
 *
 *  How to turn it on (kept separate from the verdict path so it can never affect
 *  safety grading):
 *
 *   1. RECORD USAGE — in the swpx/swpm bins, after a run resolves, append
 *      {name, version, ts} to ~/.somewhere/used-packages.json. This write MUST be
 *      fail-open and off the critical path (a try/catch around an async write); it
 *      must never block the install or change the verdict output.
 *
 *   2. CHECK HERE — read that file, throttle (e.g. a `checkedAt` stamp, once / 6h),
 *      batch-query the verdict API for those package@versions, and return a notice
 *      if any flipped to suspicious/blocked SINCE the user used them (compare
 *      against a stored last-seen verdict so we only alert on the transition, not
 *      every run). Keep it to one line, e.g.:
 *        "⚠ A package you used (foo@1.2.3) now has an advisory. swpx check foo@1.2.3"
 *
 *   3. REGISTER — add `advisoryProvider` to PROVIDERS in ../index.ts.
 *
 *  It inherits the central gate, so it's already stderr-only, interactive-only,
 *  and silent during swpx/swpm runs — it surfaces as ambient awareness on normal
 *  `somewhere` usage, never inline with a live verdict. */
export const advisoryProvider: NoticeProvider = {
  id: 'pkg-advisory',
  async getNotice() {
    return null; // pipe laid; dormant until the steps above are built
  },
};
