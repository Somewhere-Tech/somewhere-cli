/** Shell out to the REAL npx / npm. swpx/swpm are wrappers, never replacements:
 *  once a verdict says "go", the genuine tool runs with the user's exact args,
 *  inheriting stdio so its output is untouched (we keep our own messaging on
 *  stderr). The child's exit code becomes ours. A launch failure (tool not on
 *  PATH) resolves to 127 rather than throwing — the caller already printed the
 *  verdict; a missing npm is the user's environment, not a swpx error. */

import { spawn } from 'node:child_process';
import { dim } from '../lib/output.js';

export function runReal(cmd: 'npx' | 'npm', args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      // On Windows npx/npm are .cmd shims that need a shell; on POSIX we spawn
      // the binary directly (no shell → no quoting/injection surface).
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
      console.error(dim(`swpx: failed to launch ${cmd} — ${err.message}`));
      resolve(127);
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 0));
  });
}
