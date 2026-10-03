import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePublicDocsManifest, renderPublicDocsView } from '../dist/commands/docs.js';

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
      env: { ...process.env, ...env, SOMEWHERE_CONFIG_DIR: env.SOMEWHERE_CONFIG_DIR ?? join(env.HOME ?? emptyCredentialHome(), '.somewhere') },
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

function manifestServer(manifest = MANIFEST) {
  return createServer((req, res) => {
    if (req.url === '/docs-manifest.json') {
      assert.match(req.headers['user-agent'] ?? '', /somewhere-cli/);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(manifest));
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

async function withManifest(fn, manifest = MANIFEST) {
  const server = manifestServer(manifest);
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

test('docs --full with no topic streams the full platform reference', async () => {
  const fullDoc = 'full platform reference\n';
  const server = createServer((req, res) => {
    assert.equal(req.url, '/docs.txt');
    res.end(fullDoc);
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const result = await run(['docs', '--full'], {
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

test('an unknown topic names closest topics instead of demanding a login', async () => {
  const home = emptyCredentialHome();
  await withManifest(async (base) => {
    const result = await run(['docs', 'declared-dat'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_DOCS_BASE: base,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      NO_COLOR: '1',
      CI: '1',
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Not logged in/);
    assert.match(result.stderr, /No documentation topic named "declared-dat"/);
    assert.match(result.stderr, /declared-data/);
    assert.match(result.stderr, /Run: somewhere docs declared-data/);
    assert.equal(result.stdout, '');
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
    assert.equal(unknown.status, 1, unknown.stderr);
    const unknownPayload = JSON.parse(unknown.stdout);
    assert.equal(unknownPayload.ok, false);
    assert.equal(unknownPayload.error, 'DOCS_SECTION_NOT_FOUND');
    assert.equal(unknownPayload.content, undefined);
    assert.match(unknownPayload.hint, /somewhere docs sw.data --section/);
    assert.equal(unknown.stderr, '');

    const byHeading = await run(['docs', 'sw.data', '--section', 'Writes'], env(base));
    assert.equal(byHeading.stdout, SECTIONED_BODY.slice(writesStart));

    // A small topic publishes summary_complete without a summary: the body is the complete view.
    const small = await run(['docs', 'troubleshooting', '--json'], env(base));
    const smallPayload = JSON.parse(small.stdout);
    assert.equal(smallPayload.content, '# Troubleshooting\n\nWhat to do when a deploy fails.\n');
    assert.equal(smallPayload.complete, true);

    const legacy = await run(['docs', 'sw.db', '--section', 'reads'], env(base));
    assert.equal(legacy.status, 1, legacy.stderr);
    assert.equal(legacy.stdout, '');
    assert.match(legacy.stderr, /No usable section index/);
    assert.match(legacy.stderr, /somewhere docs sw.db --full/);
    const legacyDefault = await run(['docs', 'sw.db'], env(base));
    assert.equal(legacyDefault.stdout, '# Database\n\nCanonical database body.\n');

    const quickLink = await run(['docs', 'start', '--section', 'reads'], env(base));
    assert.equal(quickLink.status, 1);
    assert.match(quickLink.stderr, /somewhere docs start --full/);
  });
});


function largePage(size = 14000) {
  const prefix = 'Opening page prose.\n\n';
  const lead = '## Database rows and app responses\n\nParent lead.\n\n';
  const child = '### Query rows\n\n```ts\nawait data.notes.list()\n```\n';
  const tail = '### Query rows\n\nSecond child with a duplicate heading.\n\n';
  const body = prefix + lead + child + 'x'.repeat(size - lead.length - tail.length - child.length) + '\n\n' + tail + '## Next\n\nNext topic.\n';
  const start = prefix.length, childStart = start + lead.length;
  const tailStart = body.indexOf(tail), end = body.indexOf('## Next');
  return {
    id: 'sw.db', title: 'Database', section: 'data', body,
    sections: [
      { id: 'database-rows-and-app-responses', heading: '## Database rows and app responses', start, end },
      { id: 'query-rows', heading: '### Query rows', start: childStart, end: tailStart },
      { id: 'query-rows-2', heading: '### Query rows', start: tailStart, end },
      { id: 'next', heading: '## Next', start: end, end: body.length },
    ],
  };
}

test('large parent uses page offsets and natural child ids; leaves and 12000-char parents stay exact', () => {
  const page = largePage();
  const parent = renderPublicDocsView(page, { kind: 'section', id: 'database-rows-and-app-responses' });
  assert.match(parent.content, /^## Database rows and app responses\n\nParent lead/);
  assert.match(parent.content, /- query-rows ·/);
  assert.match(parent.content, /- query-rows-2 ·/);
  assert.match(parent.content, /somewhere docs sw.db --section <id>/);
  assert.doesNotMatch(parent.content, /Opening page|await data|Second child|Next topic/);
  assert.ok(parent.content.length < 1000);
  assert.equal(parent.complete, false);
  const leaf = renderPublicDocsView(page, { kind: 'section', id: 'query-rows' });
  assert.equal(leaf.content, page.body.slice(page.sections[1].start, page.sections[1].end));
  assert.ok(leaf.content.length > 12000, 'a large leaf is never arbitrarily truncated');
  assert.match(leaf.content, /```ts\nawait data.notes.list\(\)\n```/);
  const duplicate = renderPublicDocsView(page, { kind: 'section', id: 'query-rows-2' });
  assert.equal(duplicate.content, page.body.slice(page.sections[2].start, page.sections[2].end));
  const atLimit = largePage(12000);
  const exact = renderPublicDocsView(atLimit, { kind: 'section', id: 'database-rows-and-app-responses' });
  assert.equal(exact.content, atLimit.body.slice(atLimit.sections[0].start, atLimit.sections[0].end));
  assert.match(renderPublicDocsView(largePage(12001), { kind: 'section', id: 'database-rows-and-app-responses' }).content, /its subsections/);
  assert.equal(renderPublicDocsView(page, { kind: 'full' }).content, `# Database\n\n${page.body}`);
});

test('absent, empty and invalid indexes fail without including body; defaults and full remain usable', () => {
  for (const sections of [undefined, [], [{ id: 'bad', heading: '## Bad', start: -1, end: 999 }], [{ id: '', heading: '## Bad', start: 0, end: 10 }]]) {
    const page = { id: 'small', title: 'Small', section: null, body: 'Complete short page.\n', summary_complete: true, sections };
    const result = renderPublicDocsView(page, { kind: 'section', id: 'bad' });
    assert.equal(result.failure.error, 'DOCS_SECTION_INDEX_UNAVAILABLE');
    assert.equal(result.content, '');
    assert.equal(result.complete, false);
    assert.equal(renderPublicDocsView(page, { kind: 'default' }).complete, true);
    assert.match(renderPublicDocsView(largePage(12001), { kind: 'section', id: 'database-rows-and-app-responses' }).content, /its subsections/);
  assert.equal(renderPublicDocsView(page, { kind: 'full' }).content, '# Small\n\nComplete short page.\n');
  }
});

test('plain and JSON recovery are bounded, deterministic and executable without model calls', async () => {
  const home = emptyCredentialHome();
  await withManifest(async (base) => {
    const env = { HOME: home, SOMEWHERE_DOCS_BASE: base, SOMEWHERE_NO_NOTIFICATIONS: '1', NO_COLOR: '1', CI: '1' };
    for (const json of [false, true]) {
      for (const [args, code, hint] of [
        [['sw.data', '--section', 'readz'], 'DOCS_SECTION_NOT_FOUND', 'somewhere docs sw.data --section reads'],
        [['sw.data', '--section', ''], 'DOCS_SECTION_NOT_FOUND', 'somewhere docs sw.data --section'],
        [['sw.db', '--section', 'reads'], 'DOCS_SECTION_INDEX_UNAVAILABLE', 'somewhere docs sw.db --full'],
        [['declared-dat'], 'DOCS_TOPIC_NOT_FOUND', 'somewhere docs declared-data'],
        [['How do I build a notes app?'], 'DOCS_TOPIC_NOT_FOUND', 'somewhere advisor "How do I build a notes app?"'],
      ]) {
        const result = await run(['docs', ...args, ...(json ? ['--json'] : [])], env);
        assert.equal(result.status, 1);
        if (json) {
          const payload = JSON.parse(result.stdout);
          assert.equal(payload.ok, false);
          assert.equal(payload.error, code);
          assert.ok(payload.hint.includes(hint));
          assert.equal(payload.content, undefined);
          assert.equal(result.stderr, '');
          if (args[0] === 'declared-dat') assert.equal(payload.matches[0], 'declared-data');
          if (args[2] === 'readz') assert.equal(payload.matches[0], 'reads');
        } else {
          assert.equal(result.stdout, '');
          assert.ok(result.stderr.includes(hint), result.stderr);
        }
        assert.doesNotMatch(result.stdout + result.stderr, /docs --ask|Canonical database body|insert\(\)/);
      }
    }
  });
});

test('authenticated sections stay on MCP; failures, old full responses and missing sections recover publicly', async () => {
  const home = emptyCredentialHome();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'smt_fixture_only' }));
  let response = '[docs] topic=sw.data view=section complete=false\n## Reads\n\nAuthenticated rows.\n';
  let fail = false;
  const calls = [], publicRequests = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/docs-manifest.json') {
      publicRequests.push(req.url);
      res.end(JSON.stringify(MANIFEST));
    } else if (req.url === '/mcp' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }));
      } else if (message.method === 'tools/call') {
        assert.equal(message.params.name, 'docs');
        calls.push(message.params.arguments);
        if (fail) { res.statusCode = 503; res.end('{}'); }
        else res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: response }] } }));
      } else { res.statusCode = 202; res.end(); }
    } else { res.statusCode = 405; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { HOME: home, SOMEWHERE_CONFIG_DIR: home, SOMEWHERE_DOCS_BASE: base, SOMEWHERE_MCP_URL: `${base}/mcp`, SOMEWHERE_NO_NOTIFICATIONS: '1', NO_COLOR: '1', CI: '1' };
  try {
    for (const json of [false, true]) {
      const result = await run(['docs', 'sw.data', '--section', 'reads', ...(json ? ['--json'] : [])], env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(json ? JSON.parse(result.stdout).content : result.stdout, response);
    }
    assert.equal(publicRequests.length, 0);
    assert.deepEqual(calls[0], { topic: 'sw.data', section: 'reads' });
    for (const old of ['Whole old page.\n', '[docs] topic=sw.data view=full complete=true\nWhole page.\n']) {
      response = old;
      const result = await run(['docs', 'sw.data', '--section', 'reads', '--json'], env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).source, 'public');
      assert.equal(JSON.parse(result.stdout).content, SECTIONED_BODY.slice(readsStart, writesStart));
    }
    response = '[docs] topic=sw.data view=section complete=false\nNo section "readz" in sw.data.\n';
    const missing = await run(['docs', 'sw.data', '--section', 'readz', '--json'], env);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).error, 'DOCS_SECTION_NOT_FOUND');
    response = 'Topic \"declared-dat\" not found.\n\nAvailable topics: full manifest ids.\n';
    const unknownTopic = await run(['docs', 'declared-dat', '--json'], env);
    assert.equal(unknownTopic.status, 1);
    assert.equal(JSON.parse(unknownTopic.stdout).error, 'DOCS_TOPIC_NOT_FOUND');
    assert.doesNotMatch(unknownTopic.stdout, /Available topics/);
    fail = true;
    const fallback = await run(['docs', 'sw.data', '--full', '--json'], env);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(JSON.parse(fallback.stdout).content, `# Data\n\n${SECTIONED_BODY}`);
    assert.deepEqual(calls.at(-1), { topic: 'sw.data', detail: 'full' });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});


test('public command bounds large parents in JSON/plain while exact leaves and full remain retrievable', async () => {
  const home = emptyCredentialHome(), page = largePage();
  await withManifest(async (base) => {
    const env = { HOME: home, SOMEWHERE_DOCS_BASE: base, SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1' };
    for (const json of [false, true]) {
      for (const args of [['--section', 'database-rows-and-app-responses'], ['--section', 'query-rows-2'], ['--full']]) {
        const result = await run(['docs', 'sw.db', ...args, ...(json ? ['--json'] : [])], env);
        assert.equal(result.status, 0, result.stderr);
        const content = json ? JSON.parse(result.stdout).content : result.stdout;
        if (args[1] === 'database-rows-and-app-responses') {
          assert.ok(content.length < 1000);
          assert.doesNotMatch(content, /await data/);
          assert.match(content, /query-rows-2/);
        } else if (args[1] === 'query-rows-2') {
          assert.equal(content, page.body.slice(page.sections[2].start, page.sections[2].end));
        } else assert.equal(content, `# Database\n\n${page.body}`);
      }
    }
  }, { pages: [page] });
});
