import { spawn } from 'node:child_process';

export interface InitInstallOptions {
  cwd: string;
  quiet: boolean;
}

export type InitInstallRunner = (options: InitInstallOptions) => Promise<number>;

/**
 * Run the same guarded install exposed as `somewhere npm install`. Re-entering
 * the current CLI keeps init on the swpm verdict path without assuming where a
 * globally or locally installed `somewhere` binary lives.
 */
export function runInitInstall({ cwd, quiet }: InitInstallOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        process.argv[1],
        'npm',
        'install',
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd,
        shell: false,
        stdio: quiet ? 'ignore' : 'inherit',
      },
    );
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

export async function installInitDependencies(
  options: InitInstallOptions,
  runner: InitInstallRunner = runInitInstall,
): Promise<void> {
  const exitCode = await runner(options);
  if (exitCode !== 0) {
    throw new Error(
      `Starter files were written, but dependency installation exited ${exitCode}. ` +
        'Run `somewhere npm install` in this directory, then try again.',
    );
  }
}
