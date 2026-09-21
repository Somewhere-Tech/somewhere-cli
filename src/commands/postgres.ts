import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import prompts from 'prompts';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import { resolveProjectRef } from '../lib/platform-command.js';
import { dim, error, info, printJson, printJsonError, success, teal, warn } from '../lib/output.js';

/**
 * `somewhere postgres` — bind the developer's OWN Neon database to a project.
 *
 * Pass-through, not managed: the developer owns the Neon account and pays Neon
 * directly. The platform stores the credentials and exposes the attached
 * database to deployed functions as `sw.postgres`, which IS the official
 * `@neondatabase/serverless` driver callable — this CLI never describes it as
 * anything else and never adds a query surface of its own.
 *
 * Two rules shape every command below:
 *
 *  1. The Neon MANAGEMENT key can delete the developer's databases. It is read
 *     from the environment, from stdin, or from a hidden prompt — never from
 *     argv, where it would be visible in the process table and in shell
 *     history. It is sent once and never written to the CLI config.
 *  2. Nothing that could carry a connection string or a key is printed. Human
 *     output reads an explicit allowlist of fields; the route contract already
 *     redacts the host and never returns either credential.
 */

/** The env var `connect` reads the Neon management key from, mirroring
 *  SOMEWHERE_TOKEN for `somewhere auth set`. */
const NEON_KEY_ENV = 'SOMEWHERE_NEON_API_KEY';

const KEY_SOURCE_HELP =
  `The Neon API key is read from ${NEON_KEY_ENV}, from stdin, or from a hidden prompt — ` +
  'never from an argument, where it would be visible in the process table. ' +
  'It is stored encrypted by the platform and never saved in your CLI config.';

/**
 * Why `connect` takes a key and not a browser sign-in.
 *
 * Neon's OAuth integration is restricted to active commercial partners
 * (https://neon.com/docs/guides/oauth-integration), and we are not registered.
 * Saying "for now" would imply a date nobody has committed to.
 */
const OAUTH_LIMITATION =
  'Setup is by Neon API key. Connecting a Neon account through the browser is not available — ' +
  "Neon restricts OAuth to registered commercial partners, which Somewhere isn't.";

/** What `attach`/`create` bind is baked into the bundle a release is BUILT
 *  from, so a database only reaches functions in the next deploy. */
const REDEPLOY_NOTICE =
  'Deploy again for sw.postgres to reach your functions — a release built before now does not have the binding.';

interface ConnectResult {
  project_id?: unknown;
  connected?: unknown;
  account?: unknown;
  requires_redeploy?: unknown;
}

interface AttachResult {
  project_id?: unknown;
  attached?: unknown;
  neon_project_id?: unknown;
  host?: unknown;
  requires_redeploy?: unknown;
}

interface CreateResult {
  project_id?: unknown;
  created?: unknown;
  neon_project_id?: unknown;
  host?: unknown;
  requires_redeploy?: unknown;
}

interface StatusResult {
  project_id?: unknown;
  connected?: unknown;
  attached?: unknown;
  neon_project_id?: unknown;
  host?: unknown;
  status?: unknown;
  error?: unknown;
  updated_at?: unknown;
  requires_redeploy?: unknown;
}

interface DisconnectResult {
  project_id?: unknown;
  disconnected?: unknown;
}

interface ProjectOptions {
  project?: string;
  json?: boolean;
}

/**
 * A create whose outcome the platform could not read.
 *
 * Neon's POST /projects takes no idempotency key and does not enforce name
 * uniqueness, so a second attempt spends the developer's money again and
 * leaves an orphan project behind. The CLI surfaces this verdict and stops; it
 * never retries, and it never suggests retrying.
 */
const CREATE_UNCERTAIN = 'POSTGRES_CREATE_UNCERTAIN';

const CREATE_UNCERTAIN_GUIDANCE = [
  'Do NOT run create again — Neon does not de-duplicate project creation, so a second attempt can bill you twice and leave an orphan database.',
  'Run `somewhere postgres status` to see what the platform recorded.',
  'Check your Neon console for a project matching this request; if one exists, bind it with `somewhere postgres attach <neon-project-id>`.',
];

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Read the Neon management key without it ever passing through argv. */
async function readNeonApiKey(): Promise<string> {
  const fromEnv = process.env[NEON_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;

  if (!process.stdin.isTTY) {
    // fd 0 directly: the same one-shot read `somewhere auth set` uses for a token.
    return readFileSync(0, 'utf8').trim();
  }

  const response = await prompts({
    type: 'password',
    name: 'key',
    message: 'Neon API key',
  });
  return typeof response.key === 'string' ? response.key.trim() : '';
}

/**
 * The account line for `connect`, from whatever identifying field the route
 * put in its already-redacted `account` object. Reads named fields only — an
 * unexpected field never reaches the terminal through here.
 */
function accountLabel(account: unknown): string | null {
  if (typeof account !== 'object' || account === null) return null;
  const record = account as Record<string, unknown>;
  return str(record.email) ?? str(record.name) ?? str(record.id);
}

/**
 * Whether to print the redeploy notice.
 *
 * `requires_redeploy: false` is the platform saying the binding is already
 * live, and it wins. Otherwise the notice stands: for attach/create it is true
 * by construction, and for connect (which stores a key and binds nothing) the
 * caller only asks when the platform said so explicitly.
 */
function shouldPrintRedeploy(value: unknown, whenAbsent: boolean): boolean {
  if (value === false) return false;
  if (value === true) return true;
  return whenAbsent;
}

function printRedeployNotice(requiresRedeploy: unknown, whenAbsent: boolean): void {
  if (shouldPrintRedeploy(requiresRedeploy, whenAbsent)) warn(REDEPLOY_NOTICE);
}

function reportError(err: unknown, json: boolean | undefined): void {
  if (err instanceof CliApiError) {
    const uncertain = err.code === CREATE_UNCERTAIN;
    if (json) {
      printJsonError(err.code, err.message, {
        ...(err.hint ? { hint: err.hint } : {}),
        // Carried in the envelope too: an agent reading --json must be able to
        // see "do not retry" without parsing prose.
        ...(uncertain ? { guidance: CREATE_UNCERTAIN_GUIDANCE } : {}),
      });
    } else {
      error(`${err.code}: ${err.message}`);
      if (err.hint) info(dim(err.hint));
      if (uncertain) for (const line of CREATE_UNCERTAIN_GUIDANCE) info(dim(line));
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    if (json) printJsonError('CLI_ERROR', message);
    else error(message);
  }
  process.exitCode = 1;
}

/** Confirm an action that has a cost or a consequence, the way `git disconnect` does. */
async function confirm(message: string, skip: boolean | undefined, flagHint: string): Promise<boolean> {
  if (skip) return true;
  if (!process.stdin.isTTY) throw new Error(flagHint);
  const answer = await prompts({ type: 'confirm', name: 'ok', message, initial: false });
  return answer.ok === true;
}

export function registerPostgres(program: Command): void {
  const postgres = program
    .command('postgres')
    .description('Attach your own Neon Postgres database to a project (sw.postgres)')
    .addHelpText(
      'after',
      '\nYou own the Neon account and pay Neon directly. Somewhere passes the connection through:\n' +
        'in a deployed function, sw.postgres is the official @neondatabase/serverless driver callable,\n' +
        'with the driver\'s own behavior and errors.\n' +
        `\n${OAUTH_LIMITATION}\n` +
        '\nExamples:\n' +
        `  printf %s "$NEON_API_KEY" | somewhere postgres connect --project my-app\n` +
        '  somewhere postgres attach <neon-project-id> --project my-app\n' +
        '  somewhere postgres status --project my-app\n',
    );

  postgres
    .command('connect')
    .description('Store your Neon API key for a project (the key is never passed as an argument)')
    .option('-p, --project <id-or-slug>', 'Project ID or slug; defaults to the linked project')
    .option('--json', 'Print the complete response as JSON')
    .allowExcessArguments(false)
    .addHelpText('after', `\n${KEY_SOURCE_HELP}\n\n${OAUTH_LIMITATION}\n`)
    .showHelpAfterError(
      'Do not pass the Neon API key as an argument — it is visible in the process table. ' +
        `Use \`printf %s "$NEON_API_KEY" | somewhere postgres connect\` or set ${NEON_KEY_ENV}.`,
    )
    .action(async (opts: ProjectOptions) => {
      try {
        const projectId = resolveProjectRef(opts.project);
        const apiKey = await readNeonApiKey();
        if (!apiKey) {
          throw new Error(
            `No Neon API key supplied. ${KEY_SOURCE_HELP}`,
          );
        }
        const client = new ApiClient(getToken());
        const result = await client.call<ConnectResult>('POST', '/postgres/connect', {
          project_id: projectId,
          api_key: apiKey,
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        success(`Neon account connected to ${teal(str(result.project_id) ?? projectId)}.`);
        const account = accountLabel(result.account);
        if (account) info(`Neon account: ${account}`);
        info(dim('The key is stored encrypted by the platform. It is not saved in your CLI config.'));
        // connect stores a key; it binds no database, so it needs a redeploy
        // only if the platform says it does.
        printRedeployNotice(result.requires_redeploy, false);
        info(
          dim(
            'Next: `somewhere postgres attach <neon-project-id>` for a database you already have, ' +
              'or `somewhere postgres create` to make one in your Neon account.',
          ),
        );
      } catch (err) {
        reportError(err, opts.json);
      }
    });

  postgres
    .command('attach <neon-project-id>')
    .description('Bind an existing Neon project to this project (never creates one)')
    .option('-p, --project <id-or-slug>', 'Project ID or slug; defaults to the linked project')
    .option('--database <name>', 'Database inside the Neon project')
    .option('--role <name>', 'Neon role to connect as')
    .option('--branch <name-or-id>', 'Neon branch to connect to')
    .option('--json', 'Print the complete response as JSON')
    .action(async (
      neonProjectId: string,
      opts: ProjectOptions & { database?: string; role?: string; branch?: string },
    ) => {
      try {
        const projectId = resolveProjectRef(opts.project);
        const client = new ApiClient(getToken());
        const result = await client.call<AttachResult>('POST', '/postgres/attach', {
          project_id: projectId,
          neon_project_id: neonProjectId,
          ...(opts.database === undefined ? {} : { database: opts.database }),
          ...(opts.role === undefined ? {} : { role: opts.role }),
          ...(opts.branch === undefined ? {} : { branch: opts.branch }),
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        success(
          `Attached Neon project ${teal(str(result.neon_project_id) ?? neonProjectId)} to ` +
            `${str(result.project_id) ?? projectId}.`,
        );
        const host = str(result.host);
        if (host) info(`Host: ${host}`);
        printRedeployNotice(result.requires_redeploy, true);
      } catch (err) {
        // A failed attach stops here. It never becomes a create: creating a
        // database the developer did not ask for spends their money.
        reportError(err, opts.json);
      }
    });

  postgres
    .command('create')
    .description('Create a new Neon project in YOUR Neon account and attach it (billed by Neon to you)')
    .option('-p, --project <id-or-slug>', 'Project ID or slug; defaults to the linked project')
    .option('--name <name>', 'Name for the new Neon project')
    .option('--region <region>', 'Neon region, e.g. aws-us-east-2')
    .option('-y, --yes', 'Create without confirming')
    .option('--json', 'Print the complete response as JSON')
    .addHelpText(
      'after',
      '\nThis creates a real database in your own Neon account and Neon bills you for it.\n' +
        'Creation is never automatic: a failed `attach` does not fall back to this command.\n' +
        'If the outcome is reported as uncertain, do NOT run it again — Neon does not de-duplicate\n' +
        'project creation. Run `somewhere postgres status` and check your Neon console instead.\n',
    )
    .action(async (opts: ProjectOptions & { name?: string; region?: string; yes?: boolean }) => {
      try {
        const projectId = resolveProjectRef(opts.project);
        const ok = await confirm(
          'Create a new Neon project in your Neon account? Neon bills you for it.',
          opts.yes,
          'Pass --yes to create a Neon project in a non-interactive shell. Neon bills you for it.',
        );
        if (!ok) {
          if (!opts.json) warn('Aborted — nothing was created.');
          return;
        }
        const client = new ApiClient(getToken());
        const result = await client.call<CreateResult>('POST', '/postgres/create', {
          project_id: projectId,
          ...(opts.name === undefined ? {} : { name: opts.name }),
          ...(opts.region === undefined ? {} : { region: opts.region }),
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        success(`Created Neon project ${teal(str(result.neon_project_id) ?? '(id not reported)')} in your Neon account.`);
        const host = str(result.host);
        if (host) info(`Host: ${host}`);
        info(dim('This database belongs to your Neon account and Neon bills you for it.'));
        printRedeployNotice(result.requires_redeploy, true);
      } catch (err) {
        // Deliberately no retry, not even on a timeout: see CREATE_UNCERTAIN.
        reportError(err, opts.json);
      }
    });

  postgres
    .command('status')
    .description('Show the Postgres attachment for a project (never prints a key or a connection string)')
    .option('-p, --project <id-or-slug>', 'Project ID or slug; defaults to the linked project')
    .option('--json', 'Print the complete response as JSON')
    .action(async (opts: ProjectOptions) => {
      try {
        const projectId = resolveProjectRef(opts.project);
        const client = new ApiClient(getToken());
        const result = await client.call<StatusResult>('GET', '/postgres/status', undefined, {
          project_id: projectId,
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        const connected = result.connected === true;
        const attached = result.attached === true;
        info(`Project:    ${str(result.project_id) ?? projectId}`);
        info(`Connected:  ${connected ? 'yes' : 'no'}${connected ? '' : dim('  (no Neon API key stored)')}`);
        info(`Attached:   ${attached ? 'yes' : 'no'}`);
        const neonProjectId = str(result.neon_project_id);
        if (neonProjectId) info(`Neon project: ${neonProjectId}`);
        const host = str(result.host);
        if (host) info(`Host:       ${host}`);
        const state = str(result.status);
        if (state) info(`Status:     ${state}`);
        const lastError = str(result.error);
        if (lastError) info(`Error:      ${lastError}`);
        const updatedAt = str(result.updated_at);
        if (updatedAt) info(`Updated:    ${updatedAt}`);
        printRedeployNotice(result.requires_redeploy, false);
        if (!connected) {
          info(dim('Run `somewhere postgres connect` to store your Neon API key.'));
          info(dim(OAUTH_LIMITATION));
        } else if (!attached) {
          info(dim('Run `somewhere postgres attach <neon-project-id>` or `somewhere postgres create`.'));
        }
      } catch (err) {
        reportError(err, opts.json);
      }
    });

  postgres
    .command('disconnect')
    .description("Remove Somewhere's Postgres attachment (your Neon database is NOT deleted)")
    .option('-p, --project <id-or-slug>', 'Project ID or slug; defaults to the linked project')
    .option('-y, --yes', 'Disconnect without confirming')
    .option('--json', 'Print the complete response as JSON')
    .addHelpText(
      'after',
      '\nThis removes the attachment and the stored credentials on our side. It never calls\n' +
        "Neon's delete: your database, its data and its Neon billing continue.\n" +
        'It is also not an immediate cut-off — a release that is already deployed can keep using\n' +
        'the connection it was built with until you redeploy or revoke the credential in Neon.\n',
    )
    .action(async (opts: ProjectOptions & { yes?: boolean }) => {
      try {
        const projectId = resolveProjectRef(opts.project);
        const ok = await confirm(
          'Remove the Postgres attachment? Your Neon database is not deleted.',
          opts.yes,
          'Pass --yes to disconnect in a non-interactive shell.',
        );
        if (!ok) {
          if (!opts.json) warn('Aborted — the attachment is unchanged.');
          return;
        }
        const client = new ApiClient(getToken());
        const result = await client.call<DisconnectResult>('POST', '/postgres/disconnect', {
          project_id: projectId,
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        success(`Postgres attachment removed for ${teal(str(result.project_id) ?? projectId)}.`);
        info('Your Neon database was NOT deleted — it and its Neon billing continue.');
        // Never claim an immediate cut-off we do not perform.
        warn(
          'Not an immediate revocation: a release deployed before now can keep using its existing ' +
            'connection until you redeploy, or revoke the credential in Neon.',
        );
      } catch (err) {
        reportError(err, opts.json);
      }
    });
}
