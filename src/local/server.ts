/**
 * Local HTTP server for `somewhere dev --local` — bridges Node's http server
 * to the fetch-shaped dispatch in runtime.ts, with chokidar hot reload.
 * Functions only: static files are the deploy/preview pipeline's job.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { relative } from 'node:path';
import chokidar from 'chokidar';
import { IGNORE } from '../lib/files.js';
import { bold, dim, green, red, teal, warn, yellow } from '../lib/output.js';
import { bumpGeneration } from './loader.js';
import { dispatchRequest, refreshRoutes, type LocalProjectState } from './runtime.js';

const RELOAD_EXTS = /\.(ts|tsx|mts|js|mjs|jsx|json)$/i;

async function toFetchRequest(req: IncomingMessage, port: number): Promise<Request> {
  const url = `http://localhost:${port}${req.url ?? '/'}`;
  const method = (req.method ?? 'GET').toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, v);
  }
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method, headers, body });
}

async function writeNodeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of response.headers.entries()) {
    if (k.toLowerCase() === 'set-cookie') continue;
    headers[k] = v;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (response.body) {
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
  } else {
    res.end();
  }
}

function statusColor(status: number): (s: string) => string {
  if (status >= 500) return red;
  if (status >= 400) return yellow;
  return green;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

export interface LocalServerOptions {
  port: number;
  /**
   * Optional re-typecheck run after each hot reload. The runtime strips types,
   * so without this a save that drops an import reloads "clean" and only 500s
   * on the next request. Wired by `dev --local` when a tsconfig is present.
   */
  onReloadTypecheck?: () => void | Promise<void>;
}

export function startLocalServer(state: LocalProjectState, opts: LocalServerOptions): void {
  const { port } = opts;

  const server = createServer((req, res) => {
    void (async () => {
      const t0 = Date.now();
      let request: Request;
      try {
        request = await toFetchRequest(req, port);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'BAD_REQUEST', message: String(err) }));
        return;
      }
      const result = await dispatchRequest(request, state);
      const ms = Date.now() - t0;
      const color = statusColor(result.response.status);
      console.log(
        `${dim(stamp())} ${request.method} ${new URL(request.url).pathname} ${color(String(result.response.status))} ${dim(`${ms}ms`)}${result.route ? dim(` → ${result.route}`) : ''}`,
      );
      if (result.error) {
        const err = result.error;
        console.error(red(err instanceof Error ? err.stack ?? err.message : String(err)));
      }
      await writeNodeResponse(result.response, res);
    })().catch((err) => {
      console.error(red(`Internal local-server error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ ok: false, error: 'LOCAL_SERVER_ERROR', message: 'See terminal.' }));
    });
  });

  server.listen(port, () => {
    console.log('');
    console.log(`${green('▲')} ${bold('Local function runtime')} ${dim('— functions run here, sw.* talks to the real project')}`);
    console.log(`${teal('🌐')} ${bold('Listening:')} ${teal(`http://localhost:${port}`)}`);
    for (const r of state.routes) {
      console.log(`   ${dim('•')} ${r.displayPath} ${dim(`(${r.file})`)}`);
    }
    if (state.missingEnvKeys.length) {
      warn(
        `Platform env keys with no local value (access will throw): ${state.missingEnvKeys.join(', ')}. ` +
          'Add them to .env in this directory to use them locally.',
      );
    }
    console.log(dim('   save a file to hot-reload. Ctrl-C to stop.\n'));
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(red(`Port ${port} is already in use — pass --port <n> to pick another.`));
      process.exit(1);
    }
    throw err;
  });

  // Hot reload: any source change bumps the module generation; add/remove
  // also recompiles the route table.
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleReload = (rel: string, structural: boolean) => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      bumpGeneration();
      if (structural) {
        try {
          refreshRoutes(state);
        } catch (err) {
          console.error(red(`Route compile failed: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
      }
      console.log(`${dim(stamp())} ${teal(rel)} ${dim('reloaded')}`);
      if (opts.onReloadTypecheck) {
        void Promise.resolve(opts.onReloadTypecheck()).catch((err) => {
          console.error(red(`Typecheck failed to run: ${err instanceof Error ? err.message : String(err)}`));
        });
      }
    }, 150);
  };

  const watcher = chokidar.watch(state.cwd, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = relative(state.cwd, p);
      if (!rel || rel.startsWith('..')) return false;
      return rel
        .split(/[\\/]/)
        .some((seg) => IGNORE.has(seg) || (seg.startsWith('.') && seg !== '.' && seg !== ''));
    },
  });

  watcher.on('change', (abs: string) => {
    const rel = relative(state.cwd, abs);
    if (RELOAD_EXTS.test(rel)) scheduleReload(rel, false);
  });
  watcher.on('add', (abs: string) => {
    const rel = relative(state.cwd, abs);
    if (RELOAD_EXTS.test(rel)) scheduleReload(rel, true);
  });
  watcher.on('unlink', (abs: string) => {
    const rel = relative(state.cwd, abs);
    if (RELOAD_EXTS.test(rel)) scheduleReload(rel, true);
  });

  process.on('SIGINT', () => {
    console.log(`\n${dim('Stopped.')}`);
    watcher.close().finally(() => process.exit(0));
  });
}
