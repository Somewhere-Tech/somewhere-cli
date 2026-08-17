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
import { fallbackProjectServingUrl, getProjectServingUrl } from '../lib/project-urls.js';

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
        const servingUrl = await getProjectServingUrl(client, id).catch(() =>
          fallbackProjectServingUrl(p),
        );
        console.log(`\n  ${teal(String(p.name))}`);
        info(`Status:    ${statusDot(String(p.status ?? ''))}`);
        if (servingUrl) info(`URL:       ${servingUrl}`);
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
      let project: ProjectDeleteTarget;
      try {
        project = await resolveDeleteTarget(client, nameOrId);
      } catch (err) {
        renderDeleteError(err, opts.json);
        process.exit(1);
      }

      const projectName = project.name?.trim() || nameOrId;
      const { confirm } = await prompts({
        type: 'text',
        name: 'confirm',
        message: `This will permanently delete "${projectName}" and all its data.\n  Type the project name to confirm`,
        stdout: promptStdout,
      });

      if (confirm !== projectName) {
        if (opts.json) {
          printJson({ error: 'ABORTED', message: 'Name did not match. Aborted.' });
          process.exit(1);
        }
        error('Name did not match. Aborted.');
        process.exit(1);
      }

      const spinner = opts.json ? null : ora('Requesting deletion...').start();
      try {
        const code = await requestDeleteConfirmationCode(client, project.id);
        if (spinner) spinner.text = 'Deleting...';
        const deleted = await client.call(
          'DELETE',
          `/projects/${encodeURIComponent(project.id)}`,
          { code },
        );
        spinner?.stop();
        if (opts.json) {
          printJson(deleted);
          return;
        }
        success('Deleted.');
      } catch (err) {
        spinner?.stop();
        renderDeleteError(err, opts.json);
        process.exit(1);
      }
    });

  registerAllowedOrigins(proj);
}

/** `somewhere project allowed-origins …` — read and manage a project's exact
 *  cross-origin allowlist (CORS allowed origins) from the CLI. Setting/clearing
 *  is owner-or-platform-admin only and audited server-side; this is the
 *  first-class remedy for a blocked cross-origin frontend. */
function registerAllowedOrigins(proj: Command) {
  const origins = proj
    .command('allowed-origins')
    .description("Manage a project's cross-origin allowlist (CORS allowed origins)");

  origins
    .command('list [name-or-id]')
    .alias('get')
    .description('Show the exact cross-origin allowlist for a project')
    .option('--json', 'Print the raw response as JSON')
    .action(async (nameOrId: string | undefined, opts: { json?: boolean }) => {
      const client = new ApiClient(getToken());
      const id = nameOrId ?? 'default';
      try {
        const result = await client.call<AllowedOriginsResponse>(
          'GET',
          `/projects/${encodeURIComponent(id)}/allowed-origins`,
        );
        if (opts.json) {
          printJson(result);
          return;
        }
        renderAllowedOrigins(result);
      } catch (err) {
        failAllowedOrigins(err, opts.json);
      }
    });

  origins
    .command('set <name-or-id> <origins...>')
    .description('Replace the allowlist with these exact origins (owner/admin only)')
    .option('--json', 'Print the raw response as JSON')
    .action(async (nameOrId: string, originsArg: string[], opts: { json?: boolean }) => {
      await putAllowedOrigins(nameOrId, originsArg, opts.json);
    });

  origins
    .command('clear <name-or-id>')
    .description('Remove all configured cross-origin origins (owner/admin only)')
    .option('--json', 'Print the raw response as JSON')
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      await putAllowedOrigins(nameOrId, [], opts.json);
    });
}

interface AllowedOriginsResponse {
  project_id?: string;
  allowed_origins?: string[];
  cors_mode?: string;
  cors_grandfathered?: boolean;
  updated?: boolean;
}

async function putAllowedOrigins(
  nameOrId: string,
  allowedOrigins: string[],
  json?: boolean,
): Promise<void> {
  const client = new ApiClient(getToken());
  try {
    const result = await client.call<AllowedOriginsResponse>(
      'PUT',
      `/projects/${encodeURIComponent(nameOrId)}/allowed-origins`,
      { allowed_origins: allowedOrigins },
    );
    if (json) {
      printJson(result);
      return;
    }
    const saved = result.allowed_origins ?? [];
    if (saved.length === 0) {
      success('Allowed origins cleared — only this project\'s own origins are trusted now.');
    } else {
      success(`Allowed origins updated (${saved.length}).`);
      renderAllowedOrigins(result);
    }
  } catch (err) {
    failAllowedOrigins(err, json);
  }
}

function renderAllowedOrigins(result: AllowedOriginsResponse): void {
  const list = result.allowed_origins ?? [];
  console.log(`\n  ${teal('Allowed origins')} ${dim('(credentialed cross-origin CORS allowlist)')}`);
  if (list.length === 0) {
    info(
      "None configured — only this project's own origins (its .somewhere.site URL and any verified custom domains) are trusted.",
    );
  } else {
    for (const o of list) console.log(`  • ${o}`);
  }
  if (result.cors_mode) info(`CORS mode: ${result.cors_mode}`);
}

function failAllowedOrigins(err: unknown, json?: boolean): never {
  if (err instanceof CliApiError) {
    if (json) {
      printJson({
        ok: false,
        error: err.code,
        message: err.message,
        ...(err.data ? { data: err.data } : {}),
        ...(err.hint ? { hint: err.hint } : {}),
      });
    } else {
      error(
        `${err.message} ${dim(`[${err.code}${err.statusCode ? `, HTTP ${err.statusCode}` : ''}]`)}`,
      );
    }
    process.exit(1);
  }
  error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

interface ProjectDeleteTarget {
  id: string;
  name?: string | null;
  subdomain?: string | null;
  slug?: string | null;
  is_owner?: boolean;
}

interface ProjectListForDelete {
  projects: ProjectDeleteTarget[];
}

async function resolveDeleteTarget(client: ApiClient, ref: string): Promise<ProjectDeleteTarget> {
  try {
    return await client.call<ProjectDeleteTarget>(
      'GET',
      `/projects/${encodeURIComponent(ref)}`,
    );
  } catch (err) {
    if (!(err instanceof CliApiError) || err.statusCode !== 404) throw err;
  }

  const listed = await client.call<ProjectListForDelete>(
    'GET',
    '/projects',
    undefined,
    { q: ref, fields: 'compact' },
  );
  const refLower = ref.toLowerCase();
  const exact = listed.projects.filter((p) =>
    p.id === ref ||
    p.name?.toLowerCase() === refLower ||
    p.subdomain?.toLowerCase() === refLower ||
    p.slug?.toLowerCase() === refLower
  );

  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new CliApiError(
      'AMBIGUOUS_PROJECT',
      `Multiple projects match "${ref}". Delete by project ID or subdomain instead.`,
      400,
    );
  }
  throw new CliApiError('PROJECT_NOT_FOUND', 'Project not found.', 404);
}

async function requestDeleteConfirmationCode(client: ApiClient, projectId: string): Promise<string> {
  try {
    await client.call(
      'DELETE',
      `/projects/${encodeURIComponent(projectId)}`,
      {},
    );
  } catch (err) {
    if (err instanceof CliApiError && err.code === 'CONFIRMATION_REQUIRED') {
      const code = err.data?.code;
      if (typeof code === 'string' && code.trim()) return code.trim();
      throw new CliApiError(
        'CONFIRMATION_REQUIRED',
        `${err.message} The server did not include a confirmation code.`,
        err.statusCode,
        err.data,
        err.hint,
      );
    }
    throw err;
  }

  throw new CliApiError(
    'DELETE_CONFIRMATION_MISSING',
    'The server did not require a delete confirmation code, so the CLI refused to continue.',
    500,
  );
}

function renderDeleteError(err: unknown, json?: boolean): void {
  if (err instanceof CliApiError) {
    if (json) {
      printJson({
        ok: false,
        error: err.code,
        message: err.message,
        ...(err.data ? { data: err.data } : {}),
        ...(err.hint ? { hint: err.hint } : {}),
      });
      return;
    }
    error(
      `${err.message} ${dim(`[${err.code}${err.statusCode ? `, HTTP ${err.statusCode}` : ''}]`)}`,
    );
    return;
  }
  error(err instanceof Error ? err.message : String(err));
}

async function listProjects(opts: { json?: boolean } = {}) {
  const client = new ApiClient(getToken());
  const spinner = opts.json ? null : ora('Fetching projects...').start();
  try {
    const result = await client.call<{
      projects: Array<{
        id?: string;
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
        fallbackProjectServingUrl(p) ?? (p.slug ? `${dim('…/' + p.slug)}` : ''),
        p.updated_at ? timeAgo(p.updated_at) : '',
      ]),
    );
  } catch (err) {
    spinner?.fail('Failed');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
