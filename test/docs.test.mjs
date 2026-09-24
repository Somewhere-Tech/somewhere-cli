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

const SECTIONED_BODY = 'Lead.\n\n## Reads\n\nfrom() rows.\n\n### Where\n\nwhere shapes.\n\n## Writes\n\ninsert().\n';
const readsStart = SECTIONED_BODY.indexOf('## Reads');
const writesStart = SECTIONED_BODY.indexOf('## Writes');
const SECTIONED_PAGE = {
  id: 'sw.data', title: 'Data', section: 'data-identity',
  body: SECTIONED_BODY,
  summary: '[docs] topic=sw.data view=summary complete=false\nLead.\nreads · Reads\nwrites · Writes\n',
  summary_complete: false,
  sections: [
    { id: 'reads', heading: '## Reads', level: 2, start: readsStart, end: writesStart },
    { id: 'where', heading: '### Where', level: 3, start: SECTIONED_BODY.indexOf('### Where'), end: writesStart },
    { id: 'writes', heading: '## Writes', level: 2, start: writesStart, end: SECTIONED_BODY.length },
  ],
  anchors: [], provenance: { authored: 'hand' },
};

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
      body: 'What to do when a deploy fails.\n', summary_complete: true,
      anchors: [], provenance: { authored: 'hand' },
    },
    {
      id: 'verify-before-deploy', title: 'Verify before deploy', section: 'start',
      body: 'Flow schema and examples.\n', anchors: [], provenance: { authored: 'hand' },
    },
    SECTIONED_PAGE,
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

test('public docs default to the published summary; --full and --section retrieve the rest', async () => {
  const home = emptyCredentialHome();
  const env = (base) => ({
    HOME: home,
    USERPROFILE: home,
    SOMEWHERE_DOCS_BASE: base,
    SOMEWHERE_NO_NOTIFICATIONS: '1',
    NO_COLOR: '1',
    CI: '1',
  });
  await withManifest(async (base) => {
    const summary = await run(['docs', 'sw.data'], env(base));
    assert.equal(summary.status, 0, summary.stderr);
    assert.equal(summary.stdout, SECTIONED_PAGE.summary);

    const full = await run(['docs', 'sw.data', '--full', '--json'], env(base));
    assert.equal(full.status, 0, full.stderr);
    const fullPayload = JSON.parse(full.stdout);
    assert.equal(fullPayload.content, `# Data\n\n${SECTIONED_BODY}`);
    assert.equal(fullPayload.complete, true);

    const section = await run(['docs', 'sw.data', '--section', 'reads'], env(base));
    assert.equal(section.status, 0, section.stderr);
    assert.equal(section.stdout, SECTIONED_BODY.slice(readsStart, writesStart));
    assert.match(section.stdout, /### Where/, 'a section includes its nested subsections');
    assert.doesNotMatch(section.stdout, /insert\(\)/);

    const unknown = await run(['docs', 'sw.data', '--section', 'nope', '--json'], env(base));
    assert.equal(unknown.status, 0, unknown.stderr);
    const unknownPayload = JSON.parse(unknown.stdout);
    assert.equal(unknownPayload.complete, false);
    assert.match(unknownPayload.content, /No section "nope" in sw\.data[\s\S]*writes · Writes/);
    assert.doesNotMatch(unknownPayload.content, /insert\(\)/, 'an unknown section never dumps the page');

    // An older manifest has neither summary nor sections: never print less than the page.
    const byHeading = await run(['docs', 'sw.data', '--section', 'Writes'], env(base));
    assert.equal(byHeading.stdout, SECTIONED_BODY.slice(writesStart));

    // A small topic publishes summary_complete without a summary: the body is the complete view.
    const small = await run(['docs', 'troubleshooting', '--json'], env(base));
    const smallPayload = JSON.parse(small.stdout);
    assert.equal(smallPayload.content, '# Troubleshooting\n\nWhat to do when a deploy fails.\n');
    assert.equal(smallPayload.complete, true);

    const legacy = await run(['docs', 'sw.db', '--section', 'reads'], env(base));
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(legacy.stdout, '# Database\n\nCanonical database body.\n');
    assert.match(legacy.stderr, /no section index/);
    const legacyDefault = await run(['docs', 'sw.db'], env(base));
    assert.equal(legacyDefault.stdout, '# Database\n\nCanonical database body.\n');

    const quickLink = await run(['docs', 'start', '--section', 'reads'], env(base));
    assert.equal(quickLink.status, 1);
    assert.match(quickLink.stderr, /somewhere docs --list/);
  });
});
