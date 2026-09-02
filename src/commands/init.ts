import { Command } from 'commander';
import prompts from 'prompts';
import ora from '../lib/spinner.js';
import { ApiClient } from '../lib/client.js';
import {
  getToken,
  hasGlobalMcpConfig,
  loadProjectConfig,
  saveGlobalMcpConfig,
  saveMcpConfig,
  saveProjectConfig,
} from '../lib/config.js';
import { canWriteInitScaffold, writeInitScaffold } from '../lib/init-scaffold.js';
import { createHappyPathTemplate } from '../lib/init-template.js';
import { dim, error, info, printJson, success, teal, warn } from '../lib/output.js';

interface InitOptions {
  name?: string;
  link?: boolean;
  project?: string;
  json?: boolean;
}

interface LinkProject {
  id: string;
  name: string;
  subdomain: string;
  slug?: string;
}

export function registerInit(program: Command) {
  program
    .command('init')
    .description('Initialize a somewhere.tech project in the current directory')
    .option('--name <name>', 'Project name (skip prompt)')
    .option('--link', 'Link to an existing project instead of creating one')
    .option('--project <ref>', 'Existing project ID, name, slug, or subdomain (requires --link)')
    .option('--json', 'Print the created or linked project as JSON')
    .action(async (opts: InitOptions) => {
      if (opts.project && !opts.link) {
        error('--project requires --link.');
        process.exit(1);
      }
      if (opts.json && opts.link && !opts.project) {
        error('--project <ref> is required with --link --json.');
        process.exit(1);
      }
      if (opts.json && !opts.link && !opts.name) {
        error('--name <name> is required with --json.');
        process.exit(1);
      }

      const token = getToken();
      const client = new ApiClient(token);
      const dir = process.cwd();
      const shouldScaffold = canWriteInitScaffold(dir);

      const existing = loadProjectConfig(dir);
      if (existing && !opts.project) {
        if (opts.json) {
          error(`This directory is already linked to ${existing.name}.`);
          process.exit(1);
        }
        warn(`This directory is already linked to ${teal(existing.name)}`);
        const { overwrite } = await prompts({
          type: 'confirm',
          name: 'overwrite',
          message: 'Overwrite?',
          initial: false,
        });
        if (!overwrite) return;
      }

      if (opts.link) {
        try {
          await linkExisting(client, dir, opts.project, Boolean(opts.json));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        return;
      }

      let name = opts.name;
      if (!name) {
        const res = await prompts({
          type: 'text',
          name: 'name',
          message: 'Project name',
          initial: dir.split('/').pop() ?? 'my-app',
        });
        name = res.name;
        if (!name) return;
      }

      // If --name was provided, derive subdomain automatically (no prompt)
      let subdomain: string;
      if (opts.name) {
        subdomain = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      } else {
        const subRes = await prompts({
          type: 'text',
          name: 'subdomain',
          message: 'Subdomain',
          initial: name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        });
        subdomain = (subRes.subdomain as string)
          .trim();
        if (!subdomain) return;
      }

      const spinner = opts.json ? null : ora('Creating project...').start();
      try {
        const project = await client.call<{
          id: string;
          name: string;
          subdomain: string;
          slug: string;
        }>('POST', '/projects', { name, subdomain });

        spinner?.stop();
        if (opts.json) {
          saveProjectConfig(dir, {
            project_id: project.id,
            name: project.name,
            subdomain: project.subdomain ?? subdomain,
          });
          saveMcpConfig(dir);
          if (!hasGlobalMcpConfig()) saveGlobalMcpConfig();
          if (shouldScaffold) writeInitScaffold(dir, createHappyPathTemplate());
          printJson(project);
          return;
        }
        success(`Project created: ${teal(project.name)} (preview)`);

        saveProjectConfig(dir, {
          project_id: project.id,
          name: project.name,
          subdomain: project.subdomain ?? subdomain,
        });
        success('.somewhere.json written');

        saveMcpConfig(dir);

        if (shouldScaffold) {
          const scaffold = writeInitScaffold(dir, createHappyPathTemplate());
          success(`Happy-path starter written (${scaffold.created.length} files)`);
        } else {
          info('Existing source preserved; starter files were not added.');
        }

        if (!hasGlobalMcpConfig()) {
          saveGlobalMcpConfig();
          success('~/.claude.json updated — Claude Code MCP connected');
        }

        console.log('');
        info(
          shouldScaffold
            ? 'Next: npm install → npm run typecheck → somewhere deploy-check → somewhere deploy'
            // Whichever coding agent the developer uses drives this CLI, so the
            // closing line names the PLATFORM's next commands and no vendor's
            // (pfb_aaff8e9d14fb).
            : 'Next: somewhere dev to run it here, somewhere deploy to publish it. Any coding agent can drive this CLI.',
        );
      } catch (err) {
        spinner?.fail('Failed to create project');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

export async function linkExisting(
  client: ApiClient,
  dir: string,
  projectRef?: string,
  json = false,
) {
  const spinner = json ? null : ora('Fetching projects...').start();
  const result = await client.call<{
    projects: LinkProject[];
  }>('GET', '/projects');
  spinner?.stop();

  if (!result.projects.length) {
    error('No projects found. Create one first: somewhere project create <name>');
    process.exit(1);
  }

  let projectId: string | undefined;
  if (projectRef) {
    const normalized = projectRef.toLowerCase();
    const matches = result.projects.filter((project) =>
      project.id === projectRef ||
      project.name.toLowerCase() === normalized ||
      project.slug?.toLowerCase() === normalized ||
      project.subdomain?.toLowerCase() === normalized
    );
    if (matches.length === 0) throw new Error(`Project not found: ${projectRef}`);
    if (matches.length > 1) {
      throw new Error(`Multiple projects match "${projectRef}". Pass the project ID instead.`);
    }
    projectId = matches[0].id;
  } else {
    const selected = await prompts({
      type: 'select',
      name: 'projectId',
      message: 'Select a project to link',
      choices: result.projects.map((p) => ({
        title: `${p.name} (${p.subdomain ?? 'no subdomain'})`,
        value: p.id,
      })),
    });
    projectId = selected.projectId;
  }

  if (!projectId) return;

  const project = result.projects.find((p) => p.id === projectId)!;
  saveProjectConfig(dir, {
    project_id: project.id,
    name: project.name,
    subdomain: project.subdomain,
  });
  if (!json) success(`.somewhere.json linked to ${teal(project.name)}`);

  saveMcpConfig(dir);

  if (!hasGlobalMcpConfig()) {
    saveGlobalMcpConfig();
    if (!json) success('~/.claude.json updated — Claude Code MCP connected');
  }

  if (json) {
    printJson(project);
    return;
  }

  console.log('');
  info('Next: somewhere dev to run it here, somewhere deploy to publish it. Any coding agent can drive this CLI.');
}
