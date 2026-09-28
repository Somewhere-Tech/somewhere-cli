import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliConfigDir } from './config.js';

/** Bearer screenshot URLs belong in private CLI state, never deployable source. */
export function saveVerifyReport(report: unknown): string {
  const root = join(cliConfigDir(), 'verify-reports');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const directory = mkdtempSync(join(root, 'run-'));
  chmodSync(directory, 0o700);
  const pending = join(directory, 'report.pending');
  const destination = join(directory, 'report.json');
  writeFileSync(pending, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(pending, destination);
  return destination;
}
