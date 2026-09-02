/**
 * The URL `somewhere dev` prints has to work in a browser.
 *
 * It prints http://localhost:<port> and used to bind 127.0.0.1 only. On a
 * dual-stack machine `localhost` resolves to ::1 first, so Chrome got
 * ERR_CONNECTION_REFUSED while every terminal check passed — curl silently
 * falls back to IPv4 (tsk_737ff0d2). The failure looked like "the CLI is
 * broken", and it survived because the serving path was only ever verified
 * with curl.
 *
 * Both loopback families must answer, and neither listener may be reachable
 * off-loopback: these servers run functions with the developer's real CLI
 * token against their real project.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import test from 'node:test';

import { serveLoopback } from '../dist/local/loopback.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Does this machine actually have an IPv6 loopback to bind? */
function hasIpv6Loopback() {
  return Object.values(networkInterfaces())
    .flat()
    .some((iface) => iface && iface.family === 'IPv6' && iface.address === '::1');
}

test('the dev server answers on both loopback families', async (t) => {
  const port = await freePort();
  const { servers } = await serveLoopback((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  }, port, () => {
    throw new Error('port unexpectedly in use');
  });
  try {
    const v4 = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(v4.status, 200, 'IPv4 loopback answers');
    assert.equal(await v4.text(), 'ok');

    if (!hasIpv6Loopback()) {
      t.diagnostic('no ::1 on this machine — IPv6 leg not exercised, which is the documented best-effort case');
      return;
    }
    const v6 = await fetch(`http://[::1]:${port}/`);
    assert.equal(
      v6.status,
      200,
      'IPv6 loopback answers — this is the address a browser reaches for `localhost` on a dual-stack machine',
    );
    assert.equal(await v6.text(), 'ok');

    // And the name the CLI actually prints, resolved by Node the way the
    // browser resolves it.
    const byName = await fetch(`http://localhost:${port}/`);
    assert.equal(byName.status, 200, 'the printed hostname resolves to a listener');
  } finally {
    for (const s of servers) s.close();
  }
});

test('the dev server is not reachable off loopback', async () => {
  const port = await freePort();
  const { servers } = await serveLoopback((_req, res) => res.end('ok'), port, () => {
    throw new Error('port unexpectedly in use');
  });
  try {
    // A non-loopback address on this host must be refused: these functions run
    // as the developer against their real project, so the LAN must never see
    // them. Skipped when the machine has no external IPv4 to test against.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal);
    if (!external) return;
    await assert.rejects(
      fetch(`http://${external.address}:${port}/`, { signal: AbortSignal.timeout(2000) }),
      'a non-loopback address must be refused',
    );
  } finally {
    for (const s of servers) s.close();
  }
});
