import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliConfigDir } from './config.js';
import { normalizeLastRun, type LastRunRecord } from './advisor-context.js';

const TAIL_LIMIT = 4_000;

function appendTail(current: string, chunk: unknown): string {
  const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
  const combined = current + text;
  return combined.length <= TAIL_LIMIT ? combined : combined.slice(-TAIL_LIMIT);
}

/** Capture one invocation without changing command output or command failure behavior. */
export function recordLastRun(argv: string[]): void {
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    stdout = appendTail(stdout, chunk);
    return originalStdoutWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    stderr = appendTail(stderr, chunk);
    return originalStderrWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stderr.write;

  process.once('exit', (exitCode) => {
    try {
      const dir = cliConfigDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record: LastRunRecord = normalizeLastRun({
        command: argv[0] ?? 'somewhere',
        args: argv.slice(1),
        exit_code: exitCode ?? process.exitCode ?? 0,
        stdout_tail: stdout,
        stderr_tail: stderr,
        timestamp: new Date().toISOString(),
      });
      const path = join(dir, 'last-run.json');
      const temporary = join(dir, 'last-run.json.tmp');
      writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
      renameSync(temporary, path);
    } catch {
      // Local diagnostics must never cause a CLI command to fail.
    }
  });
}
