/**
 * What a promote actually did — as opposed to what the response said.
 *
 * A promote is the one irreversible step in the preview loop, so it is the one
 * command that must never report an outcome it does not know (tsk_33023348: a
 * promote that had SHIPPED printed "Promote failed / Unknown error", and the
 * obvious retry then said "Production was not changed" about production that
 * had already changed).
 *
 * The rule this module encodes: a failure the CLI could not READ is not a
 * failure it can REPORT. The platform stamps every response with correlation
 * ids and, on a refusal it authored, an error code. When neither is present —
 * a dropped connection, a timeout, a 5xx, a body of a shape we do not know —
 * the only honest source of truth is the project's production pointer
 * (`active_release_id`), read again after the fact.
 *
 * Everything here is pure so both directions can be fixtured without a network.
 */

import { CliApiError } from './client.js';

/**
 * Did the platform read this request and decide, or did we never learn the
 * answer?
 *
 * A 4xx carrying the platform's own error code is a decision: the request
 * reached the route, the route refused it, and production is whatever the
 * refusal says. Anything else — no HTTP response at all (statusCode 0), a 5xx,
 * or a body this CLI could not classify — leaves the outcome genuinely unknown,
 * because the flip may have landed before the connection died.
 */
export function isUnreadablePromoteResponse(err: unknown): boolean {
  if (!(err instanceof CliApiError)) return true;
  if (err.statusCode === 0) return true;
  if (err.statusCode >= 500) return true;
  return err.code === 'UNKNOWN' || err.code === 'INVALID_RESPONSE';
}

/**
 * The production pointer as the CLI managed to read it. `known: false` is NOT
 * "no release" — it is "the read itself failed", and the two must never
 * collapse, because "no release" would otherwise look like evidence.
 */
export type ActivePointer =
  | { known: true; releaseId: string | null; version: number | null }
  | { known: false };

export type PromoteVerdict =
  /** The pointer moved: production is serving something new. The promote landed. */
  | { kind: 'applied'; activeReleaseId: string }
  /** The pointer is where it was: production was genuinely not changed. */
  | { kind: 'not_applied'; activeReleaseId: string | null }
  /** We could not read the pointer on one side or the other. Say so; claim nothing. */
  | { kind: 'unknown' };

/**
 * Decide what happened from the production pointer before and after.
 *
 * `before` is read immediately before the promote is sent, so the comparison is
 * against the exact release the developer was live on when they ran the command
 * — not against the candidate, which is a draft artifact and never becomes the
 * active release id (promote rebuilds the candidate through the ordinary
 * release path, so a landed promote produces a THIRD id, distinct from both).
 * That is precisely why "did production change?" is the only usable question.
 */
export function promoteVerdictFromPointer(args: {
  before: ActivePointer;
  after: ActivePointer;
}): PromoteVerdict {
  const { before, after } = args;
  if (!after.known) return { kind: 'unknown' };
  if (!before.known) return { kind: 'unknown' };
  if (after.releaseId === before.releaseId) {
    return { kind: 'not_applied', activeReleaseId: after.releaseId };
  }
  // A project with nothing live that now has something live has been changed
  // just as much as one whose pointer moved between two releases.
  if (after.releaseId === null) return { kind: 'unknown' };
  return { kind: 'applied', activeReleaseId: after.releaseId };
}

/**
 * The customer-facing lines for a promote whose response we could not read.
 *
 * Rule 8: no release ids in the sentence a person reads — the id is evidence,
 * printed as a separate reference line by the caller, not part of the claim.
 */
export function describeUnreadablePromote(verdict: PromoteVerdict): {
  /** True when production really is carrying the promoted app. */
  succeeded: boolean;
  headline: string;
  detail: string;
} {
  switch (verdict.kind) {
    case 'applied':
      return {
        succeeded: true,
        headline: 'Promoted to production.',
        detail:
          'The connection dropped before the platform could confirm it, so this was checked ' +
          'against production directly: production is now serving the previewed app. ' +
          'Nothing to redo.',
      };
    case 'not_applied':
      return {
        succeeded: false,
        headline: 'Promote failed. Production was not changed.',
        detail:
          'This was checked against production directly — it is still serving the version it ' +
          'was serving before. Run the promote again.',
      };
    case 'unknown':
      return {
        succeeded: false,
        headline: 'Promote status unknown.',
        detail:
          'The platform did not finish answering, and production could not be read back to ' +
          'check. Open your production URL to see which version is live before running the ' +
          'promote again.',
      };
  }
}

/**
 * A refusal the platform authored is reported as the platform wrote it — except
 * that the CLI has one thing the route does not: it can read the production
 * pointer after the fact. When a refusal asserts production is untouched and
 * the pointer says otherwise, the pointer wins and the CLI says so.
 *
 * This is the second half of tsk_33023348: promoting twice is the obvious
 * response to a false "failed", and the second attempt used to answer with a
 * confident falsehood.
 */
export function refusalContradictsProduction(args: {
  message: string;
  /** The release the CLI recorded as live when the promote was last attempted. */
  expectedUnchanged: string | null;
  after: ActivePointer;
}): boolean {
  if (!/production was not (changed|touched)/i.test(args.message)) return false;
  if (!args.after.known) return false;
  if (args.expectedUnchanged === null) return false;
  return args.after.releaseId !== args.expectedUnchanged;
}
