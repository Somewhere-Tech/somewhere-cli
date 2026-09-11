/**
 * What to run next, decided in ONE place.
 *
 * Agents are the primary users of this CLI, and they only learn a capability
 * exists if a command they already ran names it. The comparison test that
 * produced this module found two concrete gaps:
 *
 *   1. `somewhere init` closed with "Next: somewhere dev", but `somewhere dev`
 *      proxies API calls to the DEPLOYED origin and refuses on a project that
 *      has never been deployed (lib/project-urls.ts, getDeployedProjectServingUrl).
 *      The first instruction a fresh project received could not succeed
 *      (pfb_9a035f5ac8e9).
 *   2. Nothing in the init or deploy path said the CLI can open the app in a
 *      browser, screenshot it, and report its console/network errors — so
 *      nobody found `somewhere browser` or `somewhere verify` without being
 *      told.
 *
 * Rules this module holds itself to:
 *   - EXACT commands only. Every `command` string below is a registered command
 *     with real flags; test/next-actions.test.mjs re-derives each one from the
 *     CLI's own `--help` output, so a renamed flag fails the build rather than
 *     shipping a suggestion that errors.
 *   - At most three. This is a next step, not a capability catalogue.
 *   - Human output only. It never touches `--json` stdout: `deploy --json`
 *     emits the raw platform response and nothing else (pinned by
 *     test/json-output.test.mjs), and `init --json` passes the project object
 *     straight through. Adding keys there would break parsers for a hint the
 *     caller did not ask for.
 *   - No network, no extra work. Everything here is decided from values the
 *     caller already has.
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
      /** A project this directory is linked to — the `browser`/`verify`
       *  default target. Absent on an anonymous `--temporary` deploy. */
      projectLinked: boolean;
      liveUrl: string | null;
    };

const SEE_IT_LINKED: NextAction = {
  // VERIFY mode: with a linked project the screenshot is saved into the
  // project files and the report prints a link that opens it.
  command: 'somewhere browser --screenshot',
  why: 'see the live page — console errors, failed requests, and a screenshot link',
};

const CHECK_IT_LINKED: NextAction = {
  command: 'somewhere verify',
  why: 'run it at desktop and phone size; exits non-zero if the page is unhealthy',
};

/** EYES mode on a public URL. `--screenshot` there REQUIRES `--store`, which is
 *  what returns the short-lived link (commands/browser.ts refuses without it). */
function seeItByUrl(liveUrl: string): NextAction {
  return {
    command: `somewhere browser ${liveUrl} --screenshot --store`,
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
          // Deliberately third and explicitly "after that": frontend hot reload
          // proxies to the deployed backend, so it cannot run before a deploy.
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

/**
 * Render as aligned lines, ready for `console.log`. Returns `[]` for no
 * actions so a caller can print unconditionally without emitting a bare label.
 */
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
