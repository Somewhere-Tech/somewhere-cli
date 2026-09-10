import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const clientUrl = new URL('../dist/lib/client.js', import.meta.url).href;
const httpUrl = new URL('../dist/lib/http.js', import.meta.url).href;
const fakeHost = 'proxy-only.invalid';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runChild(source, env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      delete childEnv[name];
    }
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: repoRoot,
      env: {
        ...childEnv,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('child exceeded the 5 second test budget'));
    }, 5_000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (status !== 0) {
        reject(new Error(`child exited ${status}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function makeOrigin(serverFactory, tls = undefined) {
  return serverFactory(tls ?? {}, (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/mcp') {
        const message = JSON.parse(body);
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { method: message.method, authorization: req.headers.authorization },
        }));
        return;
      }
      if (req.url === '/v1/stream') {
        res.end('streamed');
        return;
      }
      const request = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
      res.end(JSON.stringify(req.url === '/raw' ? request : { ok: true, data: request }));
    });
  });
}

function makeConnectProxy(originPort) {
  const connections = [];
  const sockets = new Set();
  const server = createHttpServer((req, res) => {
    const target = new URL(req.url);
    connections.push(target.host);
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: originPort,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: req.headers,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.once('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, socket, head) => {
    connections.push(req.url);
    const upstream = connect(originPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once('error', () => socket.destroy());
  });
  server.connections = connections;
  server.destroySockets = () => {
    for (const socket of sockets) socket.destroy();
  };
  return server;
}

test('uppercase HTTP_PROXY carries ApiClient calls, runner calls, streams, and unauthenticated fetches', async (t) => {
  const origin = makeOrigin(createHttpServer);
  const originPort = await listen(origin);
  const proxy = makeConnectProxy(originPort);
  const proxyPort = await listen(proxy);
  t.after(async () => {
    proxy.destroySockets();
    await Promise.all([close(proxy), close(origin)]);
  });

  const result = await runChild(`
    const { ApiClient } = await import(${JSON.stringify(clientUrl)});
    const { fetchWithProxy } = await import(${JSON.stringify(httpUrl)});
    const client = new ApiClient('smt_proxy_test');
    const call = await client.call('POST', '/deploy', { files: [{ path: 'index.html', content: 'hi' }] });
    const runner = await client.callRunner({ project_id: 'p1', code: 'return 1' });
    const stream = await client.callStream('POST', '/stream', () => 'upload', { replayableBody: true });
    const raw = await (await fetchWithProxy('http://${fakeHost}/raw')).json();
    process.stdout.write(JSON.stringify({ call, runner, stream: await stream.text(), raw }));
  `, {
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    SOMEWHERE_API_URL: `http://${fakeHost}/v1`,
    SOMEWHERE_RUNNER_URL: `http://${fakeHost}/runner`,
  });

  assert.deepEqual(result.call.body.files, [{ path: 'index.html', content: 'hi' }]);
  assert.equal(result.runner.url, '/runner/run');
  assert.equal(result.stream, 'streamed');
  assert.equal(result.raw.url, '/raw');
  assert.ok(proxy.connections.length >= 1);
  assert.ok(proxy.connections.every((target) => target === fakeHost || target === `${fakeHost}:80`));
});

test('MCP SDK transport sends its JSON-RPC request through the proxy', async (t) => {
  const origin = makeOrigin(createHttpServer);
  const originPort = await listen(origin);
  const proxy = makeConnectProxy(originPort);
  const proxyPort = await listen(proxy);
  t.after(async () => {
    proxy.destroySockets();
    await Promise.all([close(proxy), close(origin)]);
  });

  const result = await runChild(`
    const { createPlatformMcpTransport } = await import(
      ${JSON.stringify(new URL('../dist/lib/platform-tools.js', import.meta.url).href)}
    );
    const transport = await createPlatformMcpTransport('smt_mcp_proxy_test');
    const received = new Promise((resolve, reject) => {
      transport.onmessage = resolve;
      transport.onerror = reject;
    });
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    const message = await received;
    await transport.close();
    process.stdout.write(JSON.stringify(message));
  `, {
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    SOMEWHERE_MCP_URL: `http://${fakeHost}/mcp`,
  });

  assert.equal(result.id, 7);
  assert.equal(result.result.method, 'tools/list');
  assert.equal(result.result.authorization, 'Bearer smt_mcp_proxy_test');
  assert.ok(proxy.connections.some((target) => target === fakeHost || target === `${fakeHost}:80`));
});

test('lowercase https_proxy carries TLS through CONNECT with certificate validation enabled', async (t) => {
  const certDir = mkdtempSync(join(tmpdir(), 'sw-proxy-cert-'));
  t.after(() => rmSync(certDir, { recursive: true, force: true }));
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${fakeHost}`, '-addext', `subjectAltName=DNS:${fakeHost}`,
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  if (openssl.status !== 0) {
    t.skip('openssl is unavailable');
    return;
  }
  const origin = makeOrigin(createHttpsServer, {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  });
  const originPort = await listen(origin);
  const proxy = makeConnectProxy(originPort);
  const proxyPort = await listen(proxy);
  t.after(async () => {
    proxy.destroySockets();
    await Promise.all([close(proxy), close(origin)]);
  });

  const result = await runChild(`
    const { fetchWithProxy } = await import(${JSON.stringify(httpUrl)});
    const response = await fetchWithProxy('https://${fakeHost}/raw');
    process.stdout.write(JSON.stringify(await response.json()));
  `, {
    https_proxy: `http://127.0.0.1:${proxyPort}`,
    NODE_EXTRA_CA_CERTS: certPath,
  });
  assert.equal(result.url, '/raw');
  assert.deepEqual(proxy.connections, [`${fakeHost}:443`]);
});

test('NO_PROXY bypasses the proxy and an empty proxy environment preserves direct requests', async (t) => {
  const origin = makeOrigin(createHttpServer);
  const originPort = await listen(origin);
  const proxy = makeConnectProxy(originPort);
  const proxyPort = await listen(proxy);
  t.after(async () => {
    proxy.destroySockets();
    await Promise.all([close(proxy), close(origin)]);
  });
  const source = `
    const { fetchWithProxy } = await import(${JSON.stringify(httpUrl)});
    const response = await fetchWithProxy('http://127.0.0.1:${originPort}/raw');
    process.stdout.write(JSON.stringify(await response.json()));
  `;

  const bypassed = await runChild(source, {
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: '127.0.0.1',
  });
  const direct = await runChild(source, {});
  assert.equal(bypassed.url, '/raw');
  assert.equal(direct.url, '/raw');
  assert.equal(proxy.connections.length, 0);
});

test('fetchWithProxy retains timeout cancellation', async (t) => {
  const hanging = createHttpServer(() => {});
  const port = await listen(hanging);
  t.after(async () => close(hanging));
  const result = await runChild(`
    const { fetchWithProxy } = await import(${JSON.stringify(httpUrl)});
    try {
      await fetchWithProxy('http://127.0.0.1:${port}/hang', undefined, 25);
      process.stdout.write(JSON.stringify({ resolved: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ name: error.name }));
    }
  `, {});
  assert.ok(['TimeoutError', 'AbortError'].includes(result.name), `unexpected error: ${result.name}`);
});
