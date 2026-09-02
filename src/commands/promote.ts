import { Command } from 'commander';
import ora from '../lib/spinner.js';
import prompts from 'prompts';
import { ApiClient, CliApiError } from '../lib/client.js';
import {
  getToken,
  loadProjectConfigEntry,
  projectConfigMatchesRef,
  saveProjectDeployState,
  type ProjectConfigEntry,
} from '../lib/config.js';
import { dim, error, info, printJson, printJsonError, success, teal, warn } from '../lib/output.js';
import { getProjectServingUrl } from '../lib/project-urls.js';
import { callPlatformTool } from '../lib/platform-tools.js';
import { isRecord, unwrapPlatformData } from '../lib/platform-command.js';
import {
  describeUnreadablePromote,
  isUnreadablePromoteResponse,
  promoteVerdictFromPointer,
  refusalContradictsProduction,
  type ActivePointer,
} from '../lib/promote-outcome.js';
import { formatErrorReference } from '../lib/client.js';

/**
 * Read what production is serving right now.
 *
 * Tri-state on purpose: a read that FAILED must not look like a project with
 * nothing live, or the caller would treat an absence of evidence as evidence
 * (tsk_33023348).
 */
async function readActivePointer(projectId: string): Promise<ActivePointer> {
  try {
    const status = unwrapPlatformData(
      await callPlatformTool('deploy_status', { project_id: projectId }, { allTools: true }),
    );
    if (!isRecord(status)) return { known: false };
    return {
      known: true,
      releaseId: typeof status.active_release_id === 'string' ? status.active_release_id : null,
      version: typeof status.prod_version === 'number' ? status.prod_version : null,
    };
  } catch {
    return { known: false };
  }
}

interface PromoteResult {
  version: number;
  files_promoted: number;
  has_functions: boolean;
  promoted_draft_id?: string;
  preview_session_id?: string;
  preview_id?: string;
  active_release_id?: string;
  release_id?: string;
}

export function registerPromote(program: Command) {
  program
    .command('promote <preview_session_id> <preview_id>')
    .description(
      'Promote one exact preview to production. Pass the preview_session_id and ' +
        'preview_id returned by the preview; promotion is refused if ' +
        'production or the preview changed.',
    )
    .option('-p, --project <id>', 'Project ID (defaults to the linked project)')
    .option('-m, --message <msg>', 'Release notes for this version')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Print the raw promote response as JSON')
    .action(async (draftId: string, candidateReleaseId: string, opts) => {
      const client = new ApiClient(getToken());

      let projectId = opts.project as string | undefined;
      const linkedProjectEntry = loadProjectConfigEntry();
      let deployStateEntry: ProjectConfigEntry | null = null;
      if (!projectId) {
        if (!linkedProjectEntry) {
          if (opts.json) {
            printJsonError('NO_PROJECT', 'No project linked and no --project given. Run `somewhere init` or pass --project <id>.');
            process.exit(1);
          }
          error('No project linked and no --project given. Run `somewhere init` or pass --project <id>.');
          process.exit(1);
        }
        projectId = linkedProjectEntry.config.project_id;
        deployStateEntry = linkedProjectEntry;
      } else if (linkedProjectEntry && projectConfigMatchesRef(linkedProjectEntry.config, projectId)) {
        deployStateEntry = linkedProjectEntry;
      }

      if (!opts.yes) {
        // Fail fast in a non-interactive shell instead of blocking forever on a
        // prompt no one can answer (A-F07): an inherited pipe never delivers a
        // keystroke, so `prompts` hangs. Match deploy's --force guard — exit
        // with actionable -y/--yes guidance rather than a mute wedge.
        if (!process.stdin.isTTY) {
          const message =
            'Refusing to promote without confirmation in a non-interactive shell. Pass -y/--yes to promote intentionally (e.g. `somewhere promote <preview_session_id> <preview_id> --yes`).';
          if (opts.json) {
            printJsonError('CONFIRMATION_REQUIRED', message);
          } else {
            error(message);
          }
          process.exit(1);
        }
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Promote preview ${teal(candidateReleaseId)} from session ${teal(draftId)} of ${teal(projectId)} → production?`,
          initial: true,
          stdout: opts.json ? process.stderr : undefined,
        });
        if (!ok) {
          // Non-zero: an abort (or auto-declined non-TTY prompt) is not a promote.
          if (opts.json) {
            printJsonError('ABORTED', 'Aborted.');
            process.exit(1);
          }
          warn('Aborted.');
          process.exit(1);
        }
      }

      // Read the production pointer BEFORE sending. This is the only baseline
      // that can later answer "did the promote land?" when the response itself
      // is unreadable — the candidate id can never answer it, because promote
      // rebuilds the candidate through the ordinary release path and produces a
      // third id distinct from both (tsk_33023348).
      const pointerBefore = await readActivePointer(projectId);

      const spinner = opts.json ? null : ora('Promoting...').start();
      try {
        const r = await client.call<PromoteResult>('POST', '/promote', {
          project_id: projectId,
          message: opts.message,
          preview_session_id: draftId,
          preview_id: candidateReleaseId,
        });
        spinner?.stop();
        if (deployStateEntry) {
          saveProjectDeployState(
            deployStateEntry.dir,
            deployStateEntry.config.project_id,
            r.version,
            r.active_release_id ?? r.release_id,
          );
        }
        if (opts.json) {
          printJson(r);
          return;
        }
        success(`Promoted v${r.version} (${r.files_promoted} file${r.files_promoted === 1 ? '' : 's'}${r.has_functions ? ' + functions' : ''})`);
        // Name the preview session this version was promoted from, when known.
        const fromDraft = draftId ?? r.promoted_draft_id;
        if (fromDraft) info(dim(`Promoted from preview session ${teal(fromDraft)}`));
        // The promote response carries no URL — resolve the platform's canonical
        // fallback URL (best-effort; never fail a successful promote on it).
        try {
          const servingUrl = await getProjectServingUrl(client, projectId);
          if (servingUrl) info(`Production at ${teal(servingUrl)}`);
        } catch {
          // ignore — the promote already succeeded
        }
        if (opts.message) info(dim(`Notes: ${opts.message}`));
      } catch (err) {
        const reference = err instanceof CliApiError ? formatErrorReference(err.meta) : null;

        // CASE 1 — the platform never gave us a readable verdict. The flip may
        // have landed before the connection died, so the CLI has no business
        // calling this a failure until it has looked at production.
        if (isUnreadablePromoteResponse(err)) {
          if (spinner) spinner.text = 'Promote response was unreadable — checking production...';
          const pointerAfter = await readActivePointer(projectId);
          const verdict = promoteVerdictFromPointer({ before: pointerBefore, after: pointerAfter });
          const described = describeUnreadablePromote(verdict);
          if (
            verdict.kind === 'applied'
            && deployStateEntry
            && pointerAfter.known
            && pointerAfter.version !== null
          ) {
            // Production moved; keep the local record honest even though the
            // response that would normally carry the version never arrived.
            saveProjectDeployState(
              deployStateEntry.dir,
              deployStateEntry.config.project_id,
              pointerAfter.version,
              verdict.activeReleaseId,
            );
          }
          if (opts.json) {
            if (described.succeeded) {
              printJson({
                status: 'success',
                verified_by: 'production_pointer',
                active_release_id: verdict.kind === 'applied' ? verdict.activeReleaseId : undefined,
                message: `${described.headline} ${described.detail}`,
                request_reference: reference ?? undefined,
              });
              return;
            }
            printJsonError(
              verdict.kind === 'unknown' ? 'PROMOTE_STATUS_UNKNOWN' : 'PROMOTE_NOT_APPLIED',
              `${described.headline} ${described.detail}`,
              );
            process.exit(1);
          }
          if (described.succeeded) {
            spinner?.stop();
            success(described.headline);
            info(described.detail);
            if (reference) info(dim(`Reference: ${reference}`));
            try {
              const servingUrl = await getProjectServingUrl(client, projectId);
              if (servingUrl) info(`Production at ${teal(servingUrl)}`);
            } catch {
              // ignore — production is already confirmed by the pointer
            }
            return;
          }
          spinner?.fail(described.headline);
          error(described.detail);
          if (reference) info(dim(`Reference: ${reference}`));
          process.exit(1);
        }

        // CASE 2 — the platform read the request and refused it. Report the
        // refusal as written, with one exception: a refusal may assert that
        // production was not changed, and it cannot know that a previous
        // attempt did not already change it. Check the pointer before letting
        // that claim stand.
        spinner?.fail('Promote failed');
        const message = err instanceof Error ? err.message : String(err);
        const assertsUnchanged = /production was not (changed|touched)/i.test(message);
        const pointerAfter = assertsUnchanged ? await readActivePointer(projectId) : { known: false } as ActivePointer;
        const contradicted = refusalContradictsProduction({
          message,
          expectedUnchanged: pointerBefore.known ? pointerBefore.releaseId : null,
          after: pointerAfter,
        });
        if (opts.json) {
          if (err instanceof CliApiError) {
            printJsonError(err.code, message);
          } else {
            printJsonError('ERROR', message);
          }
          process.exit(1);
        }
        error(message);
        if (contradicted) {
          warn(
            'Production HAS changed since this promote was first attempted — an earlier attempt landed. ' +
              'Check your production URL before promoting again.',
          );
        } else if (assertsUnchanged && !pointerAfter.known) {
          info(
            dim(
              'Production could not be read back to confirm that, so open your production URL to see which version is live.',
            ),
          );
        }
        if (reference) info(dim(`Reference: ${reference}`));
        process.exit(1);
      }
    });
}
