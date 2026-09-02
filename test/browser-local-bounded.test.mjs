/**
 * `somewhere browser <local url>` must never hang, and must never blame the app
 * for a request the app did not make.
 *
 * Two findings, one command (blind stranger run #2, 2026-09-02):
 *
 *   tsk_a605ff7b — pointed at a localhost address that was not being served the
 *   way it expected, the command printed NOTHING for over 90 seconds and had to
 *   be interrupted. Three unbounded waits stacked up: the DevTools request
 *   channel had no per-command deadline at all, the page-load race was armed for
 *   the WHOLE remaining run budget, and nothing checked that anything was
 *   listening before a browser was launched at the address. A silent hang is the
 *   worst possible answer from the one command whose job is to say whether the
 *   page rendered.
 *
 *   tsk_10be456b — the same local path reported FAIL on the app `somewhere init`
 *   scaffolds, on a page with zero console errors and zero page errors, because
 *   Chrome's own automatic /favicon.ico fetch 404'd and was counted as a failed
 *   request of the page. The hosted half never counted it. A first-run FAIL that
 *   is the platform's own scaffold devalues every real FAIL beside it.
 *
 * The bounds are asserted with real timing, so a regression that removes one
 * fails here rather than being discovered by a stranger with a stopwatch.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import { DevToolsSession, DEVTOOLS_COMMAND_TIMEOUT_MS, findBrowser } from '../dist/local/chrome.js';
import {
  assertLocalTargetReachable,
  isBrowserOwnFaviconRequest,
  runLocalBrowser,
} from '../dist/local/browser-run.js';

const VIEWPORT = { width: 1280, height: 800 };

/** Bind a server on an ephemeral loopback port and hand back its url. */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://localhost:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ── The classification rule, on its own ─────────────────────────────── */

test('only the browser’s OWN favicon fetch is exempt from the failed-request list', () => {
  // Chrome asks for this with no page involvement: initiator type "other".
  assert.equal(isBrowserOwnFaviconRequest('http://localhost:8811/favicon.ico', 'other'), true);
  // A favicon the page DECLARES is parsed out of the markup — still the app's.
  assert.equal(isBrowserOwnFaviconRequest('http://localhost:8811/favicon.ico', 'parser'), false);
  // A fetch the app makes for its own icon is the app's too.
  assert.equal(isBrowserOwnFaviconRequest('http://localhost:8811/favicon.ico', 'script'), false);
  // The exemption is that one path and nothing else.
  assert.equal(isBrowserOwnFaviconRequest('http://localhost:8811/logo.png', 'other'), false);
  assert.equal(isBrowserOwnFaviconRequest('http://localhost:8811/api/links', 'other'), false);
  assert.equal(isBrowserOwnFaviconRequest(undefined, 'other'), false);
});

/* ── Nothing is listening: refuse, fast, with what to run ────────────── */

test('an address nothing is serving is refused in seconds, naming `somewhere dev`', async () => {
  // Bind, read the port, close it — a port we know is free right now.
  const parked = await listen(createServer(() => {}));
  const deadUrl = parked.url;
  await parked.close();

  const started = Date.now();
  await assert.rejects(
    () => assertLocalTargetReachable(deadUrl),
    (err) => {
      assert.match(err.message, /Nothing is serving/);
      assert.match(err.message, /somewhere dev/, 'the message says what to run');
      assert.match(err.message, /--project/, 'and names the hosted path for non-local URLs');
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, 'refused fast, not after a browser launch');
});

test('a target that accepts the connection and never answers is bounded, not silent', async () => {
  // Accepts TCP, reads the request, replies never — the shape that used to
  // drain the whole 90s budget without printing anything.
  const server = createServer(() => { /* deliberately no response */ });
  const site = await listen(server);
  try {
    const started = Date.now();
    await assert.rejects(
      () => assertLocalTargetReachable(site.url, 1_500),
      (err) => {
        assert.match(err.message, /did not answer within/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 6_000, `bounded by its own budget (took ${Date.now() - started}ms)`);
  } finally {
    // The hung request keeps a socket open; destroy it so the suite can exit.
    server.closeAllConnections?.();
    await site.close();
  }
});

test('a served address passes the preflight', async () => {
  const site = await listen(createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>ok</body></html>');
  }));
  try {
    await assertLocalTargetReachable(site.url);
  } finally {
    await site.close();
  }
});

/* ── The DevTools channel itself is bounded ──────────────────────────── */

/**
 * A DevTools endpoint that completes the WebSocket handshake and then never
 * answers a command — a browser that is up but wedged. Before the fix, every
 * `session.send()` against this waited forever.
 */
async function serveDeafDevTools() {
  const server = createServer(() => {});
  const sockets = [];
  server.on('upgrade', (req, socket) => {
    sockets.push(socket);
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // ...and then nothing, ever.
  });
  const site = await listen(server);
  return {
    wsUrl: `ws://127.0.0.1:${site.port}/devtools/browser/deaf`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await site.close();
    },
  };
}

test('a DevTools command that is never answered rejects on its own deadline', async () => {
  const endpoint = await serveDeafDevTools();
  try {
    const session = await DevToolsSession.connect(endpoint.wsUrl, 5_000);
    const started = Date.now();
    await assert.rejects(
      () => session.send('Target.createTarget', { url: 'about:blank' }, 1_200),
      (err) => {
        assert.match(err.message, /did not answer/);
        assert.match(err.message, /Target\.createTarget/, 'the message names the command that stalled');
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1_000 && elapsed < 6_000, `bounded by the deadline it was given (${elapsed}ms)`);
    session.close();
  } finally {
    await endpoint.close();
  }
});

test('the default command deadline is finite and well under the run budget', () => {
  assert.equal(typeof DEVTOOLS_COMMAND_TIMEOUT_MS, 'number');
  assert.ok(Number.isFinite(DEVTOOLS_COMMAND_TIMEOUT_MS));
  assert.ok(DEVTOOLS_COMMAND_TIMEOUT_MS > 0 && DEVTOOLS_COMMAND_TIMEOUT_MS < 90_000);
});

/* ── The scaffold's missing favicon is not the app's failure ─────────── */

test('a clean page whose only 404 is the browser’s favicon fetch PASSES', async (t) => {
  if (!findBrowser()) {
    t.skip('no browser installed on this machine — install Chrome/Chromium/Edge, or set SOMEWHERE_BROWSER_PATH');
    return;
  }
  // Exactly what `somewhere init` scaffolds plus `somewhere dev`'s catch-all:
  // no icon declared, no icon file, and any unmatched path 404s.
  const site = await listen(createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"NOT_FOUND"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Scaffold</title></head>' +
      '<body><button>Get started</button></body></html>');
  }));
  try {
    const report = await runLocalBrowser({
      url: site.url,
      wait: 'button',
      viewport: VIEWPORT,
      timeoutMs: 60_000,
    });
    assert.deepEqual(
      report.failed_requests,
      [],
      `the browser's own favicon fetch is not a failure of the page: ${JSON.stringify(report.failed_requests)}`,
    );
    assert.equal(report.page_errors.length, 0);
    assert.equal(report.passed, true, 'a clean scaffold reports PASS');
  } finally {
    await site.close();
  }
});

test('a 404 the PAGE asked for still fails', async (t) => {
  if (!findBrowser()) {
    t.skip('no browser installed on this machine');
    return;
  }
  const site = await listen(createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"NOT_FOUND"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><button>Go</button>' +
      "<script>fetch('/api/links');</script></body></html>");
  }));
  try {
    const report = await runLocalBrowser({
      url: site.url,
      wait: 'button',
      viewport: VIEWPORT,
      timeoutMs: 60_000,
    });
    assert.ok(
      report.failed_requests.some((r) => r.status === 404 && String(r.url).includes('/api/links')),
      `the page's own 404 is still reported: ${JSON.stringify(report.failed_requests)}`,
    );
    assert.equal(report.passed, false);
  } finally {
    await site.close();
  }
});
