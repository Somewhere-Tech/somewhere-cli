/** Fail-open policy for swpx / swpm.
 *
 *  Default is fail-OPEN (the verdict service being down must never break a
 *  build) — but never SILENTLY: when we can't verify, we print a loud warning so
 *  the developer always knows the check didn't run (a blocked check can be an
 *  attacker hiding malware, not just an outage). `enforce` flips it to
 *  fail-CLOSED for CI / security-conscious users. Precedence:
 *    --enforce / --no-enforce  >  SWPX_ENFORCE env  >  config.enforce  >  false */

import { loadConfig } from '../lib/config.js';
import { red, yellow, dim } from '../lib/output.js';

const OWN_FLAGS = new Set(['--enforce', '--no-enforce']);

/** Strip our own flags so they're never forwarded to npx/npm. */
export function stripEnforceFlags(args: string[]): string[] {
  return args.filter((a) => !OWN_FLAGS.has(a));
}

export function resolveEnforce(args: string[]): boolean {
  if (args.includes('--no-enforce')) return false;
  if (args.includes('--enforce')) return true;
  const env = process.env.SWPX_ENFORCE;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  try {
    return loadConfig()?.enforce === true;
  } catch {
    return false;
  }
}

/** The LOUD "couldn't verify" block — printed to stderr, never silent. */
export function loudUnavailable(emit: (s: string) => void, pkg: string, rateLimited: boolean): void {
  emit('');
  if (rateLimited) {
    emit(`${yellow('⚠')} Rate limited checking ${pkg} — the verdict service is throttling.`);
    emit(`  ${dim('Wait a moment and retry.')}`);
  } else {
    emit(`${red('⚠')}  COULD NOT VERIFY ${pkg} — the verdict service was unreachable.`);
    emit(`   ${dim('Running UNCHECKED (like plain npx/npm). Usually an outage — but a blocked')}`);
    emit(`   ${dim("check can also be malware hiding. If you didn't expect this, stop and retry.")}`);
  }
  emit('');
}

/** Message when refusing to proceed under enforce (fail-closed). */
export function refused(emit: (s: string) => void, pkg: string, tool: 'npx' | 'npm'): void {
  emit(`${red('✖')} Refusing: could not verify ${pkg} and enforce is on.`);
  emit(`  ${dim(`Run real \`${tool}\` yourself to override, or set --no-enforce.`)}`);
}
