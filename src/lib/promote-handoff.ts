/**
 * The promote command the CLI hands back, and the two things it must say after
 * a promote lands.
 *
 * Both come out of the same parity run:
 *
 *  - The printed promote command could not be run in the shell that printed it.
 *    `somewhere preview` and `somewhere status` printed
 *    `somewhere promote <session> <preview>`; `somewhere promote` then refuses
 *    that exact command with "Refusing to promote without confirmation in a
 *    non-interactive shell" — so the one context where the hosted loop is the
 *    only way to see the app (an agent, a script, a piped terminal) is the one
 *    context where the CLI's own output does not work.
 *
 *  - Promotion moved the app and said nothing about the data. Preview rows stay
 *    in the preview database; that isolation is the point, but a developer who
 *    is not told rediscovers it by opening an empty production page and
 *    repeating the whole acceptance pass.
 *
 * Pure so both directions can be fixtured without a network or a terminal.
 */

/**
 * The promote command for a given shell.
 *
 * Non-interactive: one line, with `--yes`, because there is nobody to answer a
 * prompt and a command that cannot run is not a handoff.
 *
 * Interactive: the plain command first — a person at a keyboard should get the
 * confirmation, not be handed an unattended promote they did not ask for — and
 * the `--yes` form named after it, so the same output is still useful when it
 * is scrolled back to from a script.
 */
export function promoteCommands(args: {
  previewSessionId: string;
  previewId: string;
  projectRef: string;
  interactive: boolean;
}): string[] {
  const project = shellArgument(args.projectRef);
  const base = `somewhere promote ${args.previewSessionId} ${args.previewId} --project ${project}`;
  if (!args.interactive) return [`${base} --yes`];
  return [base, `${base} --yes`];
}

/** Quote an opaque project ref so the printed command is safe to paste into a
 * POSIX shell even when the ref is a project name rather than a UUID/slug. */
export function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The single command to print when only one line fits. Always runnable here. */
export function promoteCommandForShell(args: {
  previewSessionId: string;
  previewId: string;
  projectRef: string;
  interactive: boolean;
}): string {
  const commands = promoteCommands(args);
  return commands[0];
}

/** The label for each printed variant, so two lines are not two mysteries. */
export function promoteCommandLines(args: {
  previewSessionId: string;
  previewId: string;
  projectRef: string;
  interactive: boolean;
}): string[] {
  const commands = promoteCommands(args);
  if (commands.length === 1) return [`promote command: \`${commands[0]}\``];
  return [
    `promote command: \`${commands[0]}\``,
    `without the confirmation (scripts, agents): \`${commands[1]}\``,
  ];
}

/**
 * What a developer needs to know about their data the moment production
 * changes.
 *
 * The platform is adding a field that says this in its own words; when it
 * sends one, that wins, so the sentence can be corrected without waiting for a
 * CLI release. Until then the CLI says it from what it already knows, because
 * a line that waits on a deploy is a line nobody reads.
 */
export function promotedDataNotes(platformNote?: unknown): string[] {
  if (typeof platformNote === 'string' && platformNote.trim()) {
    return [platformNote];
  }
  return [
    'Only the app was promoted. Rows you created while previewing stayed in the preview database — production is serving the data it already had.',
    'Open production and check it end to end, and seed anything it needs, before you call this shipped.',
  ];
}
