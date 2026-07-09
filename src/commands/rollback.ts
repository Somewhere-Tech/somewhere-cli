import { Command } from 'commander';
import ora from '../lib/spinner.js';
import prompts from 'prompts';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, printJson, printJsonError, success, teal, warn } from '../lib/output.js';

interface RollbackResult {
  restored_at: string;
  version: number;
  files_restored: number;
  message?: string | null;
}

export function registerRollback(program: Command) {
  program
    .command('rollback [project]')
    .description(
      'Revert production to the previous deployed version. Use this when a ' +
        'promote shipped a bad build — it restores the version that was live ' +
        'before, including its functions. (Requires at least two promotes.)',
    )
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--json', 'Print the raw rollback response as JSON')
    .action(async (projectArg: string | undefined, opts) => {
      const client = new ApiClient(getToken());

      let projectId = projectArg;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          if (opts.json) {
            printJsonError('NO_PROJECT', 'No project specified and no .somewhere.json found.');
            process.exit(1);
          }
          error('No project specified and no .somewhere.json found.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      if (!opts.yes) {
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Roll ${teal(projectId)} production back to the previous version?`,
          initial: true,
          stdout: opts.json ? process.stderr : undefined,
        });
        if (!ok) {
          // Non-zero so a script/agent can't mistake an abort (incl. a non-TTY
          // prompt that auto-declines) for a completed rollback.
          if (opts.json) {
            printJsonError('ABORTED', 'Aborted.');
            process.exit(1);
          }
          warn('Aborted.');
          process.exit(1);
        }
      }

      const spinner = opts.json ? null : ora('Rolling back...').start();
      try {
        const r = await client.call<RollbackResult>('POST', '/promote/rollback', {
          project_id: projectId,
        });
        spinner?.stop();
        if (opts.json) {
          printJson(r);
          return;
        }
        success(`Rolled back to v${r.version} (${r.files_restored} file${r.files_restored === 1 ? '' : 's'} restored)`);
        if (r.message) info(dim(`Version notes: ${r.message}`));
      } catch (err) {
        spinner?.fail('Rollback failed');
        const message = rollbackErrorMessage(err);
        if (opts.json) {
          if (err instanceof CliApiError) {
            printJsonError(err.code, message);
          } else {
            printJsonError('ERROR', message);
          }
          process.exit(1);
        }
        if (err instanceof CliApiError) {
          error(`${message} ${dim(`[${err.code}${err.statusCode ? `, HTTP ${err.statusCode}` : ''}]`)}`);
        } else {
          error(message);
        }
        process.exit(1);
      }
    });
}

function rollbackErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof CliApiError && /no restorable snapshot/i.test(message)) {
    return 'Rollback is unavailable because the platform could not find a restorable previous live release. No changes were made. Redeploy the source you want live, or try another recorded release.';
  }
  return message;
}
