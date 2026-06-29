/** The user-notification pipeline.
 *
 *  A `NoticeProvider` is a source of an out-of-band, user-facing message — "a new
 *  CLI version is out", "a package you ran through swpx now has an advisory", a
 *  one-off announcement, etc. The pipeline (see ./index.ts) runs every registered
 *  provider behind a SINGLE central gate and emits the results to stderr as a
 *  parting line after the command. That gate is the safety contract: providers
 *  only run for interactive (TTY) `somewhere` invocations that are not CI, not a
 *  pass-through/safety command (swpx/swpm), and not opted out. So a notice can
 *  never reach stdout, agent/piped output, or the swpx/swpm verdict grading —
 *  adding a provider cannot trip up our own safety output. */
export interface NoticeContext {
  /** The full process argv, so a provider can branch on the subcommand if needed. */
  argv: string[];
  /** The installed CLI version (resolved once, centrally). */
  currentVersion: string;
}

export interface NoticeProvider {
  /** Stable id, for logging / per-provider opt-out later. */
  id: string;
  /** Return a short message to show (stderr), or null for nothing. MUST be
   *  fail-open: swallow all errors and return null. MUST be self-throttled (cache
   *  in ~/.somewhere) — the pipeline runs on every eligible command, so a provider
   *  that hits the network must not do so more than it needs to. */
  getNotice(ctx: NoticeContext): Promise<string | null>;
}
