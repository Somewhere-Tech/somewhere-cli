import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Command } from 'commander';
import { validateCheckRunInput } from './fixtures/check-run-server-contract.mjs';

// client.ts reads BASE_URL at module load — point it at the mock server before
// the first import (check.js imports client.js transitively).
let lastRequest = null;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastRequest = {
      method: req.method,
      url: req.url,
      auth: req.headers['authorization'],
      body: body ? JSON.parse(body) : null,
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: { ok: true, build_log: ['compiled'] } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.SOMEWHERE_API_URL = `http://127.0.0.1:${port}`;

const { ApiClient, CliApiError } = await import('../dist/lib/client.js');
const { buildCheckBody, buildCheckRunBody, checkErrorsToCliError, checkRunExitCode, checkRunPath, formatCheckRunResult,
  formatCompileOnlySuccess, registerCheck } =
  await import('../dist/commands/check.js');

const collected = (over = {}) => ({ files: {}, binaryFiles: {}, functions: {}, ...over });

test('buildCheckBody: always carries project_id + files', () => {
  assert.deepEqual(buildCheckBody(collected({ files: { 'index.html': '<html>' } }), 'p1'), {
    project_id: 'p1',
    files: { 'index.html': '<html>' },
  });
});

test('buildCheckBody: includes functions/binary_files only when non-empty', () => {
  const body = buildCheckBody(
    collected({
      files: { 'index.html': 'x' },
      functions: { 'api/hello.ts': 'export default () => {}' },
      binaryFiles: { 'logo.png': 'AAAA' },
    }),
    'p1',
  );
  assert.deepEqual(body.functions, { 'api/hello.ts': 'export default () => {}' });
  assert.deepEqual(body.binary_files, { 'logo.png': 'AAAA' });

  // Empty buckets are omitted entirely.
  const bare = buildCheckBody(collected({ files: { 'a.html': 'x' } }), 'p1');
  assert.equal('functions' in bare, false);
  assert.equal('binary_files' in bare, false);
});

test('buildCheckRunBody: matches the captured worker validator contract', () => {
  const body = buildCheckRunBody(collected({
    files: { 'a.html': 'x' },
    functions: { 'api/hello.ts': 'export default () => new Response()' },
  }), 'p1', {
    path: '/api/hello?mode=full',
    method: 'POST',
    body: '{"name":"Ada"}',
  });
  const parsed = validateCheckRunInput(body);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    project_id: 'p1',
    functions: { 'api/hello.ts': 'export default () => new Response()' },
    path: '/api/hello?mode=full',
    method: 'POST',
    headers: undefined,
    body: '{"name":"Ada"}',
    timeout_ms: 10_000,
  });
  assert.equal('target' in body, false);
  assert.equal('files' in body, false);
});

test('checkRunPath: places -q in the path consumed by validateInvokeInput', () => {
  assert.equal(checkRunPath('api/hello', 'a=1&b=two'), '/api/hello?a=1&b=two');
  assert.equal(checkRunPath('/api/hello?existing=1', '?a=2'), '/api/hello?existing=1&a=2');
  assert.equal(checkRunPath('/api/hello', ''), '/api/hello');
});

test('request shape: dry compile POSTs /deploy/check with the source tree', async () => {
  lastRequest = null;
  const client = new ApiClient('smt_test_key');
  await client.call('POST', '/deploy/check', buildCheckBody(collected({ files: { 'a.html': 'x' } }), 'p1'));

  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.url, '/deploy/check');
  assert.equal(lastRequest.auth, 'Bearer smt_test_key');
  assert.deepEqual(lastRequest.body, { project_id: 'p1', files: { 'a.html': 'x' } });
});

test('request shape: --run POSTs the top-level worker contract', async () => {
  lastRequest = null;
  const client = new ApiClient('smt_test_key');
  await client.call(
    'POST',
    '/deploy/check/run',
    buildCheckRunBody(
      collected({ files: { 'a.html': 'x' }, functions: { 'api/hello.ts': 'export default () => new Response()' } }),
      'p1',
      { path: '/api/hello?a=1', method: 'POST', body: '{"ok":true}' },
    ),
  );

  assert.equal(lastRequest.url, '/deploy/check/run');
  assert.deepEqual(lastRequest.body, {
    project_id: 'p1',
    functions: { 'api/hello.ts': 'export default () => new Response()' },
    path: '/api/hello?a=1',
    method: 'POST',
    body: '{"ok":true}',
  });
});

test('checkErrorsToCliError: errors-as-data maps to a renderable BUILD_ERROR', () => {
  const err = checkErrorsToCliError({
    ok: false,
    errors: [{ file: 'api/hello.ts', line: 2, column: 9, code: 'TS2304', message: "Cannot find name 'x'." }],
    build_log: ['compiled with errors'],
  });
  assert.ok(err instanceof CliApiError);
  assert.equal(err.code, 'BUILD_ERROR');
  assert.equal(err.data.errors.length, 1);
  assert.equal(err.data.errors[0].file, 'api/hello.ts');
});

test('checkErrorsToCliError: a clean (or empty) verdict returns null', () => {
  assert.equal(checkErrorsToCliError({ ok: true }), null);
  assert.equal(checkErrorsToCliError({ ok: false, errors: [] }), null);
  assert.equal(checkErrorsToCliError(undefined), null);
});

test('formatCheckRunResult: renders logs + status + body', () => {
  const lines = formatCheckRunResult({
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    },
    logs: [{ level: 'log', message: 'hi' }],
    duration_ms: 12,
  });
  const out = lines.join('\n');
  assert.match(out, /Logs/);
  assert.match(out, /\[log\] hi/);
  assert.match(out, /200/);
  assert.match(out, /\{"ok":true\}/);
});

test('formatCheckRunResult: a thrown handler is reported, not swallowed', () => {
  const lines = formatCheckRunResult({
    response: null,
    errors: [{ code: 'TypeError', message: 'boom', stack: 'stack fixture' }],
    duration_ms: 9,
  });
  assert.match(lines.join('\n'), /Handler error: TypeError: boom/);
  assert.match(lines.join('\n'), /stack fixture/);
  assert.match(lines.join('\n'), /9ms/);
});

test('authentic nested --run fixtures share one human/JSON exit verdict', () => {
  const response = (status) => ({
    response: {
      status,
      headers: { 'content-type': 'application/json', 'x-fixture': String(status) },
      body: JSON.stringify({ status }),
    },
    logs: [{ level: 'log', message: `status ${status}` }],
    errors: status >= 500 ? [{ message: `Draft handler returned HTTP ${status}.` }] : [],
    served: 'function',
    isolated_db: true,
    duration_ms: 7,
  });
  const fixtures = [
    { name: 'nested 200', result: response(200), exit: 0 },
    { name: 'nested 401', result: response(401), exit: 1 },
    { name: 'nested 403', result: response(403), exit: 1 },
    { name: 'nested 500', result: response(500), exit: 1 },
    {
      name: 'handler throw',
      result: { response: null, errors: [{ code: 'HANDLER_ERROR', message: 'boom' }], logs: [], duration_ms: 4 },
      exit: 1,
    },
    {
      name: 'compile failure',
      result: { ok: false, errors: [{ file: 'api/a.ts', line: 1, message: 'bad syntax' }] },
      exit: 1,
    },
  ];

  for (const fixture of fixtures) {
    const humanExit = checkRunExitCode(fixture.result);
    const jsonExit = checkRunExitCode(JSON.parse(JSON.stringify(fixture.result)));
    assert.equal(humanExit, fixture.exit, `${fixture.name} human exit`);
    assert.equal(jsonExit, fixture.exit, `${fixture.name} JSON exit`);
  }

  const ok = fixtures[0].result;
  assert.equal(ok.response.headers['x-fixture'], '200');
  assert.equal(ok.response.body, '{"status":200}');
  assert.equal(ok.logs[0].message, 'status 200');
  assert.equal(ok.duration_ms, 7);
});

test('compile-only success names what passed and points to a real flow check', () => {
  const output = formatCompileOnlySuccess(3, 2048).join('\n');
  assert.match(output, /Platform compile passed/);
  assert.match(output, /Runtime behavior, auth, data access, and user flows were not exercised/);
  assert.match(output, /somewhere verify --url https:\/\/your-app\.somewhere\.site --flow flow\.json/);
  assert.match(output, /somewhere advisor "<question>"/);
  assert.doesNotMatch(output, /safe to deploy|oracle/i);
});

test('deploy-check help distinguishes compile-only mode from explicit --run execution', () => {
  const program = new Command();
  registerCheck(program);
  const command = program.commands.find((candidate) => candidate.name() === 'deploy-check');
  assert.ok(command);
  const help = command.helpInformation();
  assert.match(help, /no\s+deploy, promote, or runtime request/);
  assert.match(help, /does not exercise functions,\s+auth, data access, or browser flows/);
  assert.match(help, /--run <path>[\s\S]+Check one handler from collected function source\s+\(default\s+GET\)/);
  assert.match(help, /static\/client files are not checked/i);
  assert.match(help, /can write data or call services/);
  assert.match(help, /Exits nonzero\s+for handler preparation errors, handler errors,\s+and HTTP 4xx\/5xx/);
  assert.doesNotMatch(help, /safe to deploy|oracle/i);
});

test.after(() => server.close());
