import { Command } from 'commander';
import prompts from 'prompts';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import {
  dim,
  error,
  info,
  printJson,
  statusDot,
  success,
  table,
  teal,
  timeAgo,
} from '../lib/output.js';

export function registerProject(program: Command) {
  const proj = program
    .command('project')
    .description('Manage projects');

  proj
    .command('create <name>')
    .description('Create a new project')
    .option('--subdomain <subdomain>', 'Custom subdomain')
    .option('--draft', 'Create as draft without deploying')
    .option('--json', 'Print the raw project response as JSON')
    .action(async (name: string, opts) => {
      const client = new ApiClient(getToken());
      const spinner = opts.json ? null : ora('Creating project...').start();
      try {
        const p = await client.call<{
          id: string;
          name: string;
          subdomain: string;
          status: string;
          url?: string;
        }>('POST', '/projects', {
          name,
          subdomain: opts.subdomain ?? name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        });
        spinner?.stop();
        if (opts.json) {
          printJson(p);
          return;
        }
        success(`Project created: ${teal(p.name)}`);
        info(`ID: ${dim(p.id)}`);
        if (p.url) info(`URL: ${p.url}`);
        info(`Status: ${statusDot(p.status)}`);
      } catch (err) {
        spinner?.fail('Failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  proj
    .command('list')
    .alias('ls')
    .description('List all projects')
    .option('--json', 'Print the raw projects response as JSON')
    .action(listProjects);

  // Also register top-level `somewhere projects` alias
  program
    .command('projects')
    .description('List all projects')
    .option('--json', 'Print the raw projects response as JSON')
    .action(listProjects);

  proj
    .command('view [name-or-id]')
    .description('View project details')
    .option('--json', 'Print the raw project response as JSON')
    .action(async (nameOrId: string | undefined, opts) => {
      const client = new ApiClient(getToken());
      const id = nameOrId ?? 'default';
      try {
        const p = await client.call<Record<string, unknown>>(
          'GET',
          `/projects/${encodeURIComponent(id)}`,
        );
        if (opts.json) {
          printJson(p);
          return;
        }
        console.log(`\n  ${teal(String(p.name))}`);
        info(`Status:    ${statusDot(String(p.status ?? ''))}`);
        if (p.subdomain) info(`URL:       https://${p.subdomain}.somewhere.tech`);
        if (p.created_at) info(`Created:   ${String(p.created_at)}`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  proj
    .command('delete <name-or-id>')
    .description('Permanently delete a project and all its data')
    .option('--json', 'Print the raw delete response as JSON')
    .action(async (nameOrId: string, opts) => {
      const client = new ApiClient(getToken());
      const promptStdout = opts.json ? process.stderr : undefined;
      const { confirm } = await prompts({
        type: 'text',
        name: 'confirm',
        message: `This will permanently delete "${nameOrId}" and all its data.\n  Type the project name to confirm`,
        stdout: promptStdout,
      });

      if (confirm !== nameOrId) {
        if (opts.json) {
          printJson({ error: 'ABORTED', message: 'Name did not match. Aborted.' });
          process.exit(1);
        }
        error('Name did not match. Aborted.');
        process.exit(1);
      }

      const spinner = opts.json ? null : ora('Requesting deletion...').start();
      try {
        await client.call(
          'POST',
          `/projects/${encodeURIComponent(nameOrId)}/request-delete`,
        );
        if (spinner) {
          spinner.text = 'Confirmation code sent to your email. Enter it below.';
          spinner.stop();
        }

        const { code } = await prompts({
          type: 'text',
          name: 'code',
          message: 'Confirmation code (from email)',
          stdout: promptStdout,
        });

        if (!code) {
          if (opts.json) {
            printJson({ error: 'ABORTED', message: 'No code entered. Aborted.' });
            process.exit(1);
          }
          error('No code entered. Aborted.');
          process.exit(1);
        }

        const delSpinner = opts.json ? null : ora('Deleting...').start();
        const deleted = await client.call(
          'DELETE',
          `/projects/${encodeURIComponent(nameOrId)}`,
          { code },
        );
        delSpinner?.stop();
        if (opts.json) {
          printJson(deleted);
          return;
        }
        success('Deleted.');
      } catch (err) {
        spinner?.stop();
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function listProjects(opts: { json?: boolean } = {}) {
  const client = new ApiClient(getToken());
  const spinner = opts.json ? null : ora('Fetching projects...').start();
  try {
    const result = await client.call<{
      projects: Array<{
        name: string;
        status: string;
        subdomain: string;
        slug: string;
        updated_at?: string;
      }>;
    }>('GET', '/projects');
    spinner?.stop();

    if (opts.json) {
      printJson(result);
      return;
    }

    if (!result.projects.length) {
      info('No projects yet. Create one: somewhere project create <name>');
      return;
    }

    table(
      ['Name', 'Status', 'URL', 'Updated'],
      result.projects.map((p) => [
        p.name,
        statusDot(p.status),
        p.subdomain
          ? `${p.subdomain}.somewhere.tech`
          : p.slug
            ? `${dim('…/' + p.slug)}`
            : '',
        p.updated_at ? timeAgo(p.updated_at) : '',
      ]),
    );
  } catch (err) {
    spinner?.fail('Failed');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
