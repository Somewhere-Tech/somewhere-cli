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
import { resolveProjectRef } from '../lib/platform-command.js';
import { isExactOrigin } from '../lib/allowed-origins.js';

export function registerProject(program: Command) {
  const proj = program
    .command('project')
    .description('Manage projects');

  proj
    .command('create <name>')
    .description('Create a new project')
    .option('--subdomain <subdomain>', 'Custom subdomain')
    .option('--preview', 'Create without deploying to production')
    .option('--draft', 'Deprecated alias for --preview')
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

  // ── Allowed origins (CORS) ──────────────────────────────────────────────
  //
  // The command an advisor, a doc, or a support reply would naturally print.
  // It did not exist: the only working path was `somewhere call
  // project_allowed_origins_get/set '{…}'` with a raw project id, so guidance
  // and executable surface disagreed and a developer chasing a blocked
  // cross-origin request hit `error: unknown command` first (parity finding
  // #3). The platform's own tool names stay valid — this is the CLI-shaped
  // spelling of the same two calls.
  const origins = proj
    .command('allowed-origins')
    .alias('origins')
    .description(
      'Read or replace the other web addresses allowed to call this project\'s API from a browser. '
        + 'The project always trusts its own addresses — its somewhere.site subdomain and any verified '
        + 'custom domain — so those are never listed here and never need adding.',
    );

  origins
    .command('list')
    .alias('get')
    .description('Show the other web addresses allowed to call this project from a browser')
    .option('--project <ref>', 'Project ID, name, slug, or subdomain (defaults to the linked project)')
    .option('--json', 'Print the raw response as JSON')
    .action(async (opts: { project?: string; json?: boolean }) => {
      const client = new ApiClient(getToken());
      let projectRef: string;
      try {
        projectRef = resolveProjectRef(opts.project);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      try {
        const result = await readAllowedOrigins(client, projectRef);
        if (opts.json) {
          printJson(result);
          return;
        }
        printAllowedOrigins(result);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  origins
    .command('set [origins...]')
    .description(
      'Replace the whole list. Each entry is one exact address — scheme, host and optional port, '
        + 'no path and no wildcards (https://app.example.com, http://localhost:5173). '
        + 'Pass --clear to allow no other addresses at all.',
    )
    .option('--project <ref>', 'Project ID, name, slug, or subdomain (defaults to the linked project)')
    .option('--clear', 'Remove every other address (equivalent to setting an empty list)')
    .option('--json', 'Print the raw response as JSON')
    .action(async (originArgs: string[] | undefined, opts: { project?: string; clear?: boolean; json?: boolean }) => {
      const client = new ApiClient(getToken());
      let projectRef: string;
      try {
        projectRef = resolveProjectRef(opts.project);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      // Accept both `set a b` and `set a,b` — an agent that has read one form
      // should not be tripped by the other.
      const requested = (originArgs ?? []).flatMap((value) => value.split(',')).map((v) => v.trim()).filter(Boolean);
      if (!requested.length && !opts.clear) {
        error('Nothing to set. Pass one or more addresses, or --clear to allow no other addresses.');
        process.exit(1);
      }
      if (requested.length && opts.clear) {
        error('Pass addresses or --clear, not both.');
        process.exit(1);
      }
      const invalid = requested.filter((value) => !isExactOrigin(value));
      if (invalid.length) {
        error(
          `Not an exact web address: ${invalid.join(', ')}. Use scheme + host + optional port only — `
            + 'https://app.example.com, http://localhost:5173 — with no path, query or wildcard.',
        );
        process.exit(1);
      }
      try {
        const result = await writeAllowedOrigins(client, projectRef, requested);
        if (opts.json) {
          printJson(result);
          return;
        }
        success(requested.length
          ? `Allowed ${requested.length === 1 ? 'address' : 'addresses'} updated.`
          : 'Cleared — no other addresses are allowed.');
        printAllowedOrigins(result);
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

/** The allowlist as the platform reports it. */
export interface AllowedOriginsResult {
  project_id?: string;
  allowed_origins?: string[];
  cors_mode?: string;
}

async function readAllowedOrigins(client: ApiClient, ref: string): Promise<AllowedOriginsResult> {
  return client.call<AllowedOriginsResult>(
    'GET',
    `/projects/${encodeURIComponent(ref)}/allowed-origins`,
  );
}

async function writeAllowedOrigins(
  client: ApiClient,
  ref: string,
  allowedOrigins: string[],
): Promise<AllowedOriginsResult> {
  return client.call<AllowedOriginsResult>(
    'PUT',
    `/projects/${encodeURIComponent(ref)}/allowed-origins`,
    { allowed_origins: allowedOrigins },
  );
}

function printAllowedOrigins(result: AllowedOriginsResult): void {
  const list = result.allowed_origins ?? [];
  if (!list.length) {
    info(dim('  No other web addresses are allowed. The project still trusts its own address and any verified custom domain.'));
    return;
  }
  for (const origin of list) info(`  ${teal(origin)}`);
  info(dim('  The project\'s own address and any verified custom domain are always trusted and are not listed here.'));
}
