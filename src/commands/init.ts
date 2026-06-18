import { Command } from 'commander';
import prompts from 'prompts';
import ora from 'ora';
import { ApiClient } from '../lib/client.js';
import {
  getToken,
  hasGlobalMcpConfig,
  loadProjectConfig,
  saveGlobalMcpConfig,
  saveMcpConfig,
  saveProjectConfig,
} from '../lib/config.js';
import { dim, error, info, success, teal, warn } from '../lib/output.js';

export function registerInit(program: Command) {
  program
    .command('init')
    .description('Initialize a somewhere.tech project in the current directory')
    .option('--name <name>', 'Project name (skip prompt)')
    .option('--link', 'Link to an existing project instead of creating one')
    .action(async (opts) => {
      const token = getToken();
      const client = new ApiClient(token);
      const dir = process.cwd();

      const existing = loadProjectConfig(dir);
      if (existing) {
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
        await linkExisting(client, dir);
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
          message: 'Deploy to',
          initial: name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          format: (v: string) => `${v}.somewhere.tech`,
        });
        subdomain = (subRes.subdomain as string)
          ?.replace('.somewhere.tech', '')
          .trim();
        if (!subdomain) return;
      }

      const spinner = ora('Creating project...').start();
      try {
        const project = await client.call<{
          id: string;
          name: string;
          subdomain: string;
          slug: string;
        }>('POST', '/projects', { name, subdomain });

        spinner.stop();
        success(`Project created: ${teal(project.name)} (draft)`);

        saveProjectConfig(dir, {
          project_id: project.id,
          name: project.name,
          subdomain: project.subdomain ?? subdomain,
        });
        success('.somewhere.json written');

        saveMcpConfig(dir);

        if (!hasGlobalMcpConfig()) {
          saveGlobalMcpConfig();
          success('~/.claude.json updated — Claude Code MCP connected');
        }

        console.log('');
        info('Project created. Run claude to start building.');
      } catch (err) {
        spinner.fail('Failed to create project');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function linkExisting(
  client: ApiClient,
  dir: string,
) {
  const spinner = ora('Fetching projects...').start();
  const result = await client.call<{
    projects: Array<{ id: string; name: string; subdomain: string }>;
  }>('GET', '/projects');
  spinner.stop();

  if (!result.projects.length) {
    error('No projects found. Create one first: somewhere project create <name>');
    return;
  }

  const { projectId } = await prompts({
    type: 'select',
    name: 'projectId',
    message: 'Select a project to link',
    choices: result.projects.map((p) => ({
      title: `${p.name} (${p.subdomain ?? 'no subdomain'})`,
      value: p.id,
    })),
  });

  if (!projectId) return;

  const project = result.projects.find((p) => p.id === projectId)!;
  saveProjectConfig(dir, {
    project_id: project.id,
    name: project.name,
    subdomain: project.subdomain,
  });
  success(`.somewhere.json linked to ${teal(project.name)}`);

  saveMcpConfig(dir);

  if (!hasGlobalMcpConfig()) {
    saveGlobalMcpConfig();
    success('~/.claude.json updated — Claude Code MCP connected');
  }

  console.log('');
  info('Project created. Run claude to start building.');
}
