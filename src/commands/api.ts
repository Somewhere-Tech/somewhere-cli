import { Command } from 'commander';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import { error, printJson } from '../lib/output.js';

interface ApiCommandOptions {
  data?: string;
  dataFile?: string;
  contentType?: string;
  raw?: boolean;
  json?: boolean;
}

interface ApiEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export function registerApi(program: Command) {
  program
    .command('api <method> <path>')
    .description('Make a raw API call (adds auth automatically)')
    .option('-d, --data <json>', 'JSON body')
    .option('--data-file <path>', 'Stream the request body from a file; use - for stdin')
    .option('--content-type <type>', 'Content type for --data-file (defaults to JSON for .json/stdin, otherwise octet-stream)')
    .option('--raw', 'Print the response body as-is without JSON-parsing — for non-JSON endpoints (e.g. a SQL db dump); a 200 non-JSON body is not treated as an error')
    .option('--json', 'Print parsed JSON (the default; accepted for automation consistency)')
    .action(async (method: string, path: string, opts: ApiCommandOptions) => {
      if (opts.raw && opts.json) {
        error('--raw and --json cannot be used together.');
        process.exit(1);
      }
      if (opts.data !== undefined && opts.dataFile !== undefined) {
        error('--data and --data-file cannot be used together.');
        process.exit(1);
      }
      const client = new ApiClient(getToken());
      let body: unknown;
      if (opts.data) {
        try {
          body = JSON.parse(opts.data);
        } catch {
          error('--data must be valid JSON');
          process.exit(1);
        }
      }

      const apiPath = path.startsWith('/v1/') ? path.slice(3) : path;

      if (opts.dataFile !== undefined) {
        try {
          const stdin = opts.dataFile === '-';
          const source = stdin ? undefined : resolve(opts.dataFile);
          const file = source ? await stat(source) : undefined;
          if (file && !file.isFile()) throw new Error(`${opts.dataFile} is not a file.`);
          const headers: Record<string, string> = {
            'Content-Type': opts.contentType ?? dataFileContentType(opts.dataFile),
          };
          if (file) headers['Content-Length'] = String(file.size);
          const response = await client.callStream(
            method.toUpperCase(),
            apiPath,
            () => source ? createReadStream(source) : process.stdin,
            {
              headers,
              timeoutMs: LONG_CALL_TIMEOUT_MS,
              replayableBody: Boolean(source),
            },
          );

          if (opts.raw) {
            if (response.body) {
              for await (const chunk of response.body) process.stdout.write(chunk);
            }
            if (!response.ok) process.exitCode = 1;
            return;
          }

          let payload: ApiEnvelope;
          try {
            payload = await response.json() as ApiEnvelope;
          } catch {
            throw new CliApiError(
              'INVALID_RESPONSE',
              `Non-JSON response (${response.status}). Use --raw to print it.`,
              response.status,
            );
          }
          if (response.ok && payload.ok === true) {
            printJson(payload.data);
            return;
          }
          printJson({
            ok: false,
            error: payload.error ?? 'UNKNOWN',
            message: payload.message ?? 'Unknown error',
            status: response.status,
          });
          process.exit(1);
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }

      // Raw mode: stream the response body verbatim. A 200 with a non-JSON body
      // (e.g. /v1/db/dump returns SQL) must NOT be an error (audit #14).
      if (opts.raw) {
        try {
          const r = await client.callRaw(method.toUpperCase(), apiPath, body);
          process.stdout.write(r.body.endsWith('\n') ? r.body : r.body + '\n');
          if (!r.ok) process.exitCode = 1;
        } catch (err) {
          error(String(err));
          process.exit(1);
        }
        return;
      }

      try {
        const result = await client.call(method.toUpperCase(), apiPath, body);
        printJson(result);
      } catch (err) {
        if (err instanceof Error && 'code' in err) {
          const apiErr = err as Error & { code: string; statusCode: number };
          printJson({ ok: false, error: apiErr.code, message: apiErr.message, status: apiErr.statusCode });
        } else {
          error(String(err));
        }
        process.exit(1);
      }
    });
}

function dataFileContentType(path: string): string {
  if (path === '-' || extname(path).toLowerCase() === '.json') return 'application/json';
  return 'application/octet-stream';
}
