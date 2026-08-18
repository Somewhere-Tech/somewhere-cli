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

interface PromoteResult {
  version: number;
  files_promoted: number;
  has_functions: boolean;
  promoted_draft_id?: string;
  active_release_id?: string;
  release_id?: string;
}

export function registerPromote(program: Command) {
  program
    .command('promote <draft_id> <candidate_release_id>')
    .description(
      'Ship one exact preview candidate to production. Pass the draft_id and ' +
        'candidate_release_id returned by the preview; promotion is refused if ' +
        'the live base or candidate changed.',
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
            'Refusing to promote without confirmation in a non-interactive shell. Pass -y/--yes to promote intentionally (e.g. `somewhere promote <draft_id> <candidate_release_id> --yes`).';
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
          message: `Promote candidate ${teal(candidateReleaseId)} from ${teal(draftId)} of ${teal(projectId)} → prod?`,
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

      const spinner = opts.json ? null : ora('Promoting...').start();
      try {
        const r = await client.call<PromoteResult>('POST', '/promote', {
          project_id: projectId,
          message: opts.message,
          draft_id: draftId,
          candidate_release_id: candidateReleaseId,
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
        // Name the preview/draft this version was promoted from, when known —
        // closes the loop on "what exactly went live" at the highest-trust moment.
        const fromDraft = draftId ?? r.promoted_draft_id;
        if (fromDraft) info(dim(`Promoted from preview ${teal(fromDraft)}`));
        // The promote response carries no URL — resolve the platform's canonical
        // fallback URL (best-effort; never fail a successful promote on it).
        try {
          const servingUrl = await getProjectServingUrl(client, projectId);
          if (servingUrl) info(`Live at ${teal(servingUrl)}`);
        } catch {
          // ignore — the promote already succeeded
        }
        if (opts.message) info(dim(`Notes: ${opts.message}`));
      } catch (err) {
        spinner?.fail('Promote failed');
        if (opts.json) {
          if (err instanceof CliApiError) {
            printJsonError(err.code, err.message);
          } else {
            printJsonError('ERROR', err instanceof Error ? err.message : String(err));
          }
          process.exit(1);
        }
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
