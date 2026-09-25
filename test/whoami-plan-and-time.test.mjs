import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlanName } from '../dist/commands/auth.js';

// pfb_b69363269589: whoami's plan label comes from the public plan table, and
// relative times treat the database's zoneless timestamps as UTC.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pricing = { tiers: [{ id: 'free', name: 'Free' }, { id: 'builder', name: 'Builder' }, { id: 'pro', name: 'Pro' }] };
const stubClient = payload => ({ call: async (method, path) => {
  assert.equal(`${method} ${path}`, 'GET /pricing');
  if (payload instanceof Error) throw payload;
  return payload;
} });

test('plan labels come from the pricing table by tier id; an unlisted or unreadable tier prints its id', async () => {
  assert.equal(await readPlanName(stubClient(pricing), 'pro'), 'Pro');
  assert.equal(await readPlanName(stubClient(pricing), 'builder'), 'Builder');
  assert.equal(await readPlanName(stubClient(pricing), 'free'), 'Free');
  assert.equal(await readPlanName(stubClient(pricing), 'scale'), 'scale');
  assert.equal(await readPlanName(stubClient(new Error('offline')), 'pro'), 'pro');
});

function whoami(pricingResponse) {
  const home = mkdtempSync(join(tmpdir(), 'sw-whoami-plan-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_plan_test', user: { email: 'pro@example.com' } }));
  const server = createServer((req, res) => {
    const [status, body] = req.url === '/v1/auth/whoami'
      ? [200, { ok: true, data: { user: { email: 'pro@example.com', name: null, username: null, effective_tier: 'pro' }, stats: { api_keys: 1, projects: 2 } } }]
      : req.url === '/v1/pricing' ? pricingResponse : [404, { ok: false, error: 'NOT_FOUND' }];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'index.js'), 'whoami'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`, SOMEWHERE_MCP_URL: 'http://127.0.0.1:1/mcp', CI: '1', NO_COLOR: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.on('close', status => server.close(() => resolve({ status, firstLine: stdout.split('\n')[0] })));
  }));
}

test('whoami names a Pro account Pro, and prints the tier id without failing when pricing is down', async () => {
  const live = await whoami([200, { ok: true, data: pricing }]);
  assert.equal(live.status, 0);
  assert.match(live.firstLine, /pro@example\.com\s+\(Pro\)/);
  const down = await whoami([503, { ok: false, error: 'UNAVAILABLE', message: 'down' }]);
  assert.equal(down.status, 0);
  assert.match(down.firstLine, /pro@example\.com\s+\(pro\)/);
});

test('relative times read zoneless timestamps as UTC under a non-UTC TZ; ISO and epoch inputs stay correct', () => {
  const script = `
    const { timeAgo } = await import(${JSON.stringify(join(repoRoot, 'dist', 'lib', 'output.js'))});
    const at = new Date(Date.now() - 10 * 60_000);
    const iso = at.toISOString();
    const offset = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 19) + '+05:30';
    console.log(JSON.stringify({
      zoneless: timeAgo(iso.slice(0, 19).replace('T', ' ')),
      zonelessT: timeAgo(iso.slice(0, 19)),
      isoZ: timeAgo(iso),
      isoOffset: timeAgo(offset),
      epoch: timeAgo(at.getTime()),
      recent: timeAgo(new Date(Date.now() - 5_000).toISOString().slice(0, 19).replace('T', ' ')),
    }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' },
  }));
  assert.deepEqual(out, { zoneless: '10m ago', zonelessT: '10m ago', isoZ: '10m ago', isoOffset: '10m ago', epoch: '10m ago', recent: 'just now' });
});
