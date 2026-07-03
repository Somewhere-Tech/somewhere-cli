/**
 * Local HTTP server for `somewhere dev --local` — bridges Node's http server
 * to the fetch-shaped dispatch in runtime.ts, with chokidar hot reload.
 * Functions take precedence; requests that match no function route fall
 * through to static files served straight off disk (index.html + assets, with
 * an SPA fallback to index.html). Raw TSX/JSX is NOT compiled here — that's the
 * deploy pipeline's job (CLAUDE.md rule 11); see serveStaticFile below.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { extname, join, relative, resolve, sep } from 'node:path';
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

// ─── Static-file fallthrough ────────────────────────────────────────────────
//
// When the function router matches NO route, serve the project's frontend
// straight off disk: index.html + assets, with an SPA fallback to index.html
// for extensionless paths (client-side routes). This is what makes
// `http://localhost:<port>/` render the actual app while `/api/*` and any
// matched function keep precedence (static only runs after a null match).
//
// SCOPE: raw/plain files only. We do NOT compile TSX/JSX here — the platform
// compiles TSX on deploy (CLAUDE.md rule 11), and serving a raw `.tsx` with a
// JS MIME type would not execute in the browser. Compile-parity for
// `dev --local` (so an uncompiled `src/main.tsx` entry runs locally) is a
// deliberate follow-up; serving already-built/plain static files closes the
// "open localhost and see your app" gap on its own.

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

function safeStat(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** Resolve `rel` under `cwd`, returning null if it would escape the root. */
function resolveWithinCwd(cwd: string, rel: string): string | null {
  const root = resolve(cwd);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** True if any path segment is `..`, an IGNORE'd dir, or a dotfile/dotdir —
 *  never serve `.env`, `.git`, `.somewhere.json`, etc. off disk. */
function isBlockedPath(rel: string): boolean {
  return rel
    .split('/')
    .some((seg) => seg === '..' || IGNORE.has(seg) || (seg !== '' && seg.startsWith('.')));
}

function fileResponse(abs: string, method: string): Response {
  const buf = readFileSync(abs);
  const type = STATIC_MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Length': String(buf.byteLength),
    'Cache-Control': 'no-store', // local dev — always fresh
  };
  // HEAD: headers only, no body.
  return new Response(method === 'HEAD' ? null : buf, { status: 200, headers });
}

/**
 * Serve a static file for a request the function router did not match.
 * Returns the response + a log label, or null to fall through to the 404.
 * GET/HEAD only — other methods on an unmatched path stay a 404.
 */
function serveStaticFile(
  cwd: string,
  request: Request,
): { response: Response; label: string } | null {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return null;
  }
  const rel = pathname.replace(/^\/+/, '');

  // 1. Literal file on disk ("/" → index.html, "/dir/" → dir/index.html).
  const target = rel === '' ? 'index.html' : rel;
  if (!isBlockedPath(target)) {
    const abs = resolveWithinCwd(cwd, target);
    if (abs) {
      const st = safeStat(abs);
      if (st?.isFile()) {
        return { response: fileResponse(abs, method), label: `static:${relative(cwd, abs) || 'index.html'}` };
      }
      if (st?.isDirectory()) {
        const idx = resolveWithinCwd(cwd, join(target, 'index.html'));
        const idxStat = idx ? safeStat(idx) : null;
        if (idx && idxStat?.isFile()) {
          return { response: fileResponse(idx, method), label: `static:${relative(cwd, idx)}` };
        }
      }
    }
  }

  // 2. SPA fallback: extensionless paths (client routes like /about) → index.html.
  if (extname(pathname) === '') {
    const indexAbs = resolveWithinCwd(cwd, 'index.html');
    const st = indexAbs ? safeStat(indexAbs) : null;
    if (indexAbs && st?.isFile()) {
      return { response: fileResponse(indexAbs, method), label: 'static:index.html (spa)' };
    }
  }

  return null;
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
      let result = await dispatchRequest(request, state);
      // Static-file fallthrough: no function route matched → try to serve the
      // frontend (index.html + assets, SPA fallback) from disk. Functions keep
      // precedence — this only runs when dispatch returned no route.
      if (!result.route) {
        const served = serveStaticFile(state.cwd, request);
        if (served) result = { response: served.response, route: served.label };
      }
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

  // Bind loopback only: these functions run with the developer's real CLI token
  // (PROJECT_API_KEY) and hit the real project, so exposing them on the LAN would
  // let anyone on the network invoke sw.db/sw.email etc. as the developer. A
  // `--host` opt-in can be added later for the deliberate device-testing case.
  server.listen(port, '127.0.0.1', () => {
    console.log('');
    console.log(`${green('▲')} ${bold('Local function runtime')} ${dim('— functions run here, sw.* talks to the real project')}`);
    console.log(`${teal('🌐')} ${bold('Listening:')} ${teal(`http://localhost:${port}`)}`);
    for (const r of state.routes) {
      console.log(`   ${dim('•')} ${r.displayPath} ${dim(`(${r.file})`)}`);
    }
    console.log(
      dim(
        '   unmatched paths → static files from this folder (index.html + assets, SPA fallback). ' +
          'raw TSX is compiled on deploy, not locally.',
      ),
    );
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
