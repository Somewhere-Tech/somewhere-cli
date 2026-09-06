import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FrontendDevServer {
  listen(): Promise<unknown>;
  close(): Promise<unknown>;
  printUrls(): void;
}

interface ViteModule {
  createServer(options: unknown): Promise<FrontendDevServer>;
}

export const FRONTEND_API_PATH = '^/api(?:/|\\?|$)';

export function deployedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The project did not return a canonical HTTPS serving origin.');
  }
  return url.origin;
}

/** Only a request to this exact loopback authority may cross the proxy. */
export function authorizeFrontendProxy(req: IncomingMessage, localOrigin: string): boolean {
  const local = new URL(localOrigin);
  if (local.hostname !== 'localhost' || local.protocol !== 'http:') return false;
  if (req.headers.host !== local.host) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== local.origin) return false;
  if (origin === undefined && req.headers['sec-fetch-site'] === 'cross-site') return false;
  // Without Origin, do not let a cross-site Referer turn into trusted context.
  const referer = req.headers.referer;
  if (origin === undefined && referer !== undefined) {
    try { if (new URL(referer).origin !== local.origin) return false; } catch { return false; }
  }
  return true;
}

export function frontendProxy(target: string, localOrigin: string) {
  const origin = deployedOrigin(target);
  return {
    target: origin,
    changeOrigin: true,
    secure: true,
    cookieDomainRewrite: '',
    // End-user Cookie/Authorization remain intact. No runtime/platform identity
    // is added, and no caller-supplied forwarded origin becomes authority.
    bypass(req: IncomingMessage, res: ServerResponse | undefined): string | undefined {
      if (!res) throw new Error('API WebSocket proxying is not enabled.');
      if (!authorizeFrontendProxy(req, localOrigin)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('This API proxy accepts only requests from its local frontend.');
        return req.url || '/'; // Vite stops when this response is already ended.
      }
      for (const name of Object.keys(req.headers)) {
        if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-sw-cors-authorized') {
          delete req.headers[name];
        }
      }
      if (req.headers.origin !== undefined) req.headers.origin = origin;
      if (req.headers.referer !== undefined) delete req.headers.referer;
      return undefined;
    },
  };
}

export async function startFrontendDev(cwd: string, target: string, port = 8787, open = false): Promise<FrontendDevServer> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 through 65535.');
  const origin = deployedOrigin(target);
  let vitePath: string;
  try { vitePath = createRequire(join(cwd, 'package.json')).resolve('vite'); }
  catch { throw new Error('Install this frontend’s Vite dependencies before running somewhere dev. Backend changes run through somewhere deploy or somewhere preview.'); }
  const vite = await import(pathToFileURL(vitePath).href) as ViteModule;
  const localOrigin = `http://localhost:${port}`;
  const proxy = frontendProxy(origin, localOrigin);
  const server = await vite.createServer({
    root: cwd,
    server: { host: '127.0.0.1', port, strictPort: true, open: open ? localOrigin : false, cors: false },
    plugins: [{
      name: 'somewhere-deployed-api',
      // Existing framework plugins/config remain. This API selector must be
      // first, so an existing broad proxy cannot redirect these requests.
      configResolved(config: { server: { proxy?: Record<string, unknown> } }) {
        const others = { ...config.server.proxy };
        delete others[FRONTEND_API_PATH];
        config.server.proxy = { [FRONTEND_API_PATH]: proxy, ...others };
      },
    }],
  });
  try { await server.listen(); } catch (error) { await server.close(); throw error; }
  console.log(`Frontend hot reload: ${localOrigin}`);
  console.log(`API requests use the deployed backend: ${origin}`);
  console.log('Backend changes require somewhere deploy or somewhere preview.');
  const closeServer = server.close.bind(server);
  server.close = async () => {
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
    return closeServer();
  };
  const close = () => { void server.close().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Could not stop the frontend server.');
    process.exitCode = 1;
  }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}
