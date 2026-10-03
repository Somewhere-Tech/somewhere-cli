// tsk_0a027a93: `somewhere call <tool> '{}'` in a linked directory runs against
// the linked project, as the first-class commands do. An explicit project_id
// always wins; account-wide results need --all-projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseCallScope } from '../dist/commands/call.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const LINKED = { project_id: '11111111-2222-3333-4444-555555555555', name: 'crew', subdomain: 'crew-race-fd02' };
const withProject = { name: 'cron_list', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } } };
const withoutProject = { name: 'domain_check', inputSchema: { type: 'object', properties: { domain: { type: 'string' } } } };

test('scope rules: explicit wins, linked injects, --all-projects opts out, unlinked and project-less tools are untouched', () => {
  assert.deepEqual(chooseCallScope({ project_id: 'other' }, LINKED, false, withProject), { kind: 'explicit' });
  const linked = chooseCallScope({ limit: 5 }, LINKED, false, withProject);
  assert.equal(linked.kind, 'linked');
  assert.deepEqual(linked.args, { limit: 5, project_id: LINKED.project_id });
  assert.match(linked.note, /linked project crew-race-fd02/);
  assert.deepEqual(chooseCallScope({}, LINKED, true, withProject), { kind: 'account', reason: 'all-projects' });
  assert.deepEqual(chooseCallScope({}, null, false, withProject), { kind: 'account', reason: 'not-linked' });
  assert.deepEqual(chooseCallScope({}, LINKED, false, withoutProject), { kind: 'account', reason: 'no-project-arg' });
  assert.deepEqual(chooseCallScope({}, LINKED, false, undefined), { kind: 'account', reason: 'no-project-arg' });
  assert.throws(() => chooseCallScope({ project_id: 'x' }, LINKED, true, withProject), /not both/);
});

function sendJson(res, payload) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('the CLI sends the linked project for cron_list, keeps an explicit one, and lists everything only with --all-projects', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-call-linked-home-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_call_linked_test', user: { email: 't@example.com' } }));
  const appDir = mkdtempSync(join(tmpdir(), 'sw-call-linked-app-'));
  writeFileSync(join(appDir, '.somewhere.json'), JSON.stringify(LINKED));
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      if (rpc.method === 'initialize') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
      } else if (rpc.method === 'tools/list') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ ...withProject, description: 'List crons' }, { ...withoutProject, description: 'Check a domain' }] } });
      } else if (rpc.method === 'tools/call') {
        calls.push({ name: rpc.params.name, arguments: rpc.params.arguments });
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { crons: [] } }) }] } });
      } else {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
      }
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const env = { ...process.env, HOME: home, USERPROFILE: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), SOMEWHERE_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' };
  const run = (args) => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd: appDir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
  try {
    const scoped = await run(['call', 'cron_list', '{}']);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.deepEqual(calls.at(-1), { name: 'cron_list', arguments: { project_id: LINKED.project_id } });
    assert.match(scoped.stderr, /Using the linked project crew-race-fd02/);

    const explicit = await run(['call', 'cron_list', '{"project_id":"another-app"}']);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(calls.at(-1).arguments, { project_id: 'another-app' });
    assert.doesNotMatch(explicit.stderr, /linked project/);

    const everything = await run(['call', 'cron_list', '{}', '--all-projects']);
    assert.equal(everything.status, 0, everything.stderr);
    assert.deepEqual(calls.at(-1).arguments, {});

    const noProjectArg = await run(['call', 'domain_check', '{"domain":"example.com"}']);
    assert.equal(noProjectArg.status, 0, noProjectArg.stderr);
    assert.deepEqual(calls.at(-1).arguments, { domain: 'example.com' });
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
