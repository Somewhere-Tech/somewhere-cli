/**
 * A browser for the app on localhost.
 *
 * `somewhere browser` drives the platform's hosted browser, which lives on the
 * internet and therefore cannot reach a developer's loopback address — the two
 * halves of this CLI could not talk to each other, so the app `somewhere dev`
 * was serving was the one address its own browser tool refused to visit. Every
 * visual and DOM check had to wait until after the first production deploy.
 *
 * This is the loopback half: the browser already installed on the developer's
 * machine, driven directly over the DevTools protocol. No new dependency (the
 * socket comes from undici, which the CLI already bundles) and no download —
 * if there is no browser on the machine we say so plainly instead of fetching
 * one hundreds of megabytes at a time.
 *
 * The probe it runs is the PLATFORM's probe, vendored in
 * runtime/browser-probes.mjs, so the interactive-element map you get for
 * localhost is the same map the hosted browser reports for the deployed app.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { WebSocket } from 'undici';

/** Env vars that name a browser binary, in the order they win. */
export const BROWSER_PATH_ENV_VARS = [
  'SOMEWHERE_BROWSER_PATH',
  'CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
] as const;

/**
 * Where a Chrome-family browser normally lives, per platform. Ordered: a real
 * installed browser first, then the caches the common tooling downloads into.
 */
function candidatePaths(): string[] {
  const home = homedir();
  const out: string[] = [];
  if (process.platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    );
  } else if (process.platform === 'win32') {
    const programFiles = [
      process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
      process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'),
    ];
    for (const base of programFiles) {
      out.push(
        join(base, 'Google\\Chrome\\Application\\chrome.exe'),
        join(base, 'Microsoft\\Edge\\Application\\msedge.exe'),
        join(base, 'Chromium\\Application\\chrome.exe'),
      );
    }
  } else {
    out.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
    );
  }
  out.push(...puppeteerCachePaths(join(home, '.cache', 'puppeteer')));
  return out;
}

/**
 * Browsers the common tooling has already downloaded. Worth checking: a
 * developer whose project uses Playwright or Puppeteer has a working browser
 * on disk even when the machine has no browser installed for a human.
 */
function puppeteerCachePaths(cacheDir: string): string[] {
  const out: string[] = [];
  let products: string[];
  try {
    products = readdirSync(cacheDir);
  } catch {
    return out;
  }
  for (const product of products) {
    if (!product.startsWith('chrome')) continue;
    let builds: string[];
    try {
      builds = readdirSync(join(cacheDir, product)).sort().reverse();
    } catch {
      continue;
    }
    for (const build of builds) {
      const base = join(cacheDir, product, build);
      out.push(
        join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(base, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(base, 'chrome-linux64', 'chrome'),
        join(base, 'chrome-win64', 'chrome.exe'),
        join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        join(base, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
        join(base, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        join(base, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
      );
    }
  }
  return out;
}

/**
 * The browser this machine will use, or null when it has none. An env var
 * always wins — including one that points at a path that does not exist, which
 * is reported as the error it is rather than silently ignored in favour of some
 * other browser.
 */
export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): { path: string; source: 'env' | 'installed' } | null {
  for (const key of BROWSER_PATH_ENV_VARS) {
    const value = env[key];
    if (value) return { path: value, source: 'env' };
  }
  for (const candidate of candidatePaths()) {
    if (exists(candidate)) return { path: candidate, source: 'installed' };
  }
  return null;
}

export const NO_BROWSER_MESSAGE =
  'No browser found on this machine to open the local app with. ' +
  'Install Chrome, Chromium, Edge, or Brave, or point ' +
  `${BROWSER_PATH_ENV_VARS[0]} at a browser you already have.`;

/**
 * How long one DevTools command may wait for its reply. Nothing this command
 * asks a browser to do is slow enough to need more; a command still waiting
 * after this means the browser has stopped answering, not that the page is
 * busy. The whole-run budget is separate and larger.
 */
export const DEVTOOLS_COMMAND_TIMEOUT_MS = 15_000;

/** One request/response + event channel to a running browser. */
export class DevToolsSession {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('close', () => this.failAll(new Error('The browser closed the connection.')));
    socket.addEventListener('error', () => this.failAll(new Error('The connection to the browser failed.')));
  }

  static async connect(wsUrl: string, timeoutMs: number): Promise<DevToolsSession> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to the browser.')), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to the browser.')); }, { once: true });
    });
    return new DevToolsSession(socket);
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg['id'];
    if (typeof id === 'number') {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      const error = msg['error'] as { message?: string } | undefined;
      if (error) waiter.reject(new Error(error.message ?? 'The browser rejected the command.'));
      else waiter.resolve((msg['result'] as Record<string, unknown>) ?? {});
      return;
    }
    const method = msg['method'];
    if (typeof method !== 'string') return;
    for (const fn of this.listeners.get(method) ?? []) {
      fn((msg['params'] as Record<string, unknown>) ?? {});
    }
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  on(method: string, fn: (params: Record<string, unknown>) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  /**
   * Send one DevTools command and wait for its reply, BOUNDED.
   *
   * A reply only ever arrives from `onMessage` (matching id) or `failAll`
   * (socket closed/errored). A browser that accepts the socket and then stops
   * answering satisfies neither, so an unbounded wait here hung the whole
   * command with nothing printed — the silent >90s stall. Every command now
   * carries its own deadline, and the waiter is registered BEFORE the write so
   * a reply can never land before there is anything to receive it.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEVTOOLS_COMMAND_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('The connection to the browser is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `The browser did not answer \`${method}\` within ${Math.round(timeoutMs / 1000)}s. ` +
          'The page may be stuck; run it again, and close any browser this command left behind.',
        ));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Set once the session is attached to a page target. */
  sessionId: string | undefined;

  close(): void {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
  }
}

export interface LaunchedBrowser {
  session: DevToolsSession;
  close: () => Promise<void>;
}

/** The DevTools endpoint a freshly launched browser prints on stderr. */
function readEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`The browser did not report a DevTools endpoint within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const match = buffered.match(/ws:\/\/[^\s]+/);
      if (!match) return;
      cleanup();
      resolve(match[0]);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`The browser exited (code ${code ?? 'unknown'}) before it was ready.`));
    };
    function cleanup(): void {
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    }
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

/**
 * Launch a headless browser and attach to a fresh page.
 *
 * Every run gets its own empty profile directory, so a local check never reads
 * or writes the developer's real browser profile — no cookies of theirs leak
 * into the page, and nothing the page does survives the run.
 */
export async function launchLocalBrowser(opts: {
  executablePath: string;
  viewport: { width: number; height: number };
  timeoutMs: number;
}): Promise<LaunchedBrowser> {
  const profileDir = mkdtempSync(join(tmpdir(), 'somewhere-browser-'));
  const child = spawn(
    opts.executablePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      `--window-size=${opts.viewport.width},${opts.viewport.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-gpu',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const cleanup = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 2_000).unref();
      });
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await exited;
    }
    // The profile is a scratch directory in the OS temp dir. Failing to remove
    // it is not worth failing a run over — the browser may still be flushing —
    // and the OS reclaims it.
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* the OS will reclaim it */
    }
  };

  let session: DevToolsSession;
  try {
    const endpoint = await readEndpoint(child, opts.timeoutMs);
    session = await DevToolsSession.connect(endpoint, opts.timeoutMs);
    const { targetId } = (await session.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const attached = (await session.send('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId: string;
    };
    session.sessionId = attached.sessionId;
  } catch (err) {
    await cleanup();
    throw err;
  }

  return {
    session,
    close: async () => {
      session.close();
      await cleanup();
    },
  };
}
