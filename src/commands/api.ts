import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import { error } from '../lib/output.js';

export function registerApi(program: Command) {
  program
    .command('api <method> <path>')
    .description('Make a raw API call (adds auth automatically)')
    .option('-d, --data <json>', 'JSON body')
    .option('--raw', 'Print the response body as-is without JSON-parsing — for non-JSON endpoints (e.g. a SQL db dump); a 200 non-JSON body is not treated as an error')
    .action(async (method: string, path: string, opts) => {
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
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof Error && 'code' in err) {
          const apiErr = err as Error & { code: string; statusCode: number };
          console.error(
            JSON.stringify(
              { error: apiErr.code, message: apiErr.message, status: apiErr.statusCode },
              null,
              2,
            ),
          );
        } else {
          error(String(err));
        }
        process.exit(1);
      }
    });
}
