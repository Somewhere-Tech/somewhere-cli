import { Command } from 'commander';
import prompts from 'prompts';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { teal, warn } from '../lib/output.js';
import { linkExisting } from './init.js';

/**
 * `somewhere link` — a discoverable top-level alias for `somewhere init --link`.
 * Agents look for `link`; this registers it without forking any logic — it
 * reuses linkExisting (which fetches projects, prompts a pick, and writes
 * .somewhere.json via saveProjectConfig).
 */
export function registerLink(program: Command) {
  program
    .command('link')
    .description('Link this directory to an existing project (alias for `init --link`)')
    .action(async () => {
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

      await linkExisting(client, dir);
    });
}
