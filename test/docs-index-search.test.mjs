// tsk_a86f8a12: bare `somewhere docs` prints the topic index (not the
// 18k-line manual), `somewhere docs search <term>` finds sections, and
// tsk_f681c871: docs warn when they describe a newer CLI than the one running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { renderDocsIndex, searchPublicDocs, parsePublicDocsGroups } from '../dist/commands/docs.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const installed = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

const AUTH_BODY = 'Sign-in overview.\n\n## Magic links\n\nSend a magic link with sw.auth.sendMagicLink(email).\n\n### Expiry\n\nA magic link expires after 15 minutes.\n\n## Passwords\n\nPassword sign-in.\n';
const at = (text) => AUTH_BODY.indexOf(text);
const MANIFEST = {
  version: 1,
  sections: [
    { id: 'primitives', title: 'Primitives', pages: ['sw.auth', 'cron'] },
  ],
  pages: [
    {
      id: 'sw.auth', title: 'Auth — sign-in for your users', section: 'primitives', body: AUTH_BODY,
      sections: [
        { id: 'magic-links', heading: '## Magic links', start: at('## Magic links'), end: at('## Passwords') },
        { id: 'expiry', heading: '### Expiry', start: at('### Expiry'), end: at('## Passwords') },
        { id: 'passwords', heading: '## Passwords', start: at('## Passwords'), end: AUTH_BODY.length },
      ],
    },
    { id: 'cron', title: 'Cron — scheduled triggers', section: 'primitives', body: 'Schedules run in UTC.\n' },
    { id: 'search', title: 'Search — full-text search', section: 'primitives', body: 'Index documents with sw.search.\n' },
  ],
};

function run(args, env = {}) {
  return new Promise((resolvePromise) => {
    const home = mkdtempSync(join(tmpdir(), 'sw-docs-index-home-'));
    const child = spawn(process.execPath, [distIndex, ...args], {
      env: { ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), CI: '1', NO_COLOR: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function withServer(fn) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/docs-manifest.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(MANIFEST));
      return;
    }
    res.statusCode = 404;
    res.end('missing');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

test('bare docs prints the grouped topic index and how to open, never the manual', async () => {
  await withServer(async (base, requests) => {
    const result = await run(['docs'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests, ['/docs-manifest.json'], 'the full manual (/docs.txt) is not fetched');
    assert.match(result.stdout, /Primitives\n {2}sw\.auth\s+Auth — sign-in for your users/);
    assert.match(result.stdout, /Open a section: {3}somewhere docs <topic> --section <id>/);
    assert.match(result.stdout, /Search all docs: {2}somewhere docs search <term>/);
    assert.match(result.stdout, /Full manual: +somewhere docs --full/);
  });
});

test('docs search returns topic, section id, snippet and the command that opens it', async () => {
  await withServer(async (base) => {
    const result = await run(['docs', 'search', 'magic', 'link', '--json'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.query, 'magic link');
    assert.ok(body.count >= 2);
    assert.deepEqual(body.results.map(({ topic, section }) => `${topic}#${section}`).sort(), ['sw.auth#expiry', 'sw.auth#magic-links']);
    const expiry = body.results.find((r) => r.section === 'expiry');
    assert.match(expiry.snippet, /expires after 15 minutes/);
    assert.equal(expiry.open, 'somewhere docs sw.auth --section expiry');

    const text = await run(['docs', 'search', 'UTC'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^cron {2}Cron — scheduled triggers\n {2}Schedules run in UTC\.\n {2}somewhere docs cron --full/m);

    const none = await run(['docs', 'search', 'zebra'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /No docs sections mention "zebra"/);
  });
});

test('`docs search` with no term still opens the search topic; stray arguments are refused', async () => {
  await withServer(async (base) => {
    const topic = await run(['docs', 'search'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(topic.status, 0, topic.stderr);
    assert.match(topic.stdout, /Index documents with sw\.search/);
    const stray = await run(['docs', 'sw.auth', 'extra'], { SOMEWHERE_DOCS_BASE: base });
    assert.equal(stray.status, 1);
    assert.match(stray.stderr, /Unexpected argument "extra".*somewhere docs search extra/);
  });
});

test('docs warn when they describe a newer minor CLI, and stay quiet for a patch gap', async () => {
  const [major, minor, patch] = installed.split('.').map(Number);
  await withServer(async (base) => {
    for (const [latest, warns] of [[`${major}.${minor + 1}.0`, true], [`${major}.${minor}.${patch + 1}`, false]]) {
      const home = mkdtempSync(join(tmpdir(), 'sw-docs-version-home-'));
      mkdirSync(join(home, '.somewhere'), { recursive: true });
      writeFileSync(join(home, '.somewhere', 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest }));
      const result = await run(['docs', '--list'], {
        SOMEWHERE_DOCS_BASE: base, HOME: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), SOMEWHERE_NO_NOTIFICATIONS: '', CI: '',
      });
      assert.equal(result.status, 0, result.stderr);
      if (warns) {
        assert.match(result.stderr, new RegExp(`These docs describe somewhere CLI ${latest.replace(/\./g, '\\.')}; this CLI is ${installed.replace(/\./g, '\\.')}`));
        assert.match(result.stderr, /npm i -g @somewhere-tech\/cli@latest/);
      } else {
        assert.doesNotMatch(result.stderr, /These docs describe/);
      }
    }
  });
});

test('index and search helpers: ungrouped manifests still list every topic', () => {
  const pages = MANIFEST.pages;
  const index = renderDocsIndex(pages, parsePublicDocsGroups({}));
  assert.match(index, /Topics\n {2}sw\.auth/);
  assert.match(index, / {2}search +Search — full-text search/);
  assert.deepEqual(searchPublicDocs(pages, '   '), []);
  assert.equal(searchPublicDocs(pages, 'PASSWORD')[0].section, 'passwords', 'case-insensitive, innermost section');
});
