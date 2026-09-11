/**
 * What to run next, decided in ONE place.
 *
 * Invariants:
 *  - Exact commands. test/next-actions.test.mjs re-derives every suggestion
 *    from the CLI's own `--help`, so a renamed flag fails the build.
 *  - At most three. A next step, not a capability catalogue.
 *  - Human output only. `deploy --json` emits the raw platform response and
 *    `init --json` the project object; neither gains a key nobody asked for.
 *  - No network and no new state: every input is one the caller already has.
 */

export interface NextAction {
  /** The exact command to run, copy-pastable as printed. */
  command: string;
  /** Why it is worth running, in one clause. */
  why: string;
}

export type NextActionContext =
  | { stage: 'init'; scaffolded: boolean }
  | { stage: 'login'; linkedProject: boolean }
  | {
      stage: 'deploy';
      /** The current directory links to the project this deploy targeted, so a
       *  bare `somewhere browser` resolves it. */
      projectLinked: boolean;
      liveUrl: string | null;
      /** Anonymous `--temporary` deploy. Always addressed by URL: with
       *  `--temporary` beside a real login the throwaway project is
       *  deliberately kept OUT of `.somewhere.json` (commands/deploy.ts), so a
       *  bare `somewhere browser` would open the developer's own app instead. */
      temporary: boolean;
    };

/** Quote an argument that is not safe bare in a shell. Live URLs are plain
 *  today; a suggestion is pasted verbatim, so it may not depend on that. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

const SEE_IT_LINKED: NextAction = {
  // VERIFY mode: a linked project saves the screenshot into the project files
  // and prints a link that opens it.
  command: 'somewhere browser --screenshot',
  why: 'see the live page — console errors, failed requests, and a screenshot link',
};

const CHECK_IT_LINKED: NextAction = {
  command: 'somewhere verify',
  why: 'run it at desktop and phone size; exits non-zero if the page is unhealthy',
};

/** EYES mode on a public URL, which REQUIRES `--store` — commands/browser.ts
 *  refuses `--screenshot` without it. Temporary credentials carry the `browser`
 *  scope (worker TEMP_ACCOUNT_KEY_SCOPES), so this works on that path too. */
function seeItByUrl(liveUrl: string): NextAction {
  return {
    command: `somewhere browser ${shellQuote(liveUrl)} --screenshot --store`,
    why: 'see the live page — console errors, failed requests, and a screenshot link',
  };
}

export function nextActions(ctx: NextActionContext): NextAction[] {
  switch (ctx.stage) {
    case 'init':
      return [
        {
          command: 'somewhere deploy',
          why: ctx.scaffolded
            ? 'publish the starter and get its live URL — the deploy is the backend'
            : 'publish this source and get its live URL — the deploy is the backend',
        },
        SEE_IT_LINKED,
        {
          // Last, and explicitly "after that": frontend hot reload proxies to
          // the deployed backend and refuses on a project with no release.
          command: 'somewhere dev',
          why: 'after that, frontend hot reload against the deployed backend',
        },
      ];

    case 'login':
      return [
        ctx.linkedProject
          ? { command: 'somewhere deploy', why: 'publish this directory and get its live URL' }
          : {
              command: 'somewhere init',
              why: 'create or link a project here, with a full-stack starter',
            },
      ];

    case 'deploy': {
      if (ctx.temporary) return ctx.liveUrl ? [seeItByUrl(ctx.liveUrl)] : [];
      if (ctx.projectLinked) return [SEE_IT_LINKED, CHECK_IT_LINKED];
      if (ctx.liveUrl) return [seeItByUrl(ctx.liveUrl)];
      return [];
    }
  }
}

export interface NextActionStyles {
  /** Applied to the command. Defaults to identity so tests read plain text. */
  command?: (value: string) => string;
  /** Applied to the trailing explanation. */
  why?: (value: string) => string;
}

/** Aligned lines ready for `console.log`. `[]` for no actions, so a caller can
 *  print unconditionally without emitting a bare label. */
export function formatNextActions(
  actions: NextAction[],
  styles: NextActionStyles = {},
): string[] {
  if (actions.length === 0) return [];
  const style = { command: (v: string) => v, why: (v: string) => v, ...styles };
  const width = Math.max(...actions.map((a) => a.command.length));
  return actions.map(
    (a) => `  ${style.command(a.command.padEnd(width))}  ${style.why(a.why)}`,
  );
}
