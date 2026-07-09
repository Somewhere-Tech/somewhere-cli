import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function run(args, env) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(
      sourceRunner ?? process.execPath,
      sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args],
      {
      env: { ...process.env, ...env },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('docs docs streams the full document to stdout', async () => {
  const fullDoc = `${'agent-docs\n'.repeat(45_000)}Next.js apps are NOT supported near the end\n`;

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/docs.txt') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(fullDoc));
      res.end(fullDoc);
      return;
    }
    res.statusCode = 404;
    res.end('missing');
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(['docs', 'docs'], {
      SOMEWHERE_DOCS_BASE: `http://127.0.0.1:${port}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      CI: '1',
    });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr:\n${result.stderr}`);
    assert.equal(Buffer.byteLength(result.stdout), Buffer.byteLength(fullDoc));
    assert.equal(result.stdout, fullDoc);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('bare docs streams the full platform reference', async () => {
  const fullDoc = 'full platform reference\n';
  const server = createServer((req, res) => {
    assert.equal(req.url, '/docs.txt');
    res.end(fullDoc);
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(['docs'], {
      SOMEWHERE_DOCS_BASE: `http://127.0.0.1:${port}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      CI: '1',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, fullDoc);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('docs --list keeps the topic menu and docs --json returns an envelope', async () => {
  const list = await run(['docs', '--list'], {
    SOMEWHERE_NO_NOTIFICATIONS: '1',
    CI: '1',
  });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /start\s+Anonymous quickstart/);
  assert.match(list.stdout, /docs\s+Full platform reference/);

  const server = createServer((req, res) => {
    assert.equal(req.url, '/start.txt');
    res.end('quickstart body\n');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(['docs', 'start', '--json'], {
      SOMEWHERE_DOCS_BASE: `http://127.0.0.1:${port}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      CI: '1',
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      topic: 'start',
      url: `http://127.0.0.1:${port}/start.txt`,
      content: 'quickstart body\n',
    });
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
