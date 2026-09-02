import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed CLI's own version, read once from its package.json. Sent to
 *  the platform at `somewhere login` so the approval page can show which CLI
 *  build is asking for access (tsk_d560943d). */
function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const CLI_VERSION: string = readVersion();
