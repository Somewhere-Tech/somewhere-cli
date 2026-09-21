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
 * Field names mirror `worker/src/routes/postgres.ts` exactly
 * (`provider_project_id`, `branch_id`, `database`, `role`, `requires_redeploy`,
 * `note`). The CLI publishes no aliases of its own: an alias here is a second
 * name for the same thing that drifts the first time the route changes.
 *
 * Two rules shape every command below:
 *
 *  1. The Neon management key can delete the developer's databases. It is read
 *     from the environment, from stdin, or from a hidden prompt — never from
 *     argv, where it would be visible in the process table and in shell
 *     history. It is sent once and never written to the CLI config.
 *  2. Nothing that could carry a connection string or a key is printed. Human
 *     output reads an explicit allowlist of fields; the route already redacts
 *     the host and never returns either credential.
 *
 * Connection is by API key. There is no browser account-connect flow to offer
 * because Neon restricts OAuth to registered commercial partners — a design
 * constraint worth recording here, and not worth spending a customer's help
 * text on.
 */

/** The env var `connect` reads the Neon management key from, mirroring
 *  SOMEWHERE_TOKEN for `somewhere auth set`. */
const NEON_KEY_ENV = 'SOMEWHERE_NEON_API_KEY';

const NEON_KEY_DOCS = 'https://neon.com/docs/manage/api-keys';

const KEY_SOURCE_HELP =
  `The Neon API key is read from ${NEON_KEY_ENV}, from stdin, or from a hidden prompt — ` +
  'never from an argument, where it would be visible in the process table. ' +
  'It is stored encrypted by the platform and never saved in your CLI config.';

/** Fallback for a route that reports `requires_redeploy` without a `note`.
 *  When the route sends its own note, that text wins — one sentence, written
 *  once, server-side, so the CLI cannot drift from it. */
const REDEPLOY_NOTICE =
  'Takes effect on the next deploy. Releases already deployed keep the connection details they were built with.';

/**
 * Reconciliation, not retry.
 *
 * Neon's POST /projects takes no idempotency key and does not enforce name
 * uniqueness, so a second attempt spends the developer's money again and
 * leaves an orphan project behind. This is the guidance for both ways an
 * outcome can be unknown: the route answering POSTGRES_CREATE_UNCERTAIN, and
 * no HTTP answer arriving at all.
 */
const CREATE_RECONCILE_GUIDANCE = [
  'Do NOT run create again — Neon does not de-duplicate project creation, so a second attempt can bill you twice and leave a database you never asked for.',
  'Run `somewhere postgres status` to see what the platform recorded.',
  'Check your Neon account for a project matching this request; if one exists, bind it with `somewhere postgres attach <neon-project-id>`.',
];

const CREATE_UNCERTAIN = 'POSTGRES_CREATE_UNCERTAIN';

interface ConnectResult {
  connected?: unknown;
  requires_redeploy?: unknown;
  note?: unknown;
}

interface AttachResult {
  attached?: unknown;
  provider_project_id?: unknown;
  branch_id?: unknown;
  database?: unknown;
  role?: unknown;
  host?: unknown;
  requires_redeploy?: unknown;
  note?: unknown;
}

interface CreateResult {
  created?: unknown;
  attached?: unknown;
  provider_project_id?: unknown;
  region?: unknown;
  host?: unknown;
  requires_redeploy?: unknown;
  note?: unknown;
}

interface StatusResult {
  connected?: unknown;
  attached?: unknown;
  status?: unknown;
  auth_kind?: unknown;
  provider?: unknown;
  provider_project_id?: unknown;
  branch_id?: unknown;
  database?: unknown;
  role?: unknown;
  host?: unknown;
  last_error?: unknown;
  attached_at?: unknown;
  updated_at?: unknown;
}

interface DisconnectResult {
  disconnected?: unknown;
  detached?: unknown;
  cleared_pending_create?: unknown;
  key_removed?: unknown;
  database_deleted?: unknown;
  /** The only remaining handle on a database that may exist and be billing.
   *  Sent once, because the attachment row will not name it after this. */
  unresolved_provider_project_id?: unknown;
  unresolved_note?: unknown;
  requires_redeploy?: unknown;
  note?: unknown;
}

interface ProjectOptions {
  project?: string;
  json?: boolean;
}

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

/** A padded `label  value` line, matching the alignment `auth status` uses. */
function field(label: string, value: string): void {
  info(`${label.padEnd(14)}${value}`);
}

/**
 * Say what happens next, in the route's own words when it supplies them.
 *
 * `note` is the single sentence the routes share for "existing releases keep
 * what they were built with". Printing it rather than a local paraphrase is
 * what keeps the CLI from making a revocation claim the platform does not.
 */
function printNote(result: { requires_redeploy?: unknown; note?: unknown }): void {
  // The shared note is about what the NEXT deploy picks up. `disconnect` sends
  // it unconditionally but reports requires_redeploy:false when it detached
  // nothing — clearing a stuck create changes no release, so printing "takes
  // effect on the next deploy" there would describe work that does not exist.
  if (result.requires_redeploy === false) return;
  const note = str(result.note);
  if (note) {
    warn(note);
    return;
  }
  if (result.requires_redeploy === true) warn(REDEPLOY_NOTICE);
}

function reportError(err: unknown, json: boolean | undefined): void {
  if (err instanceof CliApiError) {
    const uncertain = err.code === CREATE_UNCERTAIN;
    if (json) {
      printJsonError(err.code, err.message, {
        ...(err.hint ? { hint: err.hint } : {}),
        // An agent reading --json must see "do not retry" without parsing prose.
        ...(uncertain ? { outcome: 'unknown', guidance: CREATE_RECONCILE_GUIDANCE } : {}),
      });
    } else {
      error(`${err.code}: ${err.message}`);
      if (err.hint) info(dim(err.hint));
      if (uncertain) for (const line of CREATE_RECONCILE_GUIDANCE) info(dim(line));
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    if (json) printJsonError('CLI_ERROR', message);
    else error(message);
  }
  process.exitCode = 1;
}

/**
 * The first sentence of a transport failure — what happened, without the advice.
 *
 * The client's NETWORK_ERROR/TIMEOUT/SERVER_SLOW messages all open by naming
 * the endpoint and the cause and then close by telling the caller to retry.
 * That tail is correct for a read and wrong for provisioning, so the create
 * path keeps the diagnosis and drops the advice rather than printing both and
 * contradicting itself.
 */
function transportDetail(message: string): string {
  return /^(.*?\.)\s/.exec(message)?.[1] ?? message;
}

/**
 * A create whose failure does not prove the database was not created.
 *
 * Two shapes qualify, and neither is a definite "no":
 *
 *  - `statusCode === 0` — the client's marker for "no response received": a
 *    timeout, a dropped connection. The request may have reached Neon and
 *    provisioned a database nobody can see yet.
 *  - Any 5xx. A gateway can answer 500/502/503/504 for a POST the origin
 *    already committed, so the failure is the *answer* going missing, not the
 *    work. That covers the platform's own POSTGRES_PROVIDER_ERROR too: the
 *    provider having errored is not evidence it created nothing.
 *
 * The error's own code is kept rather than relabelled as the route's
 * POSTGRES_CREATE_UNCERTAIN — that is the route's verdict to give, and in
 * these cases the route either never answered or answered something else.
 * What the CLI adds is the outcome being unknown and guidance that
 * reconciles rather than retries. It never claims a database WAS created.
 *
 * 4xx answers are left definite: validation, auth, owner-role and refusals are
 * the server saying it did not act, and calling them uncertain would send
 * someone hunting through their Neon account for nothing.
 */
function isAmbiguousCreateOutcome(err: CliApiError): boolean {
  return err.statusCode === 0 || err.statusCode >= 500;
}

function reportAmbiguousCreateOutcome(err: CliApiError, json: boolean | undefined): void {
  // A client-synthesized transport message closes with retry advice that is
  // wrong here, so only its first sentence survives. A 5xx message came from
  // the platform, is already specific about what failed, and is kept whole.
  const detail = err.statusCode === 0 ? transportDetail(err.message) : err.message;
  const message =
    'The create request did not return a usable result, so a Neon database may or may not have been created. ' +
    `The outcome is unknown, not failed. (${detail})`;
  if (json) {
    printJsonError(err.code, message, { outcome: 'unknown', guidance: CREATE_RECONCILE_GUIDANCE });
  } else {
    error(`${err.code}: ${message}`);
    for (const line of CREATE_RECONCILE_GUIDANCE) info(dim(line));
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
        "with the driver's own behavior and errors.\n" +
        `\nConnect using a Neon API key: ${NEON_KEY_DOCS}\n` +
        '\nExamples:\n' +
        '  printf %s "$NEON_API_KEY" | somewhere postgres connect --project my-app\n' +
        '  somewhere postgres attach <neon-project-id> --project my-app\n' +
        '  somewhere postgres status --project my-app\n',
    );

  postgres
    .command('connect')
    .description('Store your Neon API key for a project (the key is never passed as an argument)')
    .option('-p, --project <id-or-slug>', 'Project ID or slug; defaults to the linked project')
    .option(
      '--neon-project <id>',
      'Verify the key against this Neon project instead of the whole account — required for a project-scoped key',
    )
    .option('--json', 'Print the complete response as JSON')
    .allowExcessArguments(false)
    .addHelpText(
      'after',
      `\n${KEY_SOURCE_HELP}\n` +
        `\nCreate a Neon API key: ${NEON_KEY_DOCS}\n` +
        '\nThe key is checked against the work it will do. An account-scoped key is verified by\n' +
        'listing your Neon projects; a project-scoped key cannot list them, so pass --neon-project\n' +
        '<id> and it is verified by reading that project instead.\n',
    )
    .showHelpAfterError(
      'Do not pass the Neon API key as an argument — it is visible in the process table. ' +
        `Use \`printf %s "$NEON_API_KEY" | somewhere postgres connect\` or set ${NEON_KEY_ENV}.`,
    )
    .action(async (opts: ProjectOptions & { neonProject?: string }) => {
      try {
        const projectId = resolveProjectRef(opts.project);
        const apiKey = await readNeonApiKey();
        if (!apiKey) throw new Error(`No Neon API key supplied. ${KEY_SOURCE_HELP}`);
        const client = new ApiClient(getToken());
        const result = await client.call<ConnectResult>('POST', '/postgres/connect', {
          project_id: projectId,
          api_key: apiKey,
          ...(opts.neonProject === undefined ? {} : { provider_project_id: opts.neonProject }),
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        success(`Neon account connected to ${teal(projectId)}.`);
        info(dim('The key is stored encrypted by the platform. It is not saved in your CLI config.'));
        printNote(result);
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
    .option('--database <name>', 'Database to connect to; required when the branch has more than one')
    .option('--role <name>', 'Neon role to connect as; required when the branch has more than one')
    .option('--branch <id>', 'Neon branch ID; defaults to the branch Neon marks default')
    .option('--no-pooled', "Connect directly instead of through Neon's connection pooler")
    .option('--json', 'Print the complete response as JSON')
    .addHelpText(
      'after',
      '\nBranch, database and role are chosen explicitly. When Neon offers several and you named\n' +
        'none, the platform refuses and lists them rather than binding whichever sorted first.\n' +
        'Attaching never resets a role password, because that would break anything else using it.\n' +
        '\nConnections go through Neon\'s pooler by default. Pass --no-pooled for a direct connection\n' +
        'when you need session-level features the pooler does not carry.\n',
    )
    .action(async (
      neonProjectId: string,
      opts: ProjectOptions & { database?: string; role?: string; branch?: string; pooled?: boolean },
    ) => {
      try {
        const projectId = resolveProjectRef(opts.project);
        const client = new ApiClient(getToken());
        const result = await client.call<AttachResult>('POST', '/postgres/attach', {
          project_id: projectId,
          provider_project_id: neonProjectId,
          ...(opts.database === undefined ? {} : { database: opts.database }),
          ...(opts.role === undefined ? {} : { role: opts.role }),
          ...(opts.branch === undefined ? {} : { branch_id: opts.branch }),
          // Commander defaults a --no-x flag to true, so only an explicit
          // --no-pooled is sent; the platform owns the pooled default.
          ...(opts.pooled === false ? { pooled: false } : {}),
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        success(`Attached Neon project ${teal(str(result.provider_project_id) ?? neonProjectId)} to ${projectId}.`);
        const database = str(result.database);
        if (database) field('Database:', database);
        const role = str(result.role);
        if (role) field('Role:', role);
        const branchId = str(result.branch_id);
        if (branchId) field('Branch:', branchId);
        const host = str(result.host);
        if (host) field('Host:', host);
        printNote(result);
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
        'If the outcome is reported as unknown, do NOT run it again — Neon does not de-duplicate\n' +
        'project creation. Run `somewhere postgres status` and check your Neon account instead.\n',
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
        success(`Created Neon project ${teal(str(result.provider_project_id) ?? '(id not reported)')} in your Neon account.`);
        const region = str(result.region);
        if (region) field('Region:', region);
        const host = str(result.host);
        if (host) field('Host:', host);
        info(dim('This database belongs to your Neon account and Neon bills you for it.'));
        printNote(result);
      } catch (err) {
        // Never retried. A lost response or a 5xx is reported as an unknown
        // outcome rather than as the generic "safe to try again" failure.
        if (err instanceof CliApiError && isAmbiguousCreateOutcome(err)) {
          reportAmbiguousCreateOutcome(err, opts.json);
          return;
        }
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
        field('Project:', projectId);
        field('Connected:', connected ? 'yes' : `no${dim('  (no Neon API key stored)')}`);
        field('Attached:', attached ? 'yes' : 'no');
        for (const [label, value] of [
          ['Provider:', result.provider],
          ['Neon project:', result.provider_project_id],
          ['Branch:', result.branch_id],
          ['Database:', result.database],
          ['Role:', result.role],
          ['Host:', result.host],
          ['State:', result.status],
          ['Auth:', result.auth_kind],
          ['Last error:', result.last_error],
          ['Attached at:', result.attached_at],
          ['Updated:', result.updated_at],
        ] as Array<[string, unknown]>) {
          const text = str(value);
          if (text) field(label, text);
        }
        if (!connected) {
          info(dim(`Run \`somewhere postgres connect\` to store your Neon API key: ${NEON_KEY_DOCS}`));
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
    .option('--forget-key', 'Also delete the stored Neon API key, not just the attachment')
    .option('-y, --yes', 'Disconnect without confirming')
    .option('--json', 'Print the complete response as JSON')
    .addHelpText(
      'after',
      '\nThis removes the attachment on our side. It never calls Neon\'s delete: your database,\n' +
        'its data and its Neon billing continue.\n' +
        'It is also not an immediate cut-off — a release that is already deployed keeps the\n' +
        'connection details it was built with. Rotate the credential in Neon to cut those off.\n' +
        '\nThe stored Neon API key is kept by default, so you can attach again without supplying it.\n' +
        'Pass --forget-key to delete it too; a later attach then needs `somewhere postgres connect` first.\n' +
        '\nDisconnecting also clears a create that never resolved. If that create had already reached\n' +
        'your provider, the id of the database it left behind is printed once here — after this the\n' +
        'platform no longer stores it, and that database keeps billing until you attach or delete it.\n',
    )
    .action(async (opts: ProjectOptions & { yes?: boolean; forgetKey?: boolean }) => {
      try {
        const projectId = resolveProjectRef(opts.project);
        const ok = await confirm(
          opts.forgetKey
            ? 'Remove the Postgres attachment and delete the stored Neon API key? Your Neon database is not deleted.'
            : 'Remove the Postgres attachment? Your Neon database is not deleted.',
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
          ...(opts.forgetKey ? { forget_key: true } : {}),
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        // Detaching a live database and clearing a create that never resolved
        // are different events, and the route now distinguishes them. Saying
        // "attachment removed" for a project that had nothing attached would
        // describe a detach that did not happen.
        const detached = result.detached === true;
        const clearedPendingCreate = result.cleared_pending_create === true;
        if (detached) {
          success(`Postgres attachment removed for ${teal(projectId)}.`);
          info('Your Neon database was NOT deleted — it and its Neon billing continue.');
        } else if (clearedPendingCreate) {
          success(`Cleared an unresolved create for ${teal(projectId)}. No attached database was removed.`);
        } else {
          success(`Postgres record cleared for ${teal(projectId)}. Nothing was attached.`);
        }
        if (result.key_removed === true) info('The stored Neon API key was deleted too.');
        else info(dim('The stored Neon API key was kept — pass --forget-key to delete it as well.'));
        // After this the platform no longer stores the id, so this is the last
        // time anything can tell the developer what to reconcile. Printed in
        // normal output, not behind --json: a database they are paying for
        // must not disappear from view because they ran the human command.
        const unresolvedId = str(result.unresolved_provider_project_id);
        if (unresolvedId) field('Unresolved:', unresolvedId);
        const unresolvedNote = str(result.unresolved_note);
        if (unresolvedNote) warn(unresolvedNote);
        // The route's own sentence about already-deployed releases; never a
        // local paraphrase that could harden into a revocation claim.
        printNote(result);
      } catch (err) {
        reportError(err, opts.json);
      }
    });
}
