import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// Real command handlers, fixture server, isolated HOME. No live credentials.
test('account and advisor commands perform no synthetic health preflight', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-advisor-health-'));
  const requests = [];let durableResumes=0;
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/auth/whoami') {
      res.end(JSON.stringify({ ok: true, data: { user: { email: 'fixture@example.test', effective_tier: 'free' }, stats: { projects: 0, api_keys: 1 } } }));
    } else if (req.url === '/mcp' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }));
      } else if (message.method === 'tools/call') {
        assert.equal(message.params.name, 'advisor');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: message.params.arguments.question.startsWith('Durable')?JSON.stringify({run_id:'00000000-0000-4000-8000-000000000002',status:'prepared',next_step:'resume'}):'The actual answer.' }] } }));
      } else { res.statusCode = 202; res.end(); }
    } else if(req.url==='/advisor'){res.end(JSON.stringify({ok:true,data:{run_id:'00000000-0000-4000-8000-000000000003',status:'prepared',next_step:'resume',anonymous_capability:'f'.repeat(64)}}));
    } else if(req.url==='/advisor/runs/00000000-0000-4000-8000-000000000003/resume'){durableResumes++;assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-advisor-capability'],'f'.repeat(64));const saved=readdirSync(join(home,'.somewhere','advisor-runs')).map(file=>JSON.parse(readFileSync(join(home,'.somewhere','advisor-runs',file),'utf8')));assert.ok(saved.some(record=>record.run_id==='00000000-0000-4000-8000-000000000003'&&record.owner_mode==='anonymous'));res.end(JSON.stringify({ok:true,data:{run_id:'00000000-0000-4000-8000-000000000003',status:'settled',answer:'The durable anonymous answer.',incomplete:false}}));
    } else if(req.url==='/advisor/runs/00000000-0000-4000-8000-000000000002/resume'){durableResumes++;const saved=readdirSync(join(home,'.somewhere','advisor-runs')).map(file=>JSON.parse(readFileSync(join(home,'.somewhere','advisor-runs',file),'utf8')));assert.ok(saved.some(record=>record.run_id==='00000000-0000-4000-8000-000000000002'),'Prepared handle persisted before paid resume');res.end(JSON.stringify({ok:true,data:{run_id:'00000000-0000-4000-8000-000000000002',status:'settled',answer:'The durable answer.',incomplete:false}}));
    } else { res.statusCode = 405; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalUrl = process.env.SOMEWHERE_MCP_URL;
  process.env.SOMEWHERE_MCP_URL = `${base}/mcp`;
  async function command(args, anonymous=false) {
    const script = `
      import { Command } from 'commander';
      import { registerAuth } from './dist/commands/auth.js';
      import { registerAdvisor } from './dist/commands/advisor.js';
      import { saveConfig,clearConfig } from './dist/lib/config.js';
      if(process.env.FIXTURE_ANONYMOUS==='true')clearConfig();else saveConfig({ token: 'smt_fixture_only', user: { email: 'fixture@example.test' } });
      const p = new Command(); registerAuth(p); registerAdvisor(p);
      await p.parseAsync(['node', 'somewhere', ...JSON.parse(process.env.FIXTURE_ARGS)]);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: home, SOMEWHERE_API_URL: `${base}/v1`, FIXTURE_ARGS: JSON.stringify(args),FIXTURE_ANONYMOUS:String(anonymous) },
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
    const account = await command(['whoami', '--json']);
    assert.equal(JSON.parse(account.out).user.email, 'fixture@example.test');
    assert.equal(JSON.parse(account.out).advisor_health, undefined);
    await command(['auth', 'status']);
    const answer = await command(['advisor', 'How do I deploy?', '--no-context']);
    assert.match(answer.out, /The actual answer/);
    assert.doesNotMatch(account.err + answer.err, /Advisor:|health check/);
    const durable=await command(['advisor','Durable generic question','--no-context']);assert.match(durable.out,/The durable answer/);assert.equal(durableResumes,1);const anonymous=await command(['advisor','Durable anonymous generic question','--no-context'],true);assert.match(anonymous.out,/The durable anonymous answer/);assert.equal(durableResumes,2);assert.equal(anonymous.out.includes('f'.repeat(64)),false);
    assert.ok(requests.some(r => r.path === '/mcp'));
    assert.ok(requests.every(r => !r.path.startsWith('/health')), 'no health fetch on account or actual advisor calls');
  } finally {
    if (originalUrl === undefined) delete process.env.SOMEWHERE_MCP_URL; else process.env.SOMEWHERE_MCP_URL = originalUrl;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
