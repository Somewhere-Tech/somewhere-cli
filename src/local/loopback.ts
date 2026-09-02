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
import { createServer, type RequestListener, type Server } from 'node:http';

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
