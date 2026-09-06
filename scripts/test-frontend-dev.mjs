#!/usr/bin/env node
// Offline integration: installed framework + current platform origin policy.
// Explicit source/dependency roots; no installation or public service calls.
import assert from 'node:assert/strict';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { startFrontendDev } from '../dist/lib/frontend-dev.js';
import { launchLocalBrowser, findBrowser } from '../dist/lib/chrome.js';

const [viteRootArg, platformArg] = process.argv.slice(2);
assert.ok(viteRootArg && platformArg, 'Usage: node scripts/test-frontend-dev.mjs <installed-vite-project> <platform-source>');
const viteRoot = resolve(viteRootArg), platform = resolve(platformArg);
const temp = mkdtempSync(join(tmpdir(), 'frontend-native-'));
const target = 'https://fixture.somewhere.site';
const realHttpsRequest = https.request;
let server, upstream, browser;
const observed = [];
function listen(server) { return new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); }); }
function close(server) { return new Promise(ok => server.close(ok)); }
async function send(port, path, headers = {}, method = 'GET', body = '') {
  return new Promise((ok, no) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { host: `localhost:${port}`, ...headers } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', no); req.end(body);
  });
}
try {
  const corsSource = readFileSync(join(platform, 'web/src/customer-cors.ts'), 'utf8');
  const corsJs = ts.transpileModule(corsSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { decideCustomerCors } = await import(`data:text/javascript;base64,${Buffer.from(corsJs).toString('base64')}`);
  const contextSource = readFileSync(join(platform, 'worker/src/runtime/context-head.ts'), 'utf8');
  const start = contextSource.indexOf('  function __sw_cookieCsrfAssessment(req)');
  const end = contextSource.indexOf('  function __sw_recordCookieCsrfBlocked', start);
  assert.ok(start > 0 && end > start);
  const csrf = vm.runInNewContext(contextSource.slice(start, end) + '\n__sw_cookieCsrfAssessment', { URL, platformDomain: 'somewhere.tech', tenantDomain: 'somewhere.site' });

  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temp, 'key'), '-out', join(temp, 'cert'), '-days', '1', '-subj', '/CN=fixture.somewhere.site', '-addext', 'subjectAltName=DNS:fixture.somewhere.site'], { stdio: 'ignore' });
  const cert = readFileSync(join(temp, 'cert'));
  upstream = https.createServer({ key: readFileSync(join(temp, 'key')), cert }, (req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const headers = new Headers(Object.entries(req.headers).filter(([, value]) => typeof value === 'string'));
      const policy = decideCustomerCors({ origin: headers.get('origin'), requestedHeaders: null, ownOrigins: [target], allowedOrigins: [], requiresApprovedOrigin: headers.has('cookie'), selfOrigin: target });
      const cookie = csrf(new Request(target + req.url, { method: req.method, headers }));
      observed.push({ url: req.url, headers: req.headers, body, policy, cookie });
      if (!policy.allowed || cookie.wouldBlock) { res.writeHead(403); res.end('actual policy denied'); return; }
      if (req.url === '/api/cookie') res.setHeader('Set-Cookie', ['__Host-token=synthetic-app-session; Path=/; Secure; HttpOnly; SameSite=Lax', 'scoped=synthetic-domain-cookie; Domain=fixture.somewhere.site; Path=/; Secure; HttpOnly; SameSite=Strict']);
      res.writeHead(req.url.startsWith('/api/write') ? 201 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ body, cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null }));
    });
  });
  await listen(upstream);
  // Route ONLY the fixed synthetic target to its trusted ephemeral TLS server.
  // Keep TLS verification enabled, with a certificate valid for that hostname.
  https.request = function(options, ...rest) {
    assert.equal(options.hostname || options.host, 'fixture.somewhere.site', 'unexpected upstream');
    return realHttpsRequest.call(this, { ...options, port: upstream.address().port, ca: cert,
      lookup: (_host, options, cb) => options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4) }, ...rest);
  };
  const vacant = httpServer(); await listen(vacant); const port = vacant.address().port; await close(vacant);
  const local = `http://localhost:${port}`;
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ type: 'module', dependencies: { vite: '*' } }));
  writeFileSync(join(temp, 'index.html'), '<!doctype html><div id="app">frontend source</div>');
  writeFileSync(join(temp, 'vite.config.mjs'), `export default { cacheDir: ${JSON.stringify(join(temp, 'vite-cache'))}, server: { proxy: { '/api': 'https://must-not-be-used.invalid' } } };`);
  symlinkSync(join(viteRoot, 'node_modules'), join(temp, 'node_modules'));
  server = await startFrontendDev(temp, target, port);
  assert.match((await send(port, '/')).data, /frontend source/);
  for (const path of ['/api', '/api?q=one', '/api/nested?q=two']) assert.equal((await send(port, path, { origin: local })).status, 200);
  const written = await send(port, '/api/write?q=kept', { origin: local, cookie: '__Host-token=synthetic-cookie', authorization: 'Bearer synthetic-user', 'x-forwarded-host': 'evil.invalid', 'x-sw-cors-authorized': '1' }, 'POST', 'exact-body');
  assert.equal(written.status, 201, written.data);
  const last = observed.at(-1);
  assert.equal(last.body, 'exact-body'); assert.equal(last.url, '/api/write?q=kept');
  assert.equal(last.headers.origin, target); assert.equal(last.headers.authorization, 'Bearer synthetic-user');
  assert.equal(last.headers['x-forwarded-host'], undefined); assert.equal(last.headers['x-sw-cors-authorized'], undefined);
  assert.equal(last.cookie.wouldBlock, false); assert.equal(last.policy.originAuthorized, true);
  const before = observed.length;
  for (const headers of [{ origin: 'https://evil.invalid' }, { origin: 'null' }, { host: 'evil.invalid' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await send(port, '/api/write', headers, 'POST')).status, 403);
  await send(port, '/v1/db/query'); await send(port, '/__sw_cap');
  assert.equal(observed.length, before, 'non-API or denied paths never reach deployed adapter');

  const found = findBrowser(); assert.ok(found, 'Browser required for explicit native integration; no green skip');
  browser = await launchLocalBrowser({ executablePath: found.path, viewport: { width: 800, height: 600 }, timeoutMs: 15000 });
  await browser.session.send('Page.navigate', { url: local });
  const result = await browser.session.send('Runtime.evaluate', { expression: `(async () => { await fetch('/api/cookie'); const r = await fetch('/api/write', { method:'POST', body:'browser-body' }); return { status:r.status, data:await r.json(), visibleCookies:document.cookie }; })()`, awaitPromise: true, returnByValue: true });
  assert.equal(result.result?.value?.status, 201, JSON.stringify(result));
  assert.match(result.result.value.data.cookie, /__Host-token=synthetic-app-session/);
  assert.match(result.result.value.data.cookie, /scoped=synthetic-domain-cookie/);
  assert.doesNotMatch(result.result.value.visibleCookies, /synthetic-app-session|synthetic-domain-cookie/);
  writeFileSync(join(temp, 'index.html'), '<!doctype html><div id="app">frontend changed</div>');
  const reloadDeadline = Date.now() + 10000;
  let reloaded = false;
  while (Date.now() < reloadDeadline) {
    try {
      const view = await browser.session.send('Runtime.evaluate', { expression: 'document.querySelector("#app")?.textContent', returnByValue: true });
      if (view.result?.value === 'frontend changed') { reloaded = true; break; }
    } catch { /* execution context may be replaced during the native reload */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(reloaded, 'saving frontend source must reload the running browser');
  assert.equal(observed.at(-1).cookie.wouldBlock, false);
  console.log('PASS native frontend: installed Vite serves and hot reloads source; fixed API proxy preserves path/body/status; current web CORS/runtime cookie assessment passes; foreign/rebound requests blocked; Chrome sends Secure HttpOnly localhost cookie on write.');
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  if (upstream) await close(upstream);
  https.request = realHttpsRequest;
  rmSync(temp, { recursive: true, force: true });
}
