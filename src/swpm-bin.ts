/** Entry for the standalone `swpm` binary (and `somewhere npm`).
 *
 *  Every arg goes to runSwpm, which gates install-family subcommands and passes
 *  everything else straight through to npm. `main` is side-effect-free (deps
 *  injectable) so it's unit-tested; bin/swpm.js does the process.exit. */

import { runSwpm } from './swpx/run-swpm.js';
import type { RunDeps } from './swpx/run-common.js';

export async function main(argv: string[], deps: RunDeps = {}): Promise<number> {
  const { exitCode } = await runSwpm(argv, deps);
  return exitCode;
}
