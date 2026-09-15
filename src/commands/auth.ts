import { Command } from 'commander';
import {
  closeSync,
  constants as fsConstants,
  createWriteStream,
  fchmodSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import prompts from 'prompts';
import open from '../lib/open.js';
import ora, { type Ora } from '../lib/spinner.js';
import { browserLogin } from '../lib/auth.js';
import {
  deviceLogin,
  DeviceLoginTimeout,
  DeviceLoginDenied,
  DeviceCodeUnsupported,
  type DeviceSessionScope,
} from '../lib/device-login.js';
import { ApiClient, CliApiError } from '../lib/client.js';
import {
  clearConfig,
  getToken,
  loadConfig,
  loadProjectConfig,
  saveConfig,
  saveGlobalMcpConfig,
} from '../lib/config.js';
import { getDeviceId, getDeviceKeyName } from '../lib/device.js';
import { formatNextActions, nextActions } from '../lib/next-actions.js';
import { bold, dim, error, info, printJson, success, teal, warn } from '../lib/output.js';
import { resolveProjectRef } from '../lib/platform-command.js';

async function readAuthToken(): Promise<string> {
  const envToken = process.env.SOMEWHERE_TOKEN?.trim();
  if (envToken) return envToken;

  if (!process.stdin.isTTY) {
    return readFileSync(0, 'utf8').trim();
  }

  const response = await prompts({
    type: 'password',
    name: 'token',
    message: 'Token',
  });
  return typeof response.token === 'string' ? response.token.trim() : '';
}

async function readPasswordExportCode(): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input.trim();
  }
  const response = await prompts({
    type: 'password',
    name: 'code',
    message: 'Approval code from the verified owner email',
  });
  return typeof response.code === 'string' ? response.code.trim() : '';
}

function createProtectedOutput(path: string): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELOOP') {
      throw new Error(`Refusing to overwrite existing path: ${path}`);
    }
    throw err;
  }
  try {
    fchmodSync(fd, 0o600);
    return fd;
  } catch (err) {
    try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(path); } catch { /* best effort */ }
    throw err;
  }
}

/** The account-creation page. `login` sends an existing user through the OAuth
 *  device flow, which offers no way to create an account — a stranger with no
 *  Google or GitHub account had no front door from the CLI at all
 *  (tsk_0e9e13b8). This URL is the one that does. */
export const SIGNUP_URL = 'https://somewhere.tech/auth?intent=signup';

/** The one line `login` prints so a new user is never stranded, and the line
 *  `signup` is built around. Kept as data so it can be pinned by a test
 *  without driving a browser. */
export const SIGNUP_HINT = `New here? Create an account: ${SIGNUP_URL}`;

/** One line for what a session may touch, as the approval page decided it. */
export function describeScope(scope: DeviceSessionScope | null | undefined): string {
  if (!scope) return 'all projects';
  const n = scope.projects.length;
  return `${n} project${n === 1 ? '' : 's'} only (${scope.projects.map((id) => id.slice(0, 8)).join(', ')}) — other projects are refused`;
}

/** Everything `somewhere login` prints before it contacts the platform. */
export function loginIntroLines(): string[] {
  return [
    '',
    '  Login to somewhere.tech',
    `  ${SIGNUP_HINT}`,
    '',
  ];
}

async function signupAction(): Promise<void> {
  console.log('');
  console.log('  Create your somewhere.tech account');
  console.log('');
  // Printed as plain text before anything is opened: a headless agent can only
  // relay a URL it can read.
  console.log(`  ${teal(SIGNUP_URL)}`);
  console.log('');
  console.log("  Opening your browser…  (if it doesn't open, use the URL above)");
  console.log('');
  if (!process.env.SOMEWHERE_NO_BROWSER) {
    await open(SIGNUP_URL).catch(() => {
      // Browser didn't open — the URL is already printed above
    });
  }
  info(dim('Once your account exists, run: somewhere login'));
}

async function loginAction(opts: { legacy?: boolean; signup?: boolean }): Promise<void> {
  if (opts.signup) {
    await signupAction();
    return;
  }
  if (opts.legacy) {
    await runLegacyLogin();
    return;
  }
  await runDeviceLogin();
}

export function registerAuth(program: Command) {
  program
    .command('login')
    .description('Authenticate with somewhere.tech (no account yet? run `somewhere signup`)')
    .option('--legacy', 'Use the localhost-callback flow instead of device code')
    .option('--signup', 'Create a new account instead — opens the sign-up page')
    .action(loginAction);

  program
    .command('signup')
    .description('Create a somewhere.tech account — opens the sign-up page and prints its URL')
    .action(signupAction);

  program
    .command('logout')
    .description('Revoke and remove stored credentials')
    .action(async () => {
      const config = loadConfig();
      const clearOnInterrupt = () => {
        try {
          clearConfig();
        } finally {
          process.exit(130);
        }
      };
      const clearOnTermination = () => {
        try {
          clearConfig();
        } finally {
          process.exit(143);
        }
      };
      process.once('SIGINT', clearOnInterrupt);
      process.once('SIGTERM', clearOnTermination);
      let revokedOnServer = false;
      try {
        if (config) {
          const client = new ApiClient(config.token);
          await client.call('POST', '/auth/cli-logout', {
            refresh_token: config.refresh_token,
          }, undefined, { timeoutMs: 5_000 });
          revokedOnServer = true;
        }
      } catch {
        warn('Server revocation could not be confirmed; local credentials will still be removed. Revoke this device under Settings → Devices & sessions if it should not stay signed in.');
      } finally {
        process.off('SIGINT', clearOnInterrupt);
        process.off('SIGTERM', clearOnTermination);
        clearConfig();
      }
      success(revokedOnServer
        ? 'Logged out. This device\'s session was revoked on the server and the token removed from ~/.somewhere/config.json'
        : 'Logged out locally. Token removed from ~/.somewhere/config.json');
    });

  program
    .command('whoami')
    .description('Show current user info')
    .option('--json', 'Print the raw account response as JSON')
    .action(async (opts) => {
      const config = loadConfig();
      if (!config) {
        error('Not logged in. Run: somewhere login');
        process.exit(1);
      }

      const client = new ApiClient(config.token);
      try {
        const r = await client.call<{
          user: {
            email: string;
            name: string | null;
            username: string | null;
            effective_tier: string;
          };
          stats: { api_keys: number; projects: number };
          session?: { id: string; label: string; expires_at: string | null; scope: DeviceSessionScope | null } | null;
        }>('GET', '/auth/whoami');

        if (opts.json) {
          printJson(r);
          return;
        }

        const tier = r.user.effective_tier === 'builder' ? 'Builder' : 'Free';
        console.log(`${teal(r.user.email)}  ${dim(`(${tier})`)}`);
        if (r.user.name) info(dim(r.user.name));
        if (r.user.username) info(dim(`@${r.user.username}`));
        info(dim(`${r.stats.projects} project${r.stats.projects === 1 ? '' : 's'}, ${r.stats.api_keys} active key${r.stats.api_keys === 1 ? '' : 's'}`));
        info(dim(`key ${config.token.slice(0, 12)}…`));
        if (r.session) {
          info(dim(`session ${r.session.label} · access: ${describeScope(r.session.scope)}`));
        }
      } catch (err) {
        // Agents gate on `whoami` to validate the token — a stored-but-dead token
        // must NOT report success. Show the cached identity, then exit non-zero.
        // A revoked session (dashboard "Revoke", `somewhere logout` elsewhere)
        // says so in the platform's own words rather than guessing "expired".
        const revoked = err instanceof CliApiError && err.statusCode === 401 && /revoked/i.test(err.message);
        const message = revoked
          ? err.message
          : 'Could not fetch account details — token may be expired. Run: somewhere login';
        if (opts.json) {
          printJson({ error: revoked ? 'SESSION_REVOKED' : 'WHOAMI_FAILED', message });
          process.exitCode = 1;
          return;
        }
        console.log(teal(config.user.email));
        info(dim(message));
        process.exitCode = 1;
      }
    });

  const auth = program.command('auth').description('Manage stored credentials');

  // Alias of the top-level `login` — published docs and gh-style muscle
  // memory both expect `somewhere auth login` to work.
  auth
    .command('login')
    .description('Authenticate with somewhere.tech (alias of `somewhere login`)')
    .option('--legacy', 'Use the localhost-callback flow instead of device code')
    .option('--signup', 'Create a new account instead — opens the sign-up page')
    .action(loginAction);

  auth
    .command('set')
    .description('Save an smt_ token from SOMEWHERE_TOKEN or stdin (no browser flow)')
    .allowExcessArguments(false)
    .showHelpAfterError(
      'Do not pass tokens as arguments: they are visible in the process table. ' +
      'Use `printf %s "$SOMEWHERE_TOKEN" | somewhere auth set` or set SOMEWHERE_TOKEN.',
    )
    .action(async () => {
      const token = await readAuthToken();
      if (!token.startsWith('smt_')) {
        error('Token must be provided via SOMEWHERE_TOKEN or stdin and start with smt_');
        process.exit(1);
      }
      // Verify the token works before persisting it.
      const client = new ApiClient(token);
      let email = '';
      let username = '';
      try {
        const me = await client.call<{ email?: string; username?: string }>(
          'GET',
          '/auth/platform-me',
        );
        email = me.email ?? '';
        username = me.username ?? '';
      } catch (err) {
        error(`Token is not valid: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      saveConfig({ token, user: { email, username } });
      saveGlobalMcpConfig();
      success(`Token saved.${email ? ` Logged in as ${teal(email)}.` : ''}`);
      info('Run `somewhere projects` to verify.');
    });

  auth
    .command('status')
    .description('Show current login state, device ID, key name, and advisor health')
    .action(async () => {
      const config = loadConfig();
      const deviceId = getDeviceId();
      const keyName = getDeviceKeyName();

      if (!config) {
        info('Not logged in.');
        info(`Device ID:  ${deviceId}`);
        info(`Key name:   ${keyName}`);
        info(dim('Run `somewhere login` to authenticate.'));
        return;
      }

      success(`Logged in as ${teal(config.user.email || '(unknown)')}`);
      info(`Device ID:  ${deviceId}`);
      info(`Key name:   ${keyName}`);
      info(`Token:      ${config.token.slice(0, 8)}…${config.token.slice(-4)}`);
    });

  auth
    .command('export [project]')
    .description('Export portable end-user password credentials after verified-owner email approval')
    .option('--project <ref>', 'Project ID, name, slug, or subdomain (defaults to the linked project)')
    .requiredOption('--output <path>', 'New local JSON file to create (existing paths are never overwritten)')
    .allowExcessArguments(false)
    .showHelpAfterError('The approval code is read from a hidden prompt or stdin; never pass it as an argument.')
    .action(async (
      project: string | undefined,
      opts: { project?: string; output: string },
    ) => {
      let outputFd: number | null = null;
      let outputCreated = false;
      let wroteOutput = false;
      const destination = resolve(opts.output);
      try {
        if (project && opts.project && project.trim() !== opts.project.trim()) {
          throw new Error(`Two different projects named in one command: \`${project}\` and --project ${opts.project}. Pass one.`);
        }
        const projectRef = resolveProjectRef(opts.project ?? project);

        // Reserve the exact destination before sending an approval email. The
        // exclusive, no-follow open makes overwrite and symlink races fail.
        outputFd = createProtectedOutput(destination);
        outputCreated = true;

        const client = new ApiClient(getToken());
        const request = await client.call<{ status: string; expires_in_seconds: number }>(
          'POST',
          '/auth/export/request',
          { project_id: projectRef },
        );
        const approvalState = request.status === 'pending'
          ? 'Approval email queued; delivery is still pending.'
          : 'Approval sent to the verified project-owner email.';
        info(`${approvalState} It expires in ${Math.ceil(request.expires_in_seconds / 60)} minutes.`);

        const code = await readPasswordExportCode();
        if (!/^\d{6}$/.test(code)) throw new Error('Approval code must be exactly 6 digits.');

        const body = JSON.stringify({ project_id: projectRef, code });
        let response: Awaited<ReturnType<ApiClient['callStream']>>;
        try {
          response = await client.callStream(
            'POST',
            '/auth/export/download',
            () => body,
            {
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
              },
              // A dropped response may have spent the one-time approval. Even
              // this in-memory body must never be retried automatically.
              replayableBody: false,
            },
          );
        } catch (err) {
          if (err instanceof CliApiError && ['NETWORK_ERROR', 'TIMEOUT', 'RETRY_REQUIRED'].includes(err.code)) {
            throw new Error(
              'The password export download outcome could not be confirmed. ' +
              'The local file was removed; run the command again to request a new approval code.',
            );
          }
          throw err;
        }
        if (!response.ok) {
          let failure: { error?: string; message?: string } = {};
          try { failure = await response.json() as { error?: string; message?: string }; } catch { /* generic below */ }
          throw new CliApiError(
            failure.error ?? 'AUTH_EXPORT_FAILED',
            failure.message ?? `Password export failed (HTTP ${response.status}).`,
            response.status,
          );
        }
        if (!response.body) throw new Error('The server returned an empty password export.');

        await pipeline(response.body, createWriteStream(destination, { fd: outputFd, autoClose: true }));
        outputFd = null;
        wroteOutput = true;
        success(`Password credentials written to ${destination}`);
      } catch (err) {
        if (outputFd !== null) {
          try { closeSync(outputFd); } catch { /* best effort */ }
          outputFd = null;
        }
        if (outputCreated && !wroteOutput) {
          try { unlinkSync(destination); } catch { /* best effort */ }
        }
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  auth
    .command('print-token')
    .description('Print the current smt_ token for shell scripts')
    .action(() => {
      process.stdout.write(`${getToken()}\n`);
    });
}

/** Both login paths end the same way: one step, chosen by whether this
 *  directory is already a project. Never on `--json` — login prints no JSON,
 *  and this is stdout copy for a human or an agent reading the transcript. */
function printPostLoginNext(): void {
  console.log('');
  info(bold('Next'));
  const actions = nextActions({ stage: 'login', linkedProject: Boolean(loadProjectConfig()) });
  for (const line of formatNextActions(actions, { command: teal, why: dim })) {
    console.log(line);
  }
}

function installCancelHandler(getSpinner: () => Ora | null): void {
  process.on('SIGINT', () => {
    getSpinner()?.stop();
    process.stdout.write('\u001B[?25h'); // restore cursor in case ora hid it
    console.log('');
    info('Login cancelled.');
    process.exit(130);
  });
}

async function runDeviceLogin(): Promise<void> {
  for (const line of loginIntroLines()) console.log(line);

  let spinner: Ora | null = null;
  installCancelHandler(() => spinner);

  try {
    const { config, scope } = await deviceLogin({
      onPrompt: ({ code, approvalUrl }) => {
        console.log(`  Code: ${teal(code)}`);
        console.log('');
        console.log('  Opening your browser…');
        console.log(`  If it doesn't open, visit: ${teal(approvalUrl)}`);
        console.log('');
        open(approvalUrl).catch(() => {
          // Browser didn't open — URL is already printed above
        });
      },
      onWaiting: () => {
        spinner = ora({
          text: 'Waiting for approval…  (press Ctrl+C to cancel)',
          color: 'cyan',
        }).start();
      },
    });
    (spinner as Ora | null)?.stop();
    saveConfig(config);
    saveGlobalMcpConfig();
    success(`Logged in as ${teal(config.user.email || '(unknown)')}`);
    success(`Device: ${getDeviceKeyName()}`);
    success(`Access: ${describeScope(scope)}`);
    success('Claude Code MCP configured');
    printPostLoginNext();
    process.exit(0);
  } catch (err) {
    (spinner as Ora | null)?.stop();
    if (err instanceof DeviceLoginTimeout || err instanceof DeviceLoginDenied) {
      error(err.message);
      process.exit(1);
    }
    if (err instanceof DeviceCodeUnsupported) {
      info(dim('Falling back to localhost-callback login…'));
      await runLegacyLogin();
      return;
    }
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function runLegacyLogin(): Promise<void> {
  for (const line of loginIntroLines()) console.log(line);
  const spinner = ora('Waiting for browser login…  (press Ctrl+C to cancel)').start();
  installCancelHandler(() => spinner);
  try {
    const config = await browserLogin();
    saveConfig(config);
    saveGlobalMcpConfig();
    spinner.stop();
    success(`Logged in as ${teal(config.user.email)}`);
    success('Claude Code MCP configured');
    printPostLoginNext();
    process.exit(0);
  } catch (err) {
    spinner.fail('Login failed');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
