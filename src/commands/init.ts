import { Command } from 'commander';
import prompts from 'prompts';
import ora from '../lib/spinner.js';
import { ApiClient } from '../lib/client.js';
import {
  getToken,
  loadConfig,
  hasGlobalMcpConfig,
  loadProjectConfig,
  saveGlobalMcpConfig,
  saveMcpConfig,
  saveProjectConfig,
} from '../lib/config.js';
import { installInitDependencies } from '../lib/init-install.js';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  canWriteInitScaffold,
  preflightInitScaffold,
  writeInitScaffold,
  writeMissingGuideFiles,
  type InitScaffoldFile,
} from '../lib/init-scaffold.js';
import { INIT_AGENTS_MD, INIT_CLAUDE_MD } from '../lib/init-agent-guide.js';
import { createGreenTemplate } from '../lib/init-green-template.js';
import { BUNDLED_SKILLS_PACK } from '../lib/skills-pack.generated.js';
import { CLAUDE_SKILLS_DIR, SKILLS_DIR, SKILLS_LOCK, installSkills, readLock, skillNames } from '../lib/skills-pack.js';
import { CLI_VERSION } from '../lib/version.js';
import { createFeatureTemplate, extensionPoints } from '../lib/init-feature-template.js';
import {
  describeSelection,
  initCatalog,
  InitSelectionError,
  resolveInitSelection,
  type InitCatalog,
  type InitSelection,
} from '../lib/init-features.js';
import { formatNextActions, nextActions, type NextActionContext } from '../lib/next-actions.js';
import { bold, dim, error, info, printJson, success, teal, warn } from '../lib/output.js';

interface InitOptions {
  name?: string;
  subdomain?: string;
  link?: boolean;
  project?: string;
  bare?: boolean;
  template?: string;
  features?: string;
  ui?: string;
  catalog?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

const INIT_TEMPLATES = ['auth', 'minimal'] as const;
type InitTemplateName = (typeof INIT_TEMPLATES)[number];

/** The default (auth) starter is the same generator as `--features auth`. */
const DEFAULT_AUTH_SELECTION: InitSelection = { requested: ['auth'], added: [], modules: ['auth'], ui: 'styled' };

interface LinkProject {
  id: string;
  name: string;
  subdomain: string;
  slug?: string;
}

export function registerInit(program: Command) {
  program
    .command('init')
    .description('Write a local starter; when signed in, also create a project and link this directory')
    .option('--name <name>', 'Project name (skip prompt); sign-in and invitation emails show it')
    .option('--subdomain <slug>', 'Subdomain for the new project; default: derived from --name')
    .option('--link', 'Link to an existing project instead of creating one')
    .option('--project <ref>', 'Existing project ID, name, slug, or subdomain (requires --link)')
    .option('--bare', 'Create and link only: no starter source or dependencies (AGENTS.md/CLAUDE.md are still added when absent)')
    .option('--template <name>', 'Starter to write: auth (default, cookie sign-in) or minimal (no sign-in)', 'auth')
    .option('--features <ids>', 'Generate selected modules into an empty directory, comma-separated: auth, magic-link, private-data, agent (see --catalog)')
    .option('--ui <mode>', 'With --features: styled (default; src/ui + design tokens) or headless (hooks and plain markup)')
    .option('--catalog', 'Print the module catalog for --features and exit; no login, project or files')
    .option('--dry-run', 'With --features: validate the selection and print the file plan; nothing is created')
    .option('--json', 'Print the created or linked project as JSON')
    .addHelpText(
      'after',
      '\nRecommended for a new app: run `somewhere init` in an empty directory.\n'
        + 'The starter is a deployable React + TypeScript app with cookie sign-in (the\n'
        + '`auth` module): the SDK\'s packaged handler as a one-line api/auth/[...path].ts,\n'
        + 'the SDK client in src/services/auth.ts, hooks in src/auth/, pages in src/pages/,\n'
        + 'replaceable views in src/ui/ and styles in src/styles/, plus an AGENTS.md workflow\n'
        + '(typecheck, deploy, verify). Sign-in and invitation links (sw.auth.invite) open\n'
        + '/auth/magic, which the starter routes before the sign-in gate.\n'
        + '`--template minimal` writes an app without sign-in.\n'
        + 'New starters and --bare also install six agent skills in .agents/skills, pinned by skills-lock.json.\n'
        + '\nA directory that already has files is linked and left untouched. Use --bare\n'
        + 'only to bring your own layout; existing AGENTS.md/CLAUDE.md are never replaced.\n'
        + '\nPick modules instead of a template (agents: no questions asked):\n'
        + '  somewhere init --catalog --json\n'
        + '  somewhere init --name my-app --features private-data --dry-run --json\n'
        + '  somewhere init --name my-app --features auth,private-data --ui styled\n'
        + '  somewhere init --name "Crew" --subdomain crew-app --features magic-link\n'
        + 'Requirements are added and reported (magic-link, private-data and agent add auth). --features only\n'
        + 'writes into an empty directory and is checked before the project is created.\n',
    )
    .action(async (opts: InitOptions, command: Command) => {
      const dir = process.cwd();
      let plan: FeaturePlan | undefined;
      try {
        if (opts.catalog) {
          printCatalog(opts, command);
          return;
        }
        plan = planFeatures(opts, command, dir);
      } catch (err) {
        if (!(err instanceof InitSelectionError)) throw err;
        error(err.message);
        process.exit(2);
      }
      if (plan && opts.dryRun) {
        const files = plan.files.map((file) => file.path);
        if (opts.json) {
          printJson({ dry_run: true, selection: plan.selection, files });
        } else {
          info(`Dry run: ${describeSelection(plan.selection)}`);
          for (const path of files) console.log(`  ${path}`);
          info('Nothing was created. Drop --dry-run (and add --name) to write the starter; a signed-in run also creates the project.');
        }
        return;
      }

      const template = (opts.template ?? 'auth') as InitTemplateName;
      if (!INIT_TEMPLATES.includes(template)) {
        error(`Unknown --template ${opts.template}. Use one of: ${INIT_TEMPLATES.join(', ')}.`);
        process.exit(2);
      }
      if (opts.project && !opts.link) {
        error('--project requires --link.');
        process.exit(1);
      }
      if (opts.subdomain !== undefined && opts.link) {
        error('--subdomain names a new project; it cannot be combined with --link.');
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
      // No one can answer a prompt in a non-interactive shell (an agent's exec
      // tool, a script, a pipe): fail fast with the flag instead of waiting.
      if (!process.stdin.isTTY) {
        if (!opts.link && !opts.name) {
          failNonInteractive('Pass --name <project-name> to create a project in a non-interactive shell (e.g. `somewhere init --name my-app`).');
        }
        if (opts.link && !opts.project) {
          failNonInteractive('Pass --project <ref> to link a project in a non-interactive shell (e.g. `somewhere init --link --project my-app`).');
        }
      }

      const shouldScaffold = !opts.bare && canWriteInitScaffold(dir);
      const scaffoldFiles = (projectName: string): InitScaffoldFile[] =>
        template === 'minimal' && !plan
          ? createGreenTemplate()
          : createFeatureTemplate(plan?.selection ?? DEFAULT_AUTH_SELECTION, { appName: projectName });

      const existing = loadProjectConfig(dir);
      // Missing credentials never block local source generation. Linking and
      // bare project creation remain account operations; deploy owns anonymous
      // provisioning and its proof-of-work / temporary-session isolation.
      if (!loadConfig()?.token && !opts.link && !opts.bare) {
        if (existing || existsSync(join(dir, '.somewhere.json')) || !shouldScaffold) {
          error('Local starter generation requires an empty, unlinked directory. Existing files were kept. Run somewhere docs start for the anonymous deploy workflow.');
          process.exit(1);
        }
        let localName = opts.name;
        if (!localName) {
          const answer = await prompts({ type: 'text', name: 'name', message: 'App name', initial: basename(dir) || 'my-app' });
          localName = answer.name as string | undefined;
          if (!localName) return;
        }
        try {
          const scaffold = writeInitScaffold(dir, scaffoldFiles(localName));
          const skills = writeInitSkills(dir);
          const next = ['somewhere deploy', 'somewhere docs start'];
          if (opts.json) {
            printJson({ local: true, linked: false, name: localName, files: scaffold.created, dependencies_installed: false, skills,
              ...(plan ? { selection: plan.selection, extension_points: extensionPoints(plan.selection) } : {}), next });
          } else {
            success(`Local starter written (${scaffold.created.length} files); no account or project was created.`);
            reportSkills(skills);
            info('Dependencies are not installed. Run npm install if you want to run it locally.');
            info('Next: somewhere deploy — publish with a temporary workspace, no login needed.');
            info('Quickstart: somewhere docs start');
          }
        } catch (err) {
          error(err instanceof Error ? err.message : String(err), err);
          process.exit(1);
        }
        return;
      }
      const token = getToken();
      const client = new ApiClient(token);
      if (existing && !opts.project) {
        if (opts.json) {
          error(`This directory is already linked to ${existing.name}.`);
          process.exit(1);
        }
        if (!process.stdin.isTTY) {
          failNonInteractive(`This directory is already linked to ${existing.name}. Run init in an empty directory, or relink with \`somewhere init --link --project <ref>\`.`);
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
          error(err instanceof Error ? err.message : String(err), err);
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

      // --subdomain wins; with only --name, derive it (no prompt)
      let subdomain: string;
      if (opts.subdomain !== undefined) {
        subdomain = opts.subdomain.trim().toLowerCase();
      } else if (opts.name) {
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
          if (shouldScaffold) {
            writeInitScaffold(dir, scaffoldFiles(project.name));
            writeInitSkills(dir);
            await installInitDependencies({ cwd: dir, quiet: true });
          } else if (opts.bare) {
            writeBareGuide(dir);
            writeInitSkills(dir);
          }
          printJson(plan
            ? { ...project, selection: plan.selection, extension_points: extensionPoints(plan.selection) }
            : project);
          return;
        }
        success(`Project created: ${teal(project.name)}`);

        saveProjectConfig(dir, {
          project_id: project.id,
          name: project.name,
          subdomain: project.subdomain ?? subdomain,
        });
        success('.somewhere.json written');

        saveMcpConfig(dir);

        if (shouldScaffold) {
          const scaffold = writeInitScaffold(dir, scaffoldFiles(project.name));
          success(`Full-stack starter written (${scaffold.created.length} files)`);
          reportSkills(writeInitSkills(dir));
          if (template !== 'minimal' || plan) {
            const selection = plan?.selection ?? DEFAULT_AUTH_SELECTION;
            info(`Modules: ${describeSelection(selection)}`);
            for (const [area, where] of Object.entries(extensionPoints(selection))) console.log(`  ${area}: ${where}`);
          }
          info('Installing pinned dependencies with `npm install`…');
          await installInitDependencies({ cwd: dir, quiet: false });
          success('Dependencies installed');
        } else if (opts.bare) {
          info('Bare project: no starter source or dependencies were added.');
          const guide = writeBareGuide(dir);
          reportSkills(writeInitSkills(dir));
          if (guide.created.length) success(`Agent workflow guide written (${guide.created.join(', ')})`);
          if (guide.kept.length) info(`Existing ${guide.kept.join(', ')} kept unchanged.`);
        } else {
          info('Existing source preserved; starter files were not added.');
        }

        if (!hasGlobalMcpConfig()) {
          saveGlobalMcpConfig();
          success('~/.claude.json updated — Claude Code MCP connected');
        }

        console.log('');
        printNext({ stage: 'init', scaffolded: shouldScaffold });
      } catch (err) {
        spinner?.fail('Failed to create project');
        error(err instanceof Error ? err.message : String(err), err);
        process.exit(1);
      }
    });
}

interface FeaturePlan {
  selection: InitSelection;
  files: InitScaffoldFile[];
}

/**
 * Validate --features/--ui before any login, request or write. Throws
 * InitSelectionError (exit 2) for unknown ids, conflicting flags, or a
 * directory the starter cannot be written into; returns undefined when the
 * command is not a --features run.
 */
function planFeatures(opts: InitOptions, command: Command, dir: string): FeaturePlan | undefined {
  if (opts.features === undefined) {
    if (opts.ui !== undefined) throw new InitSelectionError('--ui requires --features.');
    if (opts.dryRun) throw new InitSelectionError('--dry-run requires --features.');
    return undefined;
  }
  const conflicts = [
    command.getOptionValueSource('template') === 'cli' ? '--template' : null,
    opts.bare ? '--bare' : null,
    opts.link ? '--link' : null,
    opts.project ? '--project' : null,
  ].filter((flag): flag is string => flag !== null);
  if (conflicts.length) {
    throw new InitSelectionError(
      `--features cannot be combined with ${conflicts.join(', ')}: it writes a new app into an empty directory and never adds files to an existing project.`,
    );
  }
  const selection = resolveInitSelection(opts.features, opts.ui ?? 'styled');
  const files = createFeatureTemplate(selection, { appName: opts.name ?? basename(dir) });
  if (!canWriteInitScaffold(dir)) {
    throw new InitSelectionError(
      'This directory already has files. --features writes only into an empty directory; nothing was created. Run it in a new directory.',
    );
  }
  try {
    preflightInitScaffold(dir, files);
  } catch (err) {
    throw new InitSelectionError(`${err instanceof Error ? err.message : String(err)}. Nothing was created.`);
  }
  return { selection, files };
}

function printCatalog(opts: InitOptions, command: Command): void {
  const extra = [
    opts.features !== undefined ? '--features' : null,
    opts.ui !== undefined ? '--ui' : null,
    opts.dryRun ? '--dry-run' : null,
    opts.name ? '--name' : null,
    opts.subdomain !== undefined ? '--subdomain' : null,
    opts.link ? '--link' : null,
    opts.project ? '--project' : null,
    opts.bare ? '--bare' : null,
    command.getOptionValueSource('template') === 'cli' ? '--template' : null,
  ].filter((flag): flag is string => flag !== null);
  if (extra.length) throw new InitSelectionError(`--catalog only prints the catalog; drop ${extra.join(', ')}.`);
  const catalog: InitCatalog = initCatalog((selection) => createFeatureTemplate(selection, { appName: 'app' }));
  if (opts.json) {
    printJson(catalog);
    return;
  }
  info(bold('Modules for somewhere init --features'));
  for (const entry of catalog.modules) {
    console.log(`  ${teal(entry.id)}${entry.requires.length ? dim(` (requires ${entry.requires.join(', ')})`) : ''}`);
    console.log(`    ${entry.summary}`);
  }
  info(bold('UI (--ui)'));
  for (const mode of catalog.ui) {
    console.log(`  ${teal(mode.id)}${mode.id === catalog.defaults.ui ? dim(' (default)') : ''}`);
    console.log(`    ${mode.summary}`);
  }
  info(bold('Not generated'));
  for (const entry of catalog.not_offered) console.log(`  ${entry.id}: ${dim(entry.reason)}`);
  console.log('');
  console.log(`  ${catalog.command}`);
}

/** Exit 2 (usage) before any prompt that a non-interactive shell cannot answer. */
function failNonInteractive(message: string): never {
  error(message);
  process.exit(2);
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
  printNext({ stage: 'init', scaffolded: false });
}

/** Existing installations and same-name project skills remain unchanged during init. */
export function writeInitSkills(dir: string): { version: string } | { kept: string } {
  if (readLock(dir)) return { kept: `${SKILLS_LOCK} already present` };
  const taken = skillNames(BUNDLED_SKILLS_PACK).filter((name) =>
    existsSync(join(dir, SKILLS_DIR, name)) || existsSync(join(dir, CLAUDE_SKILLS_DIR, name)));
  if (taken.length) return { kept: `Project skills ${taken.join(', ')} already exist` };
  return installSkills(dir, BUNDLED_SKILLS_PACK, { cli: CLI_VERSION, source: 'bundled' });
}

function reportSkills(result: ReturnType<typeof writeInitSkills>): void {
  if ('version' in result) success(`Agent skills ${teal(result.version)} written to ${SKILLS_DIR}`);
  else info(`Agent skills kept unchanged: ${result.kept}. Run somewhere skills status to inspect them.`);
}

function writeBareGuide(dir: string) {
  return writeMissingGuideFiles(dir, [
    { path: 'AGENTS.md', content: INIT_AGENTS_MD },
    { path: 'CLAUDE.md', content: INIT_CLAUDE_MD },
  ]);
}

/** One rendering of the contextual next steps (lib/next-actions.ts), so create
 *  and link close the same way. */
function printNext(ctx: NextActionContext): void {
  info(bold('Next'));
  for (const line of formatNextActions(nextActions(ctx), { command: teal, why: dim })) {
    console.log(line);
  }
}
