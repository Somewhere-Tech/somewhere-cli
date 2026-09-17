import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePublicDocsManifest } from '../dist/commands/docs.js';

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

const MANIFEST = {
  version: 1,
  pages: [
    {
      id: 'sw.db', title: 'Database', section: 'data-identity',
      body: 'Canonical database body.\n', anchors: [], provenance: { authored: 'hand' },
    },
    {
      id: 'declared-data', title: 'Declared data — the schema file is the contract', section: 'data-identity',
      body: "Generated client API:\n\n```ts\nimport { data, DataError } from 'somewhere:data'\nawait data.notes.list()\n```\n",
      anchors: [], provenance: { authored: 'hand' },
    },
    {
      id: 'auth-client', title: 'Auth on the client — the correct session code', section: 'data-identity',
      body: "```js\nreturn json(await sw.auth.loginWithCookie(req, b.email, b.password))\n```\n",
      anchors: [], provenance: { authored: 'hand' },
    },
    {
      id: 'setup', title: 'Setup — Install the CLI and connect MCP', section: 'start',
      body: 'Install the CLI, then connect it.\n', anchors: [], provenance: { authored: 'hand' },
    },
    {
      id: 'troubleshooting', title: 'Troubleshooting', section: 'operate',
      body: 'What to do when a deploy fails.\n', anchors: [], provenance: { authored: 'hand' },
    },
    {
      id: 'verify-before-deploy', title: 'Verify before deploy', section: 'start',
      body: 'Flow schema and examples.\n', anchors: [], provenance: { authored: 'hand' },
    },
  ],
};

function manifestServer() {
  return createServer((req, res) => {
    if (req.url === '/docs-manifest.json') {
      assert.match(req.headers['user-agent'] ?? '', /somewhere-cli/);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(MANIFEST));
      return;
    }
    if (req.url === '/start.txt') {
      res.end('quickstart body\n');
      return;
    }
    res.statusCode = 404;
    res.end('missing');
  });
}

async function withManifest(fn) {
  const server = manifestServer();
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
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

test('docs --list discovers public topics and keeps quick links separate', async () => {
  const server = manifestServer();
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const list = await run(['docs', '--list'], {
      SOMEWHERE_DOCS_BASE: `http://127.0.0.1:${port}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      CI: '1',
    });
    assert.equal(list.status, 0);
    assert.match(list.stdout, /Public topics:/);
    assert.match(list.stdout, /declared-data\s+Declared data/);
    assert.match(list.stdout, /auth-client\s+Auth on the client/);
    assert.match(list.stdout, /verify-before-deploy\s+Verify before deploy/);
    assert.match(list.stdout, /Quick links:/);
    assert.match(list.stdout, /start\s+Anonymous quickstart/);

    const listedJson = await run(['docs', '--list', '--json'], {
      SOMEWHERE_DOCS_BASE: `http://127.0.0.1:${port}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      CI: '1',
    });
    const listPayload = JSON.parse(listedJson.stdout);
    assert.ok(listPayload.topics.some((topic) => topic.name === 'declared-data'
      && topic.section === 'data-identity' && topic.source === '/docs-manifest.json'));
    assert.ok(listPayload.quick_links.some((topic) => topic.name === 'start' && topic.path === '/start.txt'));

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

// tsk_926fbf8e — manual topics are public through the generated manifest.
// A topic response must use that page's own body, never prose from a page that
// merely links to it.

/** A HOME with no ~/.somewhere/config.json — the blind-run starting state. */
function emptyCredentialHome() {
  return mkdtempSync(join(tmpdir(), 'sw-docs-nocreds-home-'));
}

test('docs <topic> returns exact manifest pages with NO credential present', async () => {
  const home = emptyCredentialHome();
  await withManifest(async (base) => {
    const declared = await run(['docs', 'declared-data'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_DOCS_BASE: base,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      NO_COLOR: '1',
      CI: '1',
    });
    assert.equal(declared.status, 0, declared.stderr);
    assert.match(declared.stdout, /^# Declared data — the schema file is the contract/);
    assert.match(declared.stdout, /import \{ data, DataError \} from 'somewhere:data'/);
    assert.match(declared.stdout, /await data\.notes\.list\(\)/);
    assert.doesNotMatch(declared.stdout, /Canonical database body/);

    const authClient = await run(['docs', 'auth-client'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_DOCS_BASE: base,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      NO_COLOR: '1',
      CI: '1',
    });
    assert.equal(authClient.status, 0, authClient.stderr);
    assert.match(authClient.stdout, /^# Auth on the client — the correct session code/);
    assert.match(authClient.stdout, /json\(await sw\.auth\.loginWithCookie\(req, b\.email, b\.password\)\)/);
    assert.doesNotMatch(authClient.stdout, /Canonical database body/);
  });
});

test('docs <topic> --json returns the exact public manifest page in an envelope', async () => {
  const home = emptyCredentialHome();
  await withManifest(async (base) => {
    const result = await run(['docs', 'setup', '--json'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_DOCS_BASE: base,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      NO_COLOR: '1',
      CI: '1',
    });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      topic: 'setup',
      url: `${base}/docs-manifest.json`,
      source: 'public',
      content: '# Setup — Install the CLI and connect MCP\n\nInstall the CLI, then connect it.\n',
    });
  });
});

test('an unknown topic names manifest topics instead of demanding a login', async () => {
  const home = emptyCredentialHome();
  await withManifest(async (base) => {
    const result = await run(['docs', 'no-such-topic'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_DOCS_BASE: base,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      NO_COLOR: '1',
      CI: '1',
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Not logged in/);
    assert.match(result.stderr, /No documentation topic named "no-such-topic"/);
    assert.match(result.stderr, /declared-data/);
    assert.match(result.stderr, /auth-client/);
    assert.match(result.stderr, /verify-before-deploy/);
  });
});

test('manifest parsing requires actual page bodies', () => {
  assert.deepEqual(parsePublicDocsManifest(MANIFEST).map(({ id }) => id), MANIFEST.pages.map(({ id }) => id));
  assert.throws(
    () => parsePublicDocsManifest({ pages: [{ id: 'auth-client', title: 'Auth', section: 'data' }] }),
    /missing id, title, section, or body/,
  );
  assert.throws(() => parsePublicDocsManifest({}), /missing its pages array/);
});

test('a manifest page without a body fails precisely instead of substituting another topic', async () => {
  const home = emptyCredentialHome();
  const server = createServer((req, res) => {
    assert.equal(req.url, '/docs-manifest.json');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      pages: [{ id: 'auth-client', title: 'Auth on the client', section: 'data-identity' }],
    }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(['docs', 'auth-client'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_DOCS_BASE: `http://127.0.0.1:${port}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      NO_COLOR: '1',
      CI: '1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /page 0 is missing id, title, section, or body/);
    assert.doesNotMatch(result.stdout + result.stderr, /Canonical database body/);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
