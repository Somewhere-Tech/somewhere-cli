import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import prompts from 'prompts';
import { ApiClient, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import open from '../lib/open.js';
import { dim, error, info, printJson, success, teal } from '../lib/output.js';

interface GitHubInstallation {
  installation_id: number;
  account_login: string | null;
  account_type: string | null;
}

interface GitHubRepo {
  name: string;
  private: boolean;
  default_branch: string;
}

interface GitHubConnection {
  connected: boolean;
  project_id?: string;
  repo?: string;
  branch?: string;
  root_dir?: string | null;
  via_app?: boolean;
  last_commit_sha?: string | null;
  last_commit_message?: string | null;
  last_status?: 'deploying' | 'deployed' | 'failed' | null;
  last_error?: string | null;
  initial_deploy?: {
    status: 'deploying';
    commit_sha: string;
    commit_message: string;
  };
}

interface ProjectSummary {
  id?: string;
  name: string;
  subdomain: string;
}

interface RepoChoice {
  installation: GitHubInstallation;
  repo: GitHubRepo;
}

const DASHBOARD = 'https://somewhere.tech/dashboard';
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const DEPLOY_POLL_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function projectRef(explicit?: string): string {
  if (explicit) return explicit;
  const config = loadProjectConfig();
  if (config) return config.project_id;
  throw new Error('No project specified and no .somewhere.json found. Pass --project <id-or-slug>.');
}

function inferGitHubRepo(): string | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

async function listInstallations(client: ApiClient): Promise<{
  app_configured: boolean;
  installations: GitHubInstallation[];
}> {
  return client.call('GET', '/github/app/installations');
}

async function listChoices(
  client: ApiClient,
  installations: GitHubInstallation[],
): Promise<RepoChoice[]> {
  const batches = await Promise.all(installations.map(async (installation) => {
    const repos = await client.call<GitHubRepo[]>(
      'GET',
      '/github/app/repos',
      undefined,
      { installation_id: installation.installation_id },
    );
    return repos.map((repo) => ({ installation, repo }));
  }));
  return batches.flat();
}

async function openInstaller(client: ApiClient, quiet: boolean): Promise<void> {
  const start = await client.call<{ install_url: string }>(
    'GET',
    '/github/app/install',
    undefined,
    { format: 'json', return_to: `${DASHBOARD}?github_cli=connected` },
  );
  if (!quiet) info(`Opening GitHub to choose an account and repositories…`);
  try {
    await open(start.install_url);
  } catch {
    if (!quiet) info(`Open this link: ${start.install_url}`);
  }
}

async function waitForChoices(
  client: ApiClient,
  repoName: string | null,
  quiet: boolean,
): Promise<RepoChoice[]> {
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  if (!quiet) info('Waiting for GitHub authorization…');
  while (Date.now() < deadline) {
    const state = await listInstallations(client);
    const choices = await listChoices(client, state.installations);
    if (repoName) {
      if (choices.some((choice) => choice.repo.name.toLowerCase() === repoName.toLowerCase())) return choices;
    } else if (choices.length > 0) {
      return choices;
    }
    await sleep(2000);
  }
  throw new Error('GitHub authorization was not completed within 5 minutes. Run `somewhere git connect` again.');
}

async function chooseRepo(
  client: ApiClient,
  requestedRepo: string | undefined,
  quiet: boolean,
): Promise<RepoChoice> {
  const app = await listInstallations(client);
  if (!app.app_configured) {
    throw new Error('GitHub App connect is not configured on this somewhere.tech environment.');
  }

  const inferredRepo = requestedRepo || inferGitHubRepo();
  let choices = await listChoices(client, app.installations);
  let match = inferredRepo
    ? choices.find((choice) => choice.repo.name.toLowerCase() === inferredRepo.toLowerCase())
    : undefined;

  if (app.installations.length === 0 || (inferredRepo && !match) || choices.length === 0) {
    await openInstaller(client, quiet);
    choices = await waitForChoices(client, inferredRepo, quiet);
    match = inferredRepo
      ? choices.find((choice) => choice.repo.name.toLowerCase() === inferredRepo.toLowerCase())
      : undefined;
  }

  if (match) return match;
  if (requestedRepo) {
    throw new Error(`GitHub did not grant access to ${requestedRepo}. Rerun the command and select that repository.`);
  }
  if (!process.stdin.isTTY) {
    throw new Error('No GitHub repository was specified. Pass owner/repo in a non-interactive shell.');
  }
  const answer = await prompts({
    type: 'select',
    name: 'choice',
    message: 'Repository to deploy',
    choices: choices.map((choice) => ({
      title: `${choice.repo.name}${choice.repo.private ? ' (private)' : ''}`,
      value: choice,
    })),
  });
  if (!answer.choice) throw new Error('GitHub connection cancelled.');
  return answer.choice as RepoChoice;
}

async function waitForDeploy(
  client: ApiClient,
  projectId: string,
  commitSha: string,
): Promise<GitHubConnection> {
  const deadline = Date.now() + LONG_CALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const connection = await client.call<GitHubConnection>(
      'GET',
      '/github/connection',
      undefined,
      { project_id: projectId },
    );
    if (connection.last_commit_sha === commitSha) {
      if (connection.last_status === 'deployed') return connection;
      if (connection.last_status === 'failed') {
        throw new Error(connection.last_error || `Deploy of ${commitSha.slice(0, 7)} failed.`);
      }
    }
    await sleep(DEPLOY_POLL_MS);
  }
  throw new Error(`Deploy of ${commitSha.slice(0, 7)} is still running after 10 minutes. Check the project logs.`);
}

function urls(projectId: string, subdomain: string): { live_url: string; logs_url: string } {
  return {
    live_url: `https://${subdomain}.somewhere.tech`,
    logs_url: `${DASHBOARD}/projects/${encodeURIComponent(projectId)}?tab=logs`,
  };
}

export function registerGit(program: Command) {
  const git = program
    .command('git')
    .description('Connect a GitHub repository for push-to-deploy');

  git
    .command('connect [repo]')
    .description('Connect a repository, deploy HEAD now, and deploy future pushes')
    .option('-p, --project <id-or-slug>', 'Project ID or slug (defaults to .somewhere.json)')
    .option('-b, --branch <branch>', 'Branch to deploy (defaults to the repository default branch)')
    .option('--root <directory>', 'Repository subdirectory to deploy')
    .option('--json', 'Print structured JSON')
    .action(async (repo: string | undefined, opts) => {
      try {
        const client = new ApiClient(getToken());
        const ref = projectRef(opts.project);
        const project = await client.call<ProjectSummary>('GET', `/projects/${encodeURIComponent(ref)}`);
        const resolvedProjectId = project.id || ref;
        const choice = await chooseRepo(client, repo, !!opts.json);
        const branch = opts.branch || choice.repo.default_branch || 'main';
        if (!opts.json) info(`Deploying ${teal(choice.repo.name)}@${branch} to ${teal(project.name)}…`);
        const started = await client.call<GitHubConnection>('POST', '/github/connect', {
          project_id: ref,
          repo: choice.repo.name,
          branch,
          ...(opts.root ? { root_dir: opts.root } : {}),
          installation_id: choice.installation.installation_id,
          deploy_head: true,
        });
        const commitSha = started.initial_deploy?.commit_sha;
        if (!commitSha) throw new Error('GitHub connected, but the repository deploy did not start.');
        const connection = await waitForDeploy(client, started.project_id || resolvedProjectId, commitSha);
        const connectedProjectId = started.project_id || resolvedProjectId;
        const links = urls(connectedProjectId, project.subdomain);
        const result = {
          connected: true,
          project_id: connectedProjectId,
          repo: connection.repo,
          branch: connection.branch,
          commit_sha: commitSha,
          commit_message: connection.last_commit_message,
          status: connection.last_status,
          ...links,
        };
        if (opts.json) {
          printJson(result);
        } else {
          success(`Deployed ${connection.repo}@${commitSha.slice(0, 7)}`);
          info(`Status: ${connection.last_status}`);
          info(`Logs: ${dim(links.logs_url)}`);
          info(`Live: ${teal(links.live_url)}`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  git
    .command('status [project]')
    .description('Show the repository, commit, deploy status, logs, and live URL')
    .option('-p, --project <id-or-slug>', 'Project ID or slug (defaults to the positional project or .somewhere.json)')
    .option('--json', 'Print structured JSON')
    .action(async (project: string | undefined, opts) => {
      try {
        const client = new ApiClient(getToken());
        const ref = projectRef(opts.project || project);
        const [connection, summary] = await Promise.all([
          client.call<GitHubConnection>('GET', '/github/connection', undefined, { project_id: ref }),
          client.call<ProjectSummary>('GET', `/projects/${encodeURIComponent(ref)}`),
        ]);
        const links = urls(summary.id || connection.project_id || ref, summary.subdomain);
        const result = { ...connection, ...links };
        if (opts.json) {
          printJson(result);
        } else if (!connection.connected) {
          info('No GitHub repository is connected. Run `somewhere git connect`.');
        } else {
          console.log(`\n  Repository: ${teal(connection.repo || '')}`);
          info(`Branch: ${connection.branch}`);
          info(`Commit: ${connection.last_commit_sha ? `${connection.last_commit_sha.slice(0, 7)}${connection.last_commit_message ? ` · ${connection.last_commit_message}` : ''}` : 'none yet'}`);
          info(`Status: ${connection.last_status || 'waiting for first deploy'}`);
          if (connection.last_error) info(`Error: ${connection.last_error}`);
          info(`Logs: ${dim(links.logs_url)}`);
          info(`Live: ${teal(links.live_url)}`);
          console.log('');
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  git
    .command('disconnect [project]')
    .description('Stop GitHub push-to-deploy without changing the deployed site')
    .option('-p, --project <id-or-slug>', 'Project ID or slug (defaults to the positional project or .somewhere.json)')
    .option('-y, --yes', 'Disconnect without prompting')
    .option('--json', 'Print structured JSON')
    .action(async (project: string | undefined, opts) => {
      try {
        const client = new ApiClient(getToken());
        const ref = projectRef(opts.project || project);
        if (!opts.yes) {
          if (!process.stdin.isTTY) throw new Error('Pass --yes to disconnect in a non-interactive shell.');
          const answer = await prompts({
            type: 'confirm',
            name: 'confirmed',
            message: 'Disconnect GitHub? The current deployed site stays live.',
            initial: false,
          });
          if (!answer.confirmed) return;
        }
        await client.call('DELETE', '/github/connection', undefined, { project_id: ref });
        if (opts.json) printJson({ disconnected: true, project_id: ref });
        else success('GitHub disconnected. The current deployed site is unchanged.');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
