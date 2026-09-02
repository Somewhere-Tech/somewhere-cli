/**
 * The `somewhere dev` loop: save a file, see it in the browser.
 *
 * Every request is answered in this order, and the order is the point:
 *
 *   1. A function route (api/…, a root catch-all) → the local function
 *      runtime, with sw.* bound to the real project. Functions always win.
 *   2. `/_compiled/<chunk>` → the compiled bundle, held in memory.
 *   3. index.html → the project's own HTML with its entry <script> rewritten
 *      to the compiled bundle, exactly as the deploy pipeline rewrites it.
 *   4. Anything else on disk → served raw.
 *   5. An extensionless path → index.html, so client-side routes work.
 *
 * Live reload is a tiny inline script the served HTML carries, listening on
 * an SSE endpoint. A rebuild pushes one event and the page reloads. It is
 * injected into the response, never written to the developer's file.
 *
 * A failed compile does NOT take the page down. The last good bundle keeps
 * serving and the error arrives as an overlay on top of it, with the file and
 * line — so a typo mid-edit leaves the running app on screen instead of a
 * blank page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { extname, join, relative, resolve, sep } from 'node:path';
import chokidar from 'chokidar';
import { IGNORE, collectFiles } from '../lib/files.js';
import { bold, dim, green, red, teal, warn, yellow } from '../lib/output.js';
import { bumpGeneration } from './loader.js';
import { dispatchRequest, refreshRoutes, type LocalProjectState } from './runtime.js';
import { CompileFailure, LocalCompiler, resolveDevEntry, type CompileOutput } from './compiler.js';
import { serveLoopback } from './loopback.js';

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

const RELOAD_PATH = '/__somewhere_dev_reload';

/** Files whose change triggers a rebuild of the frontend bundle. */
const SOURCE_EXTS = /\.(tsx?|jsx?|mts|cts|mjs|cjs|css|scss|sass|less|html|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;
/** Files whose change also invalidates the loaded function modules. */
const FUNCTION_EXTS = /\.(ts|tsx|mts|js|mjs|jsx|json)$/i;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

function statusColor(status: number): (s: string) => string {
  if (status >= 500) return red;
  if (status >= 400) return yellow;
  return green;
}

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

function safeStat(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function resolveWithinCwd(cwd: string, rel: string): string | null {
  const root = resolve(cwd);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** Never serve `.env`, `.git`, `.somewhere.json`, node_modules, … off disk. */
function isBlockedPath(rel: string): boolean {
  return rel
    .split('/')
    .some((seg) => seg === '..' || IGNORE.has(seg) || (seg !== '' && seg.startsWith('.')));
}

// ─── Live reload + error overlay, injected into the served HTML ─────────────

const CLIENT_SCRIPT = `
<script>(function(){
  var es = new EventSource(${JSON.stringify(RELOAD_PATH)});
  var box = null;
  function overlay(err){
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(11,13,16,.94);'
        + 'color:#e6e6e6;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:32px;overflow:auto;'
        + '-webkit-font-smoothing:antialiased';
      document.body.appendChild(box);
    }
    var rows = (err.locations||[]).map(function(l){
      var where = l.file + (l.line ? ':' + l.line + (l.column ? ':' + l.column : '') : '');
      return '<div style="margin:14px 0"><div style="color:#7fd1ff">' + esc(where) + '</div>'
        + '<div style="color:#ffb4a2;white-space:pre-wrap">' + esc(l.text) + '</div>'
        + (l.hint ? '<div style="color:#8b949e;white-space:pre-wrap;margin-top:4px">' + esc(l.hint) + '</div>' : '')
        + '</div>';
    }).join('');
    box.innerHTML = '<div style="color:#ff6b6b;font-weight:600;letter-spacing:.02em">COMPILE FAILED</div>'
      + (rows || '<div style="margin:14px 0;white-space:pre-wrap">' + esc(err.message) + '</div>')
      + '<div style="margin-top:24px;color:#8b949e">The last working page is still underneath. '
      + 'Fix and save — this clears itself.</div>';
    box.style.display = 'block';
  }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }
  es.onmessage = function(e){
    var msg = JSON.parse(e.data);
    if (msg.type === 'reload') location.reload();
    else if (msg.type === 'error') overlay(msg.error);
    else if (msg.type === 'ok' && box) { box.style.display = 'none'; box.innerHTML = ''; }
  };
})();</script>`;

function injectClient(html: string): string {
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${CLIENT_SCRIPT}\n</body>`);
  return html + CLIENT_SCRIPT;
}

// ─── Terminal rendering of a compile failure ────────────────────────────────

function printCompileFailure(failure: CompileFailure, cwd: string): void {
  console.log(red('  compile failed'));
  if (!failure.locations.length) {
    console.log(`    ${failure.message}`);
    return;
  }
  for (const loc of failure.locations) {
    const where = loc.line ? `${loc.file}:${loc.line}${loc.column ? `:${loc.column}` : ''}` : loc.file;
    console.log(`    ${teal(where)} ${loc.text}`);
    if (loc.line) {
      const abs = resolveWithinCwd(cwd, loc.file);
      const line = abs && safeStat(abs)?.isFile()
        ? readFileSync(abs, 'utf8').split('\n')[loc.line - 1]
        : undefined;
      if (line !== undefined) {
        console.log(dim(`      ${String(loc.line).padStart(4)} │ ${line}`));
        if (loc.column) console.log(dim(`           │ ${' '.repeat(Math.max(0, loc.column - 1))}^`));
      }
    }
    if (loc.hint) console.log(`      ${loc.hint}`);
  }
  console.log(dim('    the last working page is still up — fix and save again'));
}

// ─── The server ─────────────────────────────────────────────────────────────

export interface DevServerOptions {
  port: number;
  cwd: string;
  compiler: LocalCompiler;
  /** null when the project has no functions — static-only projects are fine. */
  state: LocalProjectState | null;
  /** Called after each rebuild with the measured save-to-served latency. */
  onRebuild?: (ms: number) => void;
  /** Set once the server is listening. */
  onListening?: (url: string) => void;
}

interface BuildState {
  output: CompileOutput | null;
  failure: CompileFailure | null;
}

export async function startDevServer(opts: DevServerOptions): Promise<void> {
  const { port, cwd, compiler, state } = opts;
  const build: BuildState = { output: null, failure: null };
  const clients = new Set<ServerResponse>();

  function broadcast(payload: unknown): void {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  }

  /**
   * Compile the project as it is on disk right now.
   *
   * `changedAt` is when the file write landed, so the printed number is the
   * developer's actual save-to-served latency and not just compiler time.
   */
  async function rebuild(changedAt: number, label: string): Promise<void> {
    const sources = collectFiles(cwd);
    // Nothing for the compiler to touch: index.html either points at a plain
    // .js/.mjs/.cjs module or carries no module script at all. The deploy
    // pipeline serves those files exactly as written (bundleProject returns
    // null and no rewrite happens), so the loop does the same — refusing to
    // start was the whole of pfb_e32a4e630c45.
    const entry = resolveDevEntry(sources.files);
    if (entry.kind !== 'compiled') {
      build.output = null;
      build.failure = null;
      console.log(`${dim(stamp())} ${teal(label)} ${green('✓')} ${dim('served as written — no compile needed')}`);
      opts.onRebuild?.(Date.now() - changedAt);
      broadcast({ type: 'reload' });
      return;
    }
    try {
      const output = await compiler.compile({ files: sources.files, binaryFiles: sources.binaryFiles });
      build.output = output;
      build.failure = null;
      const ms = Date.now() - changedAt;
      console.log(`${dim(stamp())} ${teal(label)} ${green('✓')} ${dim(`${ms}ms`)}`);
      for (const w of output.warnings) warn(`  ${w}`);
      opts.onRebuild?.(ms);
      broadcast({ type: 'reload' });
    } catch (err) {
      const failure = err instanceof CompileFailure
        ? err
        : new CompileFailure(err instanceof Error ? err.message : String(err), []);
      build.failure = failure;
      console.log(`${dim(stamp())} ${teal(label)} ${red('✗')} ${dim(`${Date.now() - changedAt}ms`)}`);
      printCompileFailure(failure, cwd);
      broadcast({
        type: 'error',
        error: { message: failure.message, locations: failure.locations },
      });
    }
  }

  // First build before the port opens, so the first request never races it.
  await rebuild(Date.now(), 'initial build');

  function serveCompiled(pathname: string, method: string): Response | null {
    const name = pathname.slice('/_compiled/'.length);
    const text = build.output?.chunks[name];
    if (text === undefined) return null;
    return new Response(method === 'HEAD' ? null : text, {
      status: 200,
      headers: {
        'Content-Type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  function htmlResponse(html: string, method: string): Response {
    const body = injectClient(html);
    return new Response(method === 'HEAD' ? null : body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  function fileResponse(abs: string, method: string): Response {
    const buf = readFileSync(abs);
    const type = STATIC_MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    return new Response(method === 'HEAD' ? null : buf, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(buf.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  }

  /** The app's HTML: the compiled rewrite when we have one, the raw file when we don't. */
  function appHtml(method: string): Response | null {
    if (build.output?.html) return htmlResponse(build.output.html, method);
    const abs = resolveWithinCwd(cwd, 'index.html');
    if (abs && safeStat(abs)?.isFile()) return htmlResponse(readFileSync(abs, 'utf8'), method);
    return null;
  }

  function serveFrontend(request: Request): { response: Response; label: string } | null {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return null;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return null;
    }

    if (pathname.startsWith('/_compiled/')) {
      const compiled = serveCompiled(pathname, method);
      return compiled ? { response: compiled, label: `compiled:${pathname.slice(11)}` } : null;
    }

    const rel = pathname.replace(/^\/+/, '');
    if (rel === '' || rel === 'index.html') {
      const html = appHtml(method);
      return html ? { response: html, label: 'index.html' } : null;
    }

    if (!isBlockedPath(rel)) {
      const abs = resolveWithinCwd(cwd, rel);
      if (abs) {
        const st = safeStat(abs);
        if (st?.isFile()) return { response: fileResponse(abs, method), label: `static:${rel}` };
        if (st?.isDirectory()) {
          const idx = resolveWithinCwd(cwd, join(rel, 'index.html'));
          if (idx && safeStat(idx)?.isFile()) {
            return { response: htmlResponse(readFileSync(idx, 'utf8'), method), label: `static:${rel}/index.html` };
          }
        }
      }
    }

    // Client-side route → the app shell.
    if (extname(pathname) === '') {
      const html = appHtml(method);
      if (html) return { response: html, label: 'index.html (spa)' };
    }
    return null;
  }

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // The reload channel is a long-lived stream, not a request/response.
      if ((req.url ?? '').split('?')[0] === RELOAD_PATH) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        // A page that connects while the build is broken gets the overlay
        // immediately rather than after the next save.
        if (build.failure) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: { message: build.failure.message, locations: build.failure.locations } })}\n\n`);
        }
        req.on('close', () => clients.delete(res));
        return;
      }

      const t0 = Date.now();
      let request: Request;
      try {
        request = await toFetchRequest(req, port);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'BAD_REQUEST', message: String(err) }));
        return;
      }

      let route: string | null = null;
      let response: Response | null = null;
      let handlerError: unknown;
      if (state) {
        const dispatched = await dispatchRequest(request, state);
        if (dispatched.route) {
          response = dispatched.response;
          route = dispatched.route;
          handlerError = dispatched.error;
        }
      }
      if (!response) {
        const served = serveFrontend(request);
        if (served) {
          response = served.response;
          route = served.label;
        }
      }
      if (!response) {
        response = new Response(JSON.stringify({ ok: false, error: 'NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const ms = Date.now() - t0;
      const color = statusColor(response.status);
      console.log(
        `${dim(stamp())} ${request.method} ${new URL(request.url).pathname} ${color(String(response.status))} ${dim(`${ms}ms`)}${route ? dim(` → ${route}`) : ''}`,
      );
      // A function that threw prints its REAL stack here — this is your own
      // terminal, and a stack you cannot see is a bug you cannot fix.
      if (handlerError) {
        const e = handlerError;
        console.error(red(e instanceof Error ? e.stack ?? e.message : String(e)));
      }
      await writeNodeResponse(response, res);
    })().catch((err) => {
      console.error(red(`Internal dev-server error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'DEV_SERVER_ERROR', message: 'See terminal.' }));
    });
  };

  const { servers } = await serveLoopback(handleRequest, port, (p) => {
    console.error(red(`Port ${p} is already in use — pass --port <n> to pick another.`));
    process.exit(1);
  });

  const url = `http://localhost:${port}`;
  console.log('');
  console.log(`${green('▲')} ${bold('somewhere dev')} ${dim('— your app, compiled by the platform, on your machine')}`);
  console.log(`${teal('🌐')} ${bold('Local:')} ${teal(url)}`);
  if (build.output) {
    console.log(dim(`   ${build.output.entry} → /_compiled/${build.output.entryChunk}`));
  } else {
    // Say which file is the app even when nothing was compiled, so a plain
    // JavaScript project gets the same "here is your entry" line a TSX one does.
    const rawEntry = resolveDevEntry(collectFiles(cwd).files);
    if (rawEntry.kind === 'raw' && rawEntry.entry) {
      console.log(dim(`   ${rawEntry.entry} → served as written (the platform serves plain JavaScript modules untouched)`));
    }
  }
  if (state) {
    for (const r of state.routes) console.log(`   ${dim('•')} ${r.displayPath} ${dim(`(${r.file})`)}`);
    if (state.missingEnvKeys.length) {
      warn(
        `Platform env keys with no local value (access will throw): ${state.missingEnvKeys.join(', ')}. ` +
          'Add them to .env in this directory to use them locally.',
      );
    }
  }
  console.log(dim('   same app, same data, same build. Save a file. Ctrl-C to stop.\n'));
  opts.onListening?.(url);

  // ─── Watch ────────────────────────────────────────────────────────────────
  //
  // One debounce window for both jobs: a save that touches a function AND a
  // component rebuilds the bundle and reloads the function modules once.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pendingLabel = '';
  let pendingSince = 0;
  let pendingStructural = false;
  let pendingFunctions = false;

  const flush = async (): Promise<void> => {
    if (running) {
      timer = setTimeout(() => void flush(), 40);
      return;
    }
    const label = pendingLabel;
    const since = pendingSince;
    const structural = pendingStructural;
    const functions = pendingFunctions;
    pendingLabel = '';
    pendingSince = 0;
    pendingStructural = false;
    pendingFunctions = false;
    if (!label) return;
    running = true;
    try {
      if (functions) {
        bumpGeneration();
        if (structural && state) {
          try {
            refreshRoutes(state);
          } catch (err) {
            console.error(red(`Route compile failed: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
      }
      await rebuild(since, label);
    } finally {
      running = false;
    }
  };

  const note = (rel: string, structural: boolean): void => {
    if (!SOURCE_EXTS.test(rel)) return;
    if (!pendingSince) pendingSince = Date.now();
    pendingLabel = pendingLabel && pendingLabel !== rel ? `${rel} (+more)` : rel;
    pendingStructural ||= structural;
    pendingFunctions ||= FUNCTION_EXTS.test(rel);
    if (timer) clearTimeout(timer);
    // Short window: long enough to coalesce an editor's write burst, short
    // enough that it is not the thing the developer is waiting on.
    timer = setTimeout(() => void flush(), 30);
  };

  const watcher = chokidar.watch(cwd, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = relative(cwd, p);
      if (!rel || rel.startsWith('..')) return false;
      return rel
        .split(/[\\/]/)
        .some((seg) => IGNORE.has(seg) || (seg.startsWith('.') && seg !== '.' && seg !== ''));
    },
  });
  watcher.on('change', (abs: string) => note(relative(cwd, abs), false));
  watcher.on('add', (abs: string) => note(relative(cwd, abs), true));
  watcher.on('unlink', (abs: string) => note(relative(cwd, abs), true));

  process.on('SIGINT', () => {
    console.log(`\n${dim('Stopped.')}`);
    for (const s of servers) s.close();
    watcher.close().finally(() => process.exit(0));
  });
}
