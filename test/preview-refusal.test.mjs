import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('wrong-account preview emits only a typed refusal and never the caller project inventory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-preview-refusal-home-'));
  const source = mkdtempSync(join(tmpdir(), 'sw-preview-refusal-source-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_preview_refusal',
    user: { email: 'wrong-account@example.com', username: 'wrong-account' },
  }) + '\n');
  writeFileSync(join(source, 'index.html'), '<h1>must not upload</h1>\n');

  const requests = [];
  const inventory = 'private-one → proj_secret_one\nprivate-two → proj_secret_two';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      requests.push({ method: req.method, path: url.pathname });
      if (req.method === 'GET' && url.pathname === '/v1/projects/other-account/notices') {
        sendJson(res, { ok: true, data: { project_id: 'other-account', notices: [] } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/mcp') {
        const rpc = JSON.parse(body);
        if (rpc.method === 'initialize') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'preview-refusal-test', version: '1.0.0' },
            },
          });
          return;
        }
        if (rpc.method === 'notifications/initialized') {
          sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
          return;
        }
        if (rpc.method === 'tools/call') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: 'TOOL_ERROR',
                  message: `Project "other-account" not found. Your projects:\n${inventory}`,
                }),
              }],
            },
          });
          return;
        }
      }
      sendJson(res, { ok: false, error: 'NOT_FOUND', message: url.pathname }, 404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const env = {
    HOME: home,
    USERPROFILE: home,
    SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
    SOMEWHERE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
  };
  try {
    const human = await run(['preview', '--project', 'other-account'], source, env);
    assert.equal(human.status, 1);
    assert.match(human.stderr, /^✗ PROJECT_NOT_FOUND: Project not found or you do not have access/m);
    assert.doesNotMatch(`${human.stdout}\n${human.stderr}`, /private-one|private-two|proj_secret|Your projects/);

    const json = await run(['preview', '--project', 'other-account', '--json'], source, env);
    assert.equal(json.status, 1);
    assert.equal(json.stderr, '');
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: false,
      error: 'PROJECT_NOT_FOUND',
      message: 'Project not found or you do not have access to it. Nothing was created or changed.',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(
    requests.some((request) => request.method === 'POST' && request.path === '/v1/deploy'),
    false,
    'the refusal must happen before a deploy write',
  );
});

async function runTypedPreviewRefusal({ projectData, statusData, expected }) {
  const home = mkdtempSync(join(tmpdir(), 'sw-preview-typed-home-'));
  const source = mkdtempSync(join(tmpdir(), 'sw-preview-typed-source-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_preview_typed',
    user: { email: 'preview@example.com', username: 'preview' },
  }) + '\n');
  writeFileSync(join(source, 'index.html'), '<h1>must not upload</h1>\n');

  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      requests.push({ method: req.method, path: url.pathname });
      if (req.method === 'GET' && url.pathname === '/v1/projects/preview-project/notices') {
        sendJson(res, { ok: true, data: { project_id: 'preview-project', notices: [] } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/mcp') {
        const rpc = JSON.parse(body);
        if (rpc.method === 'initialize') {
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'preview-typed-test', version: '1.0.0' },
            },
          });
          return;
        }
        if (rpc.method === 'notifications/initialized') {
          sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
          return;
        }
        if (rpc.method === 'tools/call') {
          const data = rpc.params?.name === 'project_get' ? projectData : statusData;
          sendJson(res, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] },
          });
          return;
        }
      }
      sendJson(res, { ok: false, error: 'NOT_FOUND', message: url.pathname }, 404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await run(['preview', '--project', 'preview-project', '--json'], source, {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
      SOMEWHERE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(
    requests.some((request) => request.method === 'POST' && request.path === '/v1/deploy'),
    false,
    'a typed preview refusal must happen before a deploy write',
  );
}

test('preview --json preserves the typed plan refusal', async () => {
  await runTypedPreviewRefusal({
    projectData: { cloud_dev_allowed: false },
    statusData: { published: true, active_release_id: 'rel_unused' },
    expected: {
      ok: false,
      error: 'CLOUD_DEV_NOT_ENABLED',
      message: '`somewhere preview` is available on the Pro and Scale plans. This account is on a plan that does not include it.',
    },
  });
});

test('preview --json preserves the typed publish-consent refusal', async () => {
  await runTypedPreviewRefusal({
    projectData: { cloud_dev_allowed: true },
    statusData: { published: false, active_release_id: null },
    expected: {
      ok: false,
      error: 'PUBLISH_CONSENT_REQUIRED',
      message: 'This project has never been published, so a preview has no live version to build on. Re-run with --publish-first to publish deliberately. Nothing was created or changed.',
    },
  });
});
