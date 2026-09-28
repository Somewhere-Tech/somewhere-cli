import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { collectFiles } from '../dist/lib/files.js';
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const root = mkdtempSync(join(tmpdir(), 'anonymous-init-'));
let requests = [], refuse = false;
const project = { id: 'fixture-project', name: 'Fixture', subdomain: 'fixture', slug: 'fixture' };
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  assert.equal(req.headers.authorization, 'Bearer smt_fixture');
  res.writeHead(refuse ? 403 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(refuse ? { ok: false, error: 'FORBIDDEN', message: 'Fixture refusal' }
    : { ok: true, data: req.method === 'GET' ? { projects: [project] } : project }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
test.after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
async function run(args, { token, prepare } = {}) {
  requests = [];
  const base = mkdtempSync(join(root, 'case-')), cwd = join(base, 'app'), config = join(base, 'config'), bin = join(base, 'bin');
  for (const dir of [cwd, config, bin]) mkdirSync(dir);
  if (token) writeFileSync(join(config, 'config.json'), JSON.stringify({ token }));
  // Only a sentinel, never npm: authenticated init's existing install call is observed locally.
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf fixture > "$PWD/install-called"\n', { mode: 0o700 });
  prepare?.(cwd);
  const output = await new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'init', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, HOME: base, USERPROFILE: base, SOMEWHERE_CONFIG_DIR: config,
      SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}`, PATH: `${bin}:${process.env.PATH}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', v => stdout += v); child.stderr.on('data', v => stderr += v);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  return { ...output, cwd, config, base };
}
for (const selection of [[], ['--template', 'minimal'], ['--features', 'private-data', '--ui', 'headless']]) {
  test(`anonymous init writes valid raw starter without account, requests or install: ${selection.join(' ') || 'default'}`, async () => {
    const result = await run(['--name', 'starter', '--json', ...selection]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.local, true); assert.equal(body.linked, false); assert.equal(body.dependencies_installed, false);
    assert.equal(body.project_id, undefined); assert.ok(body.next.includes('somewhere deploy'));
    assert.deepEqual(requests, []); assert.deepEqual(readdirSync(result.config).filter(name => name !== 'last-run.json'), []);
    for (const path of ['.somewhere.json', '.mcp.json', 'node_modules', 'install-called', 'dist', 'build']) assert.equal(existsSync(join(result.cwd, path)), false, path);
    assert.equal(existsSync(join(result.base, '.claude.json')), false);
    const collected = collectFiles(result.cwd);
    assert.ok(collected.files['index.html']); assert.ok(Object.keys(collected.files).some(p => p.endsWith('.tsx')));
    for (const [path, content] of Object.entries(collected.files)) {
      if (!/\.tsx?$/.test(path)) continue;
      const output = ts.transpileModule(content, { fileName: path, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
      assert.deepEqual(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), [], path);
    }
  });
}
test('anonymous human result directs to existing temporary deploy and full quickstart', async () => {
  const result = await run(['--name', 'starter']);
  assert.equal(result.status, 0); assert.match(result.stdout, /somewhere deploy/); assert.match(result.stdout, /somewhere docs start/);
  assert.deepEqual(requests, []);
});
test('anonymous link/bare/project flags never bypass account authority', async () => {
  for (const args of [['--link', '--project', 'fixture'], ['--bare', '--name', 'fixture'], ['--project', 'fixture', '--name', 'fixture']]) {
    const result = await run([...args, '--json']);
    assert.notEqual(result.status, 0); assert.deepEqual(readdirSync(result.cwd), []); assert.deepEqual(requests, []);
  }
});
test('anonymous init preserves occupied, linked and malformed-link directories', async () => {
  for (const [path, content] of [['keep.txt', 'mine'], ['.somewhere.json', JSON.stringify({ project_id: 'existing', name: 'Existing' })], ['.somewhere.json', '{broken']]) {
    const result = await run(['--name', 'starter', '--json'], { prepare: dir => writeFileSync(join(dir, path), content) });
    assert.notEqual(result.status, 0); assert.deepEqual(readdirSync(result.cwd), [path]);
    assert.equal(readFileSync(join(result.cwd, path), 'utf8'), content); assert.deepEqual(requests, []);
  }
});
test('authenticated create retains remote creation, linking and install behavior', async () => {
  const result = await run(['--name', 'fixture', '--json'], { token: 'smt_fixture' });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(JSON.parse(result.stdout).id, project.id);
  assert.deepEqual(requests, ['POST /projects']);
  assert.equal(JSON.parse(readFileSync(join(result.cwd, '.somewhere.json'))).project_id, project.id);
  assert.ok(existsSync(join(result.cwd, 'install-called'))); assert.ok(existsSync(join(result.cwd, 'index.html')));
});
test('authenticated link uses only owned project lookup; server denial writes nothing', async () => {
  const linked = await run(['--link', '--project', 'fixture', '--json'], { token: 'smt_fixture' });
  assert.equal(linked.status, 0, linked.stderr); assert.deepEqual(requests, ['GET /projects']);
  assert.equal(existsSync(join(linked.cwd, 'index.html')), false);
  refuse = true;
  try {
    const rejected = await run(['--name', 'fixture', '--json'], { token: 'smt_fixture' });
    assert.notEqual(rejected.status, 0); assert.deepEqual(readdirSync(rejected.cwd), []);
    assert.deepEqual(requests, ['POST /projects']);
  } finally { refuse = false; }
});
