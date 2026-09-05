import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fetchAdvisorHealth, advisorHealthLine } from '../src/lib/advisor-health.ts';

// Real command handlers, fixture server, isolated HOME. No live credentials.
test('cached health and CLI entrypoints reveal degradation without breaking account JSON or blocking questions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-advisor-health-'));
  const requests = [];
  let status = 'healthy';
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health?cached=1') {
      res.statusCode = status === 'degraded' ? 503 : 200;
      res.end(JSON.stringify({ advisor: { status, checked_at: Date.now(), reason: status === 'healthy' ? null : 'Advisor is slow.', alternative: 'Use somewhere docs payments.' } }));
    } else if (req.url === '/v1/auth/whoami') {
      res.end(JSON.stringify({ ok: true, data: { user: { email: 'fixture@example.test', effective_tier: 'free' }, stats: { projects: 0, api_keys: 1 } } }));
    } else if (req.url === '/mcp' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }));
      } else if (message.method === 'tools/call') {
        assert.equal(message.params.name, 'advisor');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'The actual answer.' }] } }));
      } else { res.statusCode = 202; res.end(); }
    } else { res.statusCode = 405; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalUrl = process.env.SOMEWHERE_MCP_URL;
  process.env.SOMEWHERE_MCP_URL = `${base}/mcp`;
  async function command(args) {
    const script = `
      import { Command } from 'commander';
      import { registerAuth } from './src/commands/auth.ts';
      import { registerAdvisor } from './src/commands/advisor.ts';
      import { saveConfig } from './src/lib/config.ts';
      saveConfig({ token: 'smt_fixture_only', user: { email: 'fixture@example.test' } });
      const p = new Command(); registerAuth(p); registerAdvisor(p);
      await p.parseAsync(['node', 'somewhere', ...JSON.parse(process.env.FIXTURE_ARGS)]);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: home, SOMEWHERE_API_URL: `${base}/v1`, FIXTURE_ARGS: JSON.stringify(args) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, err);
    return { out, err };
  }
  try {
    assert.equal((await fetchAdvisorHealth()).status, 'healthy');
    const healthy = await command(['whoami', '--json']);
    assert.equal(JSON.parse(healthy.out).advisor_health.status, 'healthy');
    status = 'degraded';
    const degraded = await command(['whoami', '--json']);
    assert.equal(JSON.parse(degraded.out).user.email, 'fixture@example.test');
    assert.equal(JSON.parse(degraded.out).advisor_health.status, 'degraded');
    const human = await command(['auth', 'status']);
    assert.match(human.out + human.err, /Advisor: degraded/);
    const before = requests.length;
    const answer = await command(['advisor', 'How does this work?', '--json', '--no-context']);
    assert.match(answer.err, /Advisor: degraded.*somewhere docs payments/);
    assert.equal(JSON.parse(answer.out).answer, 'The actual answer.');
    assert.equal(requests[before].path, '/health?cached=1', 'health is visible before the advisor request');
    assert.ok(requests.filter((r) => r.path.startsWith('/health')).every((r) => !r.auth), 'public cached check never carries credentials');
    status = 'invalid';
    assert.equal((await fetchAdvisorHealth()).status, 'unknown');
    process.env.SOMEWHERE_MCP_URL = 'invalid';
    assert.equal((await fetchAdvisorHealth()).status, 'unknown', 'bad status configuration cannot report an account failure');
    assert.match(advisorHealthLine({ status: 'unknown', checked_at: null, reason: null, alternative: 'Use docs.' }), /unknown.*Use docs/);
  } finally {
    if (originalUrl === undefined) delete process.env.SOMEWHERE_MCP_URL; else process.env.SOMEWHERE_MCP_URL = originalUrl;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
