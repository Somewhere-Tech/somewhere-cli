/**
 * One way to name a project, on every command.
 *
 * The CLI grew two syntaxes: most commands take `--project <ref>`, but `logs`,
 * `errors`, `status`, `open` and `rollback` took only a positional and
 * answered `error: unknown option '--project'`. An agent that learned the flag
 * on `deploy` hit a wall on `logs`, with nothing in the message to suggest the
 * positional exists (parity finding #10).
 *
 * The fix is additive on purpose: the positional keeps working everywhere, so
 * nothing that runs today stops running, and the flag now works everywhere too.
 * Passing both is only an error when they disagree — repeating yourself is
 * harmless; naming two different projects in one command is not, and guessing
 * which one was meant is how the wrong project gets rolled back.
 */

export type ProjectRefChoice =
  | { kind: 'ref'; ref: string }
  /** Neither form was given — the caller falls back to the linked project. */
  | { kind: 'none' }
  | { kind: 'conflict'; positional: string; flag: string };

export function chooseProjectRef(
  positional: string | undefined,
  flag: string | undefined,
): ProjectRefChoice {
  const p = positional?.trim() || undefined;
  const f = flag?.trim() || undefined;
  if (p && f) {
    if (p !== f) return { kind: 'conflict', positional: p, flag: f };
    return { kind: 'ref', ref: f };
  }
  if (f) return { kind: 'ref', ref: f };
  if (p) return { kind: 'ref', ref: p };
  return { kind: 'none' };
}

export function projectRefConflictMessage(conflict: {
  positional: string;
  flag: string;
}): string {
  return (
    `Two different projects named in one command: \`${conflict.positional}\` and ` +
    `--project ${conflict.flag}. Pass one.`
  );
}
