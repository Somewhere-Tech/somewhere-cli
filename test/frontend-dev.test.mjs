import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { authorizeFrontendProxy, deployedOrigin, frontendProxy, FRONTEND_API_PATH } from '../dist/lib/frontend-dev.js';
import { getDeployedProjectServingUrl } from '../dist/lib/project-urls.js';
import { registerDev } from '../dist/commands/dev.js';

const local = 'http://localhost:8787';
const target = 'https://fixture.somewhere.site';
function request(headers = {}) { return { headers: { host: 'localhost:8787', ...headers }, url: '/api/write?q=one', method: 'POST' }; }
function response() { return { status: 0, ended: false, writeHead(status) { this.status = status; }, end() { this.ended = true; } }; }

test('proxy authority rejects foreign, opaque, rebound and forged forwarded context', () => {
  for (const headers of [
    { host: 'attacker.test:8787' }, { host: 'localhost:8788' }, { host: '127.0.0.1:8787' },
    { origin: 'https://attacker.test' }, { origin: 'null' }, { origin: local + '/' },
    { 'sec-fetch-site': 'cross-site' }, { referer: 'https://attacker.test/form' },
    { host: 'attacker.test', 'x-forwarded-host': 'localhost:8787', 'x-forwarded-origin': local },
  ]) {
    const req = request(headers), res = response();
    assert.equal(authorizeFrontendProxy(req, local), false);
    assert.equal(typeof frontendProxy(target, local).bypass(req, res), 'string');
    assert.equal(res.status, 403); assert.equal(res.ended, true);
  }
});

test('accepted same-origin requests retain user credentials and exact path, never inject platform authority', () => {
  const proxy = frontendProxy(target, local);
  const req = request({ origin: local, cookie: '__Host-token=synthetic-app-cookie', authorization: 'Bearer synthetic-app-token',
    'x-forwarded-host': 'evil', forwarded: 'host=evil', 'x-forwarded-proto': 'http', 'x-sw-cors-authorized': '1' });
  assert.equal(proxy.bypass(req, response()), undefined);
  assert.equal(req.headers.origin, target);
  assert.equal(req.headers.cookie, '__Host-token=synthetic-app-cookie');
  assert.equal(req.headers.authorization, 'Bearer synthetic-app-token');
  assert.equal(req.url, '/api/write?q=one');
  for (const field of ['x-forwarded-host', 'forwarded', 'x-forwarded-proto', 'x-sw-cors-authorized']) assert.equal(req.headers[field], undefined);
  assert.equal(proxy.target, target); assert.equal(proxy.secure, true); assert.equal(proxy.cookieDomainRewrite, '');
  const direct = request(); proxy.bypass(direct, response());
  assert.equal(direct.headers.authorization, undefined); assert.equal(direct.headers.cookie, undefined); assert.equal(direct.headers.origin, undefined);
  const selector = new RegExp(FRONTEND_API_PATH);
  for (const path of ['/api', '/api?x=1', '/api/write', '/api/auth/me?x=2']) assert.equal(selector.test(path), true);
  for (const path of ['/apiculture', '/v1/db/query', '/__sw_cap', '/src/app.tsx', '/dashboard']) assert.equal(selector.test(path), false);
});

test('dev exposes frontend options and no local-runtime or compatibility entrypoints', () => {
  const program = new Command(); registerDev(program);
  const dev = program.commands.find(c => c.name() === 'dev');
  assert.ok(dev); assert.equal(dev.registeredArguments.length, 0);
  for (const flag of ['--local', '--cloud', '--publish-first', '--check']) assert.equal(dev.options.some(o => o.long === flag), false);
  assert.match(dev.description(), /Frontend hot reload/);
  for (const url of ['http://fixture.somewhere.site', target + '/api', 'https://user:secret@fixture.somewhere.site', target + ':9443']) assert.throws(() => deployedOrigin(url));
  assert.equal(deployedOrigin(target), target);
});

test('dev requires deployed identity, preserves legacy serving versions and never creates a backend', async () => {
  for (const identity of [{ active_release_id: 'release-current' }, { prod_version: 2 }]) {
    const calls = [];
    const client = { call: async (...args) => { calls.push(args); return { prod_fallback: target, ...identity }; } };
    assert.equal(await getDeployedProjectServingUrl(client, 'project ref'), target);
    assert.deepEqual(calls, [['GET', '/projects/project%20ref/urls']]);
  }
  for (const identity of [{}, { active_release_id: null, prod_version: null }, { prod_version: 0 }, { prod_version: '2' }, { active_release_id: '' }]) {
    await assert.rejects(getDeployedProjectServingUrl({ call: async () => ({ prod_fallback: target, ...identity }) }, 'fixture'), /did not confirm a deployed version/);
  }
  await assert.rejects(getDeployedProjectServingUrl({ call: async () => { throw new Error('authority unavailable'); } }, 'fixture'), /authority unavailable/);
  await assert.rejects(getDeployedProjectServingUrl({ call: async () => ({ active_release_id: 'release' }) }, 'fixture'), /did not return a serving URL/);
});
