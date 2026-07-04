import { Command } from 'commander';
import ora from '../lib/spinner.js';
import prompts from 'prompts';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, printJson, success, teal, warn } from '../lib/output.js';

interface PromoteResult {
  version: number;
  files_promoted: number;
  has_functions: boolean;
  promoted_draft_id?: string;
}

export function registerPromote(program: Command) {
  program
    .command('promote [draft_id]')
    .description(
      'Ship the current dev/preview build to production. Pass the draft_id you ' +
        'got from `somewhere dev` / a preview to publish EXACTLY that build — ' +
        'the promote is refused if a newer draft replaced it since you previewed.',
    )
    .option('-p, --project <id>', 'Project ID (defaults to the linked project)')
    .option('-m, --message <msg>', 'Release notes for this version')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Print the raw promote response as JSON')
    .action(async (draftId: string | undefined, opts) => {
      const client = new ApiClient(getToken());

      let projectId = opts.project as string | undefined;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project linked and no --project given. Run `somewhere init` or pass --project <id>.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      if (!opts.yes) {
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: draftId
            ? `Promote draft ${teal(draftId)} of ${teal(projectId)} → prod?`
            : `Promote ${teal(projectId)} dev → prod?`,
          initial: true,
          stdout: opts.json ? process.stderr : undefined,
        });
        if (!ok) {
          // Non-zero: an abort (or auto-declined non-TTY prompt) is not a promote.
          if (opts.json) {
            printJson({ error: 'ABORTED', message: 'Aborted.' });
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
        });
        spinner?.stop();
        if (opts.json) {
          printJson(r);
          return;
        }
        success(`Promoted v${r.version} (${r.files_promoted} file${r.files_promoted === 1 ? '' : 's'}${r.has_functions ? ' + functions' : ''})`);
        // Name the preview/draft this version was promoted from, when known —
        // closes the loop on "what exactly went live" at the highest-trust moment.
        const fromDraft = draftId ?? r.promoted_draft_id;
        if (fromDraft) info(dim(`Promoted from preview ${teal(fromDraft)}`));
        // The promote response carries no URL — resolve the live URL from the
        // project's subdomain (best-effort; never fail a successful promote on it).
        try {
          const p = await client.call<{ subdomain?: string }>(
            'GET',
            `/projects/${encodeURIComponent(projectId)}`,
          );
          if (p.subdomain) info(`Live at ${teal(`https://${p.subdomain}.somewhere.tech`)}`);
        } catch {
          // ignore — the promote already succeeded
        }
        if (opts.message) info(dim(`Notes: ${opts.message}`));
      } catch (err) {
        spinner?.fail('Promote failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
