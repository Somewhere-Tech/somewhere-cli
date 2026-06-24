/** Entry for the standalone `swpx` binary (and `somewhere npx`).
 *
 *  `swpx check <pkg> [--json]` inspects without running; anything else is a
 *  package to run through the verdict gate. No commander here — a wrapper must
 *  pass the user's flags through to the target package untouched, so we read
 *  raw argv. `main` is side-effect-free (deps injectable) so it's unit-tested;
 *  bin/swpx.js does the process.exit. */

import { runSwpx } from './swpx/run-swpx.js';
import { runCheck } from './swpx/check.js';
import type { RunDeps } from './swpx/run-common.js';

export async function main(argv: string[], deps: RunDeps = {}): Promise<number> {
  if (argv[0] === 'check') {
    const rest = argv.slice(1);
    const json = rest.includes('--json');
    const pkg = rest.find((a) => !a.startsWith('-'));
    return runCheck(pkg, { json }, deps);
  }
  const { exitCode } = await runSwpx(argv, deps);
  return exitCode;
}
