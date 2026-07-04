import { Command } from 'commander';
import open from '../lib/open.js';
import ora, { type Ora } from '../lib/spinner.js';
import { browserLogin } from '../lib/auth.js';
import {
  deviceLogin,
  DeviceLoginTimeout,
  DeviceCodeUnsupported,
} from '../lib/device-login.js';
import { ApiClient } from '../lib/client.js';
import {
  clearConfig,
  loadConfig,
  saveConfig,
  saveGlobalMcpConfig,
} from '../lib/config.js';
import { getDeviceId, getDeviceKeyName } from '../lib/device.js';
import { dim, error, info, printJson, success, teal } from '../lib/output.js';

async function loginAction(opts: { legacy?: boolean }): Promise<void> {
  if (opts.legacy) {
    await runLegacyLogin();
    return;
  }
  await runDeviceLogin();
}

export function registerAuth(program: Command) {
  program
    .command('login')
    .description('Authenticate with somewhere.tech')
    .option('--legacy', 'Use the localhost-callback flow instead of device code')
    .action(loginAction);

  program
    .command('logout')
    .description('Remove stored credentials')
    .action(() => {
      clearConfig();
      success('Logged out. Token removed from ~/.somewhere/config.json');
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
    .action(loginAction);

  auth
    .command('set <token>')
    .description('Save an smt_ token directly (no browser flow)')
    .action(async (token: string) => {
      if (!token.startsWith('smt_')) {
        error('Token must start with smt_');
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
  console.log('');
  console.log('  Login to somewhere.tech');
  console.log('');

  let spinner: Ora | null = null;
  installCancelHandler(() => spinner);

  try {
    const config = await deviceLogin({
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
    success('Claude Code MCP configured');
    process.exit(0);
  } catch (err) {
    (spinner as Ora | null)?.stop();
    if (err instanceof DeviceLoginTimeout) {
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
