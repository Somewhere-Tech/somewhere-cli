import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import { error } from '../lib/output.js';

export function registerApi(program: Command) {
  program
    .command('api <method> <path>')
    .description('Make a raw API call (adds auth automatically)')
    .option('-d, --data <json>', 'JSON body')
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

      try {
        const apiPath = path.startsWith('/v1/') ? path.slice(3) : path;
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
