import { createReadStream, createWriteStream } from 'node:fs';
import { stat, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Command } from 'commander';
import type { Response as UndiciResponse } from 'undici';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { error, printJson, success, table } from '../lib/output.js';

interface FsCommandOptions {
  project?: string;
  json?: boolean;
  contentType?: string;
}

interface FsEntry {
  path: string;
  name: string;
  type: string;
  size_bytes: number;
  content_type: string | null;
  version: number;
  updated_at: string;
}

interface FsListResult {
  path: string;
  type: 'directory';
  entries: FsEntry[];
  next_cursor: string | null;
}

interface FsWriteResult {
  path: string;
  size_bytes: number;
  content_type: string;
  version: number;
}

interface FsDeleteResult {
  deleted: number;
  type: string;
  path: string;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export function registerFs(program: Command): void {
  const fs = program.command('fs').description('Manage project file storage');

  fs.command('put <local> <remote>')
    .description('Stream a local file into project storage')
    .option('--project <slug>', 'Project slug or ID (defaults to the linked project)')
    .option('--content-type <type>', 'Stored content type (inferred from the local filename by default)')
    .option('--json', 'Print the raw file response as JSON')
    .action(async (local: string, remote: string, opts: FsCommandOptions) => {
      try {
        if (remote.endsWith('/')) {
          throw new CliApiError(
            'INVALID_REMOTE_PATH',
            'Upload destination must name a file and cannot end with `/`.',
            0,
          );
        }
        const source = resolve(local);
        const file = await stat(source);
        if (!file.isFile()) throw new Error(`${local} is not a file.`);
        const project = resolveProject(opts.project);
        const client = new ApiClient(getToken());
        const result = await readEnvelope<FsWriteResult>(await client.callStream(
          'PUT',
          fsPath(project, remote),
          () => createReadStream(source),
          {
            replayableBody: true,
            timeoutMs: LONG_CALL_TIMEOUT_MS,
            headers: {
              'Content-Type': opts.contentType ?? contentTypeFor(source),
              'Content-Length': String(file.size),
            },
          },
        ));
        if (opts.json) printJson(result);
        else success(`Uploaded ${local} → ${result.path} (${result.size_bytes} bytes)`);
      } catch (err) {
        fail(err, opts.json);
      }
    });

  fs.command('get <remote> <local>')
    .description('Stream a stored file to disk')
    .option('--project <slug>', 'Project slug or ID (defaults to the linked project)')
    .option('--json', 'Print download metadata as JSON')
    .action(async (remote: string, local: string, opts: FsCommandOptions) => {
      let tempPath: string | undefined;
      try {
        const project = resolveProject(opts.project);
        const client = new ApiClient(getToken());
        const response = await client.callStream('GET', fsPath(project, remote), undefined, {
          timeoutMs: LONG_CALL_TIMEOUT_MS,
        });
        if (!response.ok) await readEnvelope(response);
        if (!response.body) throw new Error('The server returned an empty file response.');

        const destination = resolve(local);
        tempPath = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
        await pipeline(response.body, createWriteStream(tempPath, { flags: 'wx' }));
        await rename(tempPath, destination);
        tempPath = undefined;

        const size = Number(response.headers.get('content-length'));
        const result = {
          remote,
          local: destination,
          size_bytes: Number.isFinite(size) ? size : null,
          content_type: response.headers.get('content-type'),
        };
        if (opts.json) printJson(result);
        else success(`Downloaded ${remote} → ${local}`);
      } catch (err) {
        if (tempPath) await unlink(tempPath).catch(() => {});
        fail(err, opts.json);
      }
    });

  fs.command('ls <remote>')
    .description('List a directory in project storage')
    .option('--project <slug>', 'Project slug or ID (defaults to the linked project)')
    .option('--json', 'Print the raw directory response as JSON')
    .action(async (remote: string, opts: FsCommandOptions) => {
      try {
        const project = resolveProject(opts.project);
        const client = new ApiClient(getToken());
        const response = await client.callStream('GET', fsPath(project, remote), undefined, {
          timeoutMs: LONG_CALL_TIMEOUT_MS,
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (response.ok && (
          response.headers.has('x-somewhere-fs-version') ||
          !contentType.toLowerCase().includes('application/json')
        )) {
          await response.body?.cancel().catch(() => {});
          throw new CliApiError('NOT_A_DIRECTORY', `${remote} is not a directory.`, 400);
        }
        const result = await readEnvelope<FsListResult>(response);
        if (result.type !== 'directory' || !Array.isArray(result.entries)) {
          throw new Error(`${remote} is not a directory.`);
        }
        if (opts.json) {
          printJson(result);
          return;
        }
        if (result.entries.length === 0) {
          console.log('No files.');
          return;
        }
        table(
          ['Type', 'Size', 'Path'],
          result.entries.map((entry) => [
            entry.type,
            entry.type === 'file' ? String(entry.size_bytes) : '-',
            entry.path,
          ]),
        );
      } catch (err) {
        fail(err, opts.json);
      }
    });

  fs.command('rm <remote>')
    .description('Remove a file or directory from project storage')
    .option('--project <slug>', 'Project slug or ID (defaults to the linked project)')
    .option('--json', 'Print the raw delete response as JSON')
    .action(async (remote: string, opts: FsCommandOptions) => {
      try {
        const project = resolveProject(opts.project);
        const client = new ApiClient(getToken());
        const result = await readEnvelope<FsDeleteResult>(
          await client.callStream('DELETE', fsPath(project, remote), undefined, {
            timeoutMs: LONG_CALL_TIMEOUT_MS,
          }),
        );
        if (opts.json) printJson(result);
        else success(`Removed ${result.path}`);
      } catch (err) {
        fail(err, opts.json);
      }
    });
}

function resolveProject(explicit?: string): string {
  if (explicit) return explicit;
  const linked = loadProjectConfig();
  if (!linked) {
    throw new CliApiError(
      'NO_PROJECT',
      'No project linked. Run `somewhere init` or pass --project <slug>.',
      0,
    );
  }
  return linked.project_id;
}

function fsPath(project: string, remote: string): string {
  const path = remote.replace(/^\/+/, '');
  if (!path) {
    throw new CliApiError('INVALID_REMOTE_PATH', 'Remote path is required.', 0);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new CliApiError(
      'INVALID_REMOTE_PATH',
      'Remote path cannot contain `.` or `..` segments.',
      0,
    );
  }
  const encoded = segments.map(encodeURIComponent).join('/');
  return `/fs/${encodeURIComponent(project)}/${encoded}`;
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.json': return 'application/json';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

async function readEnvelope<T>(response: UndiciResponse): Promise<T> {
  let payload: ApiEnvelope<T>;
  try {
    payload = await response.json() as ApiEnvelope<T>;
  } catch {
    throw new CliApiError(
      'INVALID_RESPONSE',
      `Non-JSON response from file API (HTTP ${response.status}).`,
      response.status,
    );
  }
  if (response.ok && payload.ok === true && payload.data !== undefined) return payload.data;
  throw new CliApiError(
    payload.error ?? 'UNKNOWN',
    payload.message ?? `File API request failed (HTTP ${response.status}).`,
    response.status,
  );
}

function fail(reason: unknown, json?: boolean): never {
  const err = reason instanceof CliApiError
    ? reason
    : new CliApiError('CLI_ERROR', reason instanceof Error ? reason.message : String(reason), 0);
  if (json) {
    printJson({ ok: false, error: err.code, message: err.message, status: err.statusCode });
  } else {
    error(err.message);
  }
  process.exit(1);
}
