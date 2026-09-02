/**
 * Serve on loopback — both families of it.
 *
 * These servers run the developer's functions with their real CLI token
 * against their real project, so the listener must never leave loopback. But
 * `127.0.0.1` alone is not loopback-complete: on a dual-stack machine
 * `localhost` resolves to `::1` first, so a browser opening the URL the CLI
 * prints got ERR_CONNECTION_REFUSED while every terminal check passed, because
 * curl falls back to IPv4 (tsk_737ff0d2). The failure read as "the CLI is
 * broken" and survived because the serving path was only ever checked with
 * curl.
 *
 * One Node server binds one address, so this is two servers sharing one
 * request handler. IPv4 is required; IPv6 is best-effort, because a machine
 * with IPv6 disabled has no `::1` to bind and that is fine.
 */
import { execFile } from 'node:child_process';
import { createServer, type RequestListener, type Server } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DevPortChoice {
  port: number;
  movedFrom: number | null;
}

export class PortInUseError extends Error {
  constructor(readonly port: number, readonly owner: string | null) {
    super(
      `Port ${port} is already in use${owner ? ` by ${owner}` : ''}. `
        + `Stop that process or choose another port with --port <n>.`,
    );
    this.name = 'PortInUseError';
  }
}

async function canBind(port: number, host: '127.0.0.1' | '::1'): Promise<'yes' | 'busy' | 'unavailable'> {
  const probe = createServer();
  return new Promise((resolveProbe) => {
    const finish = (result: 'yes' | 'busy' | 'unavailable') => {
      probe.removeAllListeners();
      resolveProbe(result);
    };
    probe.once('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'EADDRINUSE' ? 'busy' : 'unavailable');
    });
    probe.listen({ port, host, ipv6Only: host === '::1' }, () => {
      probe.close(() => finish('yes'));
    });
  });
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  const v4 = await canBind(port, '127.0.0.1');
  if (v4 !== 'yes') return false;
  const v6 = await canBind(port, '::1');
  // IPv6 is optional, but an existing IPv6 listener would receive requests
  // from browsers that resolve localhost to ::1 before 127.0.0.1.
  return v6 !== 'busy';
}

async function portOwner(port: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
      { timeout: 1500 },
    );
    let pid = '';
    let command = '';
    for (const line of stdout.split('\n')) {
      if (!pid && line.startsWith('p')) pid = line.slice(1).trim();
      if (!command && line.startsWith('c')) command = line.slice(1).trim();
    }
    if (!command) return pid ? `PID ${pid}` : null;
    return pid ? `${command} (PID ${pid})` : command;
  } catch {
    return null;
  }
}

/**
 * Resolve the port before compiler/project setup so a requested busy port
 * fails immediately. An omitted port walks forward from 8787; an explicit
 * --port is strict and never silently changes the developer's request.
 */
export async function chooseDevPort(
  requestedPort: number | undefined,
  defaultPort = 8787,
): Promise<DevPortChoice> {
  if (requestedPort !== undefined) {
    if (await loopbackPortAvailable(requestedPort)) return { port: requestedPort, movedFrom: null };
    throw new PortInUseError(requestedPort, await portOwner(requestedPort));
  }
  for (let port = defaultPort; port <= 65535; port += 1) {
    if (await loopbackPortAvailable(port)) {
      return { port, movedFrom: port === defaultPort ? null : defaultPort };
    }
  }
  throw new Error(`No free local port was found from ${defaultPort} through 65535.`);
}

export interface LoopbackServers {
  /** Every listener, for shutdown. */
  servers: Server[];
  /** True when ::1 is also being served. */
  ipv6: boolean;
}

export async function serveLoopback(
  handler: RequestListener,
  port: number,
  onPortInUse: (port: number) => never,
): Promise<LoopbackServers> {
  const servers: Server[] = [];

  const v4 = createServer(handler);
  await new Promise<void>((done, fail) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') onPortInUse(port);
      fail(err);
    };
    v4.once('error', onError);
    v4.listen(port, '127.0.0.1', () => {
      v4.off('error', onError);
      done();
    });
  });
  servers.push(v4);

  // Best-effort. ipv6Only keeps this from colliding with the IPv4 listener on
  // platforms where an unqualified ::1 bind would also claim 0.0.0.0.
  const v6 = createServer(handler);
  const ipv6 = await new Promise<boolean>((done) => {
    const onError = () => done(false);
    v6.once('error', onError);
    try {
      v6.listen({ port, host: '::1', ipv6Only: true }, () => {
        v6.off('error', onError);
        done(true);
      });
    } catch {
      done(false);
    }
  });
  if (ipv6) servers.push(v6);

  return { servers, ipv6 };
}
