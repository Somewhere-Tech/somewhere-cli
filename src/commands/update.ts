import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Command } from 'commander';
import { dim, error, info, success, teal } from '../lib/output.js';

const PACKAGE = '@somewhere-tech/cli';

/** Read the installed CLI's own version from its package.json (dist/commands/ →
 *  package root is two levels up). */
function currentVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export function registerUpdate(program: Command) {
  program
    .command('update')
    .description('Update the somewhere CLI to the latest published version (via npm).')
    .option('--check', 'Only report whether an update is available; do not install.')
    .action((opts: { check?: boolean }) => {
      const current = currentVersion();

      let latest: string;
      try {
        latest = execSync(`npm view ${PACKAGE} version`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        error('Could not reach npm to check the latest version. Check your connection and try again.');
        process.exit(1);
      }

      if (!latest) {
        error('Could not determine the latest version from npm.');
        process.exit(1);
      }

      if (latest === current) {
        success(`You're on the latest version (${teal(current)}).`);
        return;
      }

      info(`Update available: ${dim(current)} → ${teal(latest)}`);
      if (opts.check) {
        info(`Run ${teal('somewhere update')} to install it.`);
        return;
      }

      info(`Updating ${PACKAGE} …`);
      try {
        // stdio inherited so npm's own progress shows; -g may need elevated perms,
        // in which case npm's EACCES message is surfaced and we point at the manual fix.
        execSync(`npm install -g ${PACKAGE}@latest`, { stdio: 'inherit' });
      } catch {
        error(`Update failed. Try it manually:  npm install -g ${PACKAGE}@latest`);
        process.exit(1);
      }
      success(`Updated to ${latest}. Run ${teal('somewhere --version')} to confirm.`);
    });
}
