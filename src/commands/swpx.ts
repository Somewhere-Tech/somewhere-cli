/** `somewhere npx`, `somewhere npm`, and `somewhere check` — the verdict layer
 *  surfaced as subcommands of the main CLI (the same logic ships as the
 *  standalone `swpx` / `swpm` bins). npx/npm are pass-through wrappers, so they
 *  declare a variadic arg and let unknown flags flow to the target tool
 *  (passThroughOptions, enabled by program.enablePositionalOptions() in
 *  index.ts). Each action exits with the gate's own code. */

import { Command } from 'commander';
import { runSwpx } from '../swpx/run-swpx.js';
import { runSwpm } from '../swpx/run-swpm.js';
import { runCheck } from '../swpx/check.js';

export function registerSwpx(program: Command) {
  program
    .command('npx [args...]')
    .description(
      'Run a package with npx after a verdict check (swpx). Verified passes ' +
        'through; flagged stops with evidence; confirmed malware is blocked; if ' +
        'the verdict service is down, falls back to plain npx.',
    )
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (args: string[] = []) => {
      const { exitCode } = await runSwpx(args);
      process.exit(exitCode);
    });

  program
    .command('npm [args...]')
    .description(
      'Run npm with an install-time verdict check (swpm). install/add/ci are ' +
        'gated — confirmed malware halts the install; other npm commands pass ' +
        'straight through.',
    )
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (args: string[] = []) => {
      const { exitCode } = await runSwpm(args);
      process.exit(exitCode);
    });

  program
    .command('check [package]')
    .description(
      'Check an npm package against the verdict database without running or ' +
        'installing it. Exit code: 0 verified, 1 unverified, 2 blocked, 3 unknown.',
    )
    .option('--json', 'Print the raw verdict object (for agents / CI)')
    .action(async (pkg: string | undefined, opts: { json?: boolean }) => {
      const code = await runCheck(pkg, { json: opts.json === true });
      process.exit(code);
    });
}
