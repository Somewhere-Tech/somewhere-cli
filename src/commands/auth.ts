import { Command } from 'commander';
import { readFileSync } from 'node:fs';
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
import { ApiClient } from '../lib/client.js';
import {
  clearConfig,
  getToken,
  loadConfig,
  saveConfig,
  saveGlobalMcpConfig,
} from '../lib/config.js';
import { getDeviceId, getDeviceKeyName } from '../lib/device.js';
import { dim, error, info, printJson, success, teal, warn } from '../lib/output.js';

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
      } catch {
        // Agents gate on `whoami` to validate the token — a stored-but-dead token
        // must NOT report success. Show the cached identity, then exit non-zero.
        if (opts.json) {
          printJson({
            error: 'WHOAMI_FAILED',
            message: 'Could not fetch account details — token may be expired. Run: somewhere login',
          });
          process.exitCode = 1;
          return;
        }
        console.log(teal(config.user.email));
        info(dim('Could not fetch account details — token may be expired. Run: somewhere login'));
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
    .description('Show current login state, device ID, and key name')
    .action(() => {
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
    .command('print-token')
    .description('Print the current smt_ token for shell scripts')
    .action(() => {
      process.stdout.write(`${getToken()}\n`);
    });
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
    process.exit(0);
  } catch (err) {
    spinner.fail('Login failed');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
