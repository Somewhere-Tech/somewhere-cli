import { spawn } from 'node:child_process';

export interface InitInstallOptions {
  cwd: string;
  quiet: boolean;
}

export type InitInstallRunner = (options: InitInstallOptions) => Promise<number>;

/** Install the generated starter with the system npm executable. */
export function runInitInstall({ cwd, quiet }: InitInstallOptions): Promise<number> {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, ['install', '--no-audit', '--no-fund'], {
      cwd,
      shell: false,
      stdio: quiet ? 'ignore' : 'inherit',
    });
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
        'Run `npm install` in this directory, then try again.',
    );
  }
}
