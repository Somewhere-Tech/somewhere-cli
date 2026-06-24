import { spawn } from 'node:child_process';

export default function open(url: string): Promise<void> {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];

  return new Promise((resolve, reject) => {
    try {
      const child = spawn(command, args, {
        stdio: 'ignore',
        detached: true,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
