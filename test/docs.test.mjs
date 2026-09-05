import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findPublicTopicSection,
  publicTopicKeys,
} from '../dist/commands/docs.js';

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

// tsk_926fbf8e — `somewhere docs <topic>` was login-gated for every topic that
// is not one of the six whole-document shortcuts: the unknown-topic branch went
// straight to the authenticated platform tool, whose token read exits the
// process with "Not logged in". The docs are public, so the front door must
// answer with no credential at all.

/** The public corpus shape: a topic library where `---` separates topics and
 *  each topic heading ends with its key in parentheses. */
const CORPUS = [
  '# somewhere.tech — llms-full.txt',
  '',
  '# Topic library',
  '',
  '## sw.db — Database (sw.db)',
  '',
  'Database body.',
  '',
  '## sw.fs.versions(path)',
  '',
  'A method heading, not a topic.',
  '',
  '---',
  '',
  '## Setup — Install the CLI and connect MCP (setup)',
  '',
  'Install the CLI, then connect it.',
  '',
  '---',
  '',
  '## Conflict check (collaborated projects)',
  '',
  'Prose parentheses, not a topic key — a subsection of setup.',
  '',
  '---',
  '',
  '## Troubleshooting — Common errors (troubleshooting)',
  '',
  'What to do when a deploy fails.',
  '',
].join('\n');

function corpusServer() {
  const server = createServer((req, res) => {
    if (req.url === '/llms-full.txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(CORPUS);
      return;
    }
    res.statusCode = 404;
    res.end('missing');
  });
  return server;
}

async function withCorpus(fn) {
  const server = corpusServer();
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

/** A HOME with no ~/.somewhere/config.json — the blind-run starting state. */
function emptyCredentialHome() {
  return mkdtempSync(join(tmpdir(), 'sw-docs-nocreds-home-'));
}

test('docs <topic> answers from the public corpus with NO credential present', async () => {
  const home = emptyCredentialHome();
  await withCorpus(async (base) => {
    for (const topic of ['setup', 'troubleshooting', 'sw.db']) {
      const result = await run(['docs', topic], {
        HOME: home,
        USERPROFILE: home,
        SOMEWHERE_DOCS_BASE: base,
        SOMEWHERE_NO_NOTIFICATIONS: '1',
        NO_COLOR: '1',
        CI: '1',
      });
      assert.equal(
        result.status,
        0,
        `docs ${topic} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.doesNotMatch(result.stderr, /Not logged in/);
      assert.doesNotMatch(result.stdout, /Not logged in/);
      assert.ok(result.stdout.includes(`(${topic})`), `topic heading missing:\n${result.stdout}`);
    }
  });
});

test('docs <topic> --json returns the public section in an envelope, unauthenticated', async () => {
  const home = emptyCredentialHome();
  await withCorpus(async (base) => {
    const result = await run(['docs', 'setup', '--json'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_DOCS_BASE: base,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      NO_COLOR: '1',
      CI: '1',
    });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.topic, 'setup');
    assert.equal(parsed.source, 'public');
    assert.match(parsed.content, /Install the CLI, then connect it\./);
  });
});

test('docs sw.db leads with every structured-write signature and one call example', async () => {
  const home = emptyCredentialHome();
  await withCorpus(async (base) => {
    const result = await run(['docs', 'sw.db'], {
      HOME: home,
      USERPROFILE: home,
      SOMEWHERE_DOCS_BASE: base,
      SOMEWHERE_NO_NOTIFICATIONS: '1',
      NO_COLOR: '1',
      CI: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    const first120 = result.stdout.split('\n').slice(0, 120).join('\n');
    assert.match(first120, /sw\.db\.insert\(table, values/);
    assert.match(first120, /sw\.db\.update\(table, \{ set, where\? \}\)/);
    assert.match(first120, /sw\.db\.remove\(table, \{ where\? \}\)/);
    assert.match(first120, /await sw\.db\.update\('notes'/);
  });
});

test('an unknown topic names the public topics instead of demanding a login', async () => {
  const home = emptyCredentialHome();
  await withCorpus(async (base) => {
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
    assert.match(result.stderr, /setup/);
    assert.match(result.stderr, /troubleshooting/);
  });
});

test('topic sections are cut on the corpus separator, not on method headings', () => {
  const setup = findPublicTopicSection(CORPUS, 'setup');
  assert.ok(setup);
  assert.equal(setup.key, 'setup');
  assert.match(setup.body, /Install the CLI, then connect it\./);
  // A `---` rule only ends a topic when a real topic heading follows it, so a
  // prose-parenthesis subsection stays inside the topic that owns it.
  assert.match(setup.body, /Prose parentheses/);
  assert.doesNotMatch(setup.body, /What to do when a deploy fails/);

  const db = findPublicTopicSection(CORPUS, 'SW.DB');
  assert.ok(db, 'topic lookup is case-insensitive');
  assert.equal(db.key, 'sw.db');
  assert.match(db.body, /Database body\./);

  assert.equal(findPublicTopicSection(CORPUS, 'path'), null, 'a method heading is not a topic');
  assert.deepEqual(publicTopicKeys(CORPUS), ['sw.db', 'setup', 'troubleshooting']);
});
