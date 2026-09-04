/**
 * The first `npx @somewhere-tech/cli …` on a cold cache can sit silent for a
 * minute. That silence is npm's, not ours: npm downloads and installs the
 * package BEFORE it runs the entrypoint, so no JavaScript we ship can print
 * during it — there is nothing running yet to print.
 *
 * What the CLI can do is speak the instant it is handed control, which marks the
 * boundary between "npm was still fetching" and "the CLI is working" and tells a
 * waiting human the version they actually got.
 *
 * Rules, so this can never break a caller:
 *   - stderr only. stdout stays byte-identical for pipes, `--json`, and agents.
 *   - interactive only (stdout is a TTY). Redirected or captured output, CI logs
 *     and agent invocations see nothing new.
 *   - never on the npx/npm pass-through commands, whose output belongs to the
 *     tool being wrapped.
 */
export interface StartupNoticeContext {
  isTTY: boolean;
  jsonOutput: boolean;
  passThrough: boolean;
}

export function startupNotice(version: string, ctx: StartupNoticeContext): string | null {
  if (!ctx.isTTY || ctx.jsonOutput || ctx.passThrough) return null;
  return `starting somewhere CLI ${version}`;
}
