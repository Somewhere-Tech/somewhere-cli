/**
 * Publish-surface fixtures (tsk_c166924f).
 *
 * BOTH directions, per rule 9:
 *   - the rule's TARGET fires: an agent's private notes/logs/transcripts sitting
 *     in the project root are not published, and are named in the output;
 *   - real app shapes are UNCHANGED: five project shapes deploy exactly the set
 *     of keys they deploy today.
 *
 * "Today" is re-derived in-test by `legacyCollect`, which reimplements the
 * pre-rule collector (everything that is not a dotfile, not in IGNORE, not
 * matched by an ignore file). Asserting new == legacy is the byte-identity
 * proof — it fails the moment the rule starts eating an app's files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { collectFiles, classifyKey, IGNORE, MAX_FILE_SIZE } from '../dist/lib/files.js';
import { createHappyPathTemplate } from '../dist/lib/init-template.js';

function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function fixture(files) {
  return write(mkdtempSync(join(tmpdir(), 'sw-publish-')), files);
}

/** The collector as it behaved BEFORE the publish-surface rule. */
function legacyCollect(baseDir, currentDir = baseDir, out = []) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(currentDir, entry.name);
    const rel = relative(baseDir, full).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { legacyCollect(baseDir, full, out); continue; }
    if (!entry.isFile()) continue;
    if (statSync(full).size > MAX_FILE_SIZE) continue;
    out.push(rel);
  }
  return out;
}

function deployedKeys(collected) {
  return [
    ...Object.keys(collected.files),
    ...Object.keys(collected.binaryFiles),
    ...Object.keys(collected.functions),
  ].sort();
}

function legacyKeys(dir) {
  return legacyCollect(dir).map((rel) => classifyKey(rel).key).sort();
}

/** The three root files the PLATFORM already refuses to serve
 *  (worker developer-file protection). Dropping them client-side changes the
 *  upload payload, never the deployed site. */
const PLATFORM_PROTECTED = new Set(['CLAUDE.md', 'AGENTS.md', 'AGENT.md', 'README.md']);

function assertByteIdentical(name, dir) {
  const collected = collectFiles(dir);
  const before = legacyKeys(dir);
  const after = deployedKeys(collected);
  const lost = before.filter((k) => !after.includes(k));
  assert.deepEqual(
    lost.filter((k) => !PLATFORM_PROTECTED.has(k)),
    [],
    `${name}: the publish rule dropped app files: ${lost.join(', ')}`,
  );
  assert.deepEqual(
    after.filter((k) => !before.includes(k)),
    [],
    `${name}: the publish rule invented files`,
  );
  for (const e of collected.excluded) {
    assert.ok(
      PLATFORM_PROTECTED.has(e.path),
      `${name}: unexpected exclusion ${e.path}`,
    );
  }
  return collected;
}

// ── Direction 1: real app shapes are unchanged ──────────────────────────────

test('fixture: the platform starter (0.30.0 journey scaffold) is unchanged', () => {
  const files = {};
  for (const f of createHappyPathTemplate()) files[f.path] = f.content;
  const dir = fixture(files);
  const collected = assertByteIdentical('starter', dir);
  // The scaffold's own agent guides: held back here, already refused server-side.
  assert.deepEqual(
    collected.excluded.map((e) => e.path).sort(),
    ['AGENTS.md', 'CLAUDE.md', 'README.md'],
  );
  assert.ok(collected.files['index.html']);
  assert.ok(collected.files['package.json']);
  assert.ok(collected.functions['api/data.ts']);
});

test('fixture: a plain Vite app is unchanged', () => {
  const dir = fixture({
    'index.html': '<!doctype html><script type="module" src="/src/main.tsx"></script>',
    'package.json': '{"name":"vite-app"}',
    'tsconfig.json': '{}',
    'tsconfig.node.json': '{}',
    'vite.config.ts': 'export default {};',
    'tailwind.config.js': 'export default {};',
    'postcss.config.js': 'export default {};',
    'eslint.config.js': 'export default [];',
    'src/main.tsx': 'import "./index.css";',
    'src/index.css': 'body{}',
    'public/vite.svg': '<svg/>',
  });
  assertByteIdentical('vite', dir);
});

test('fixture: a static site with robots/sitemap/favicon/.well-known is unchanged', () => {
  const dir = fixture({
    'index.html': '<!doctype html><link rel="stylesheet" href="/style.css">',
    'about.html': '<!doctype html>',
    'style.css': 'body{}',
    'robots.txt': 'User-agent: *\nAllow: /\n',
    'humans.txt': 'chef',
    'sitemap.xml': '<urlset/>',
    'favicon.ico': 'icon',
    'site.webmanifest': '{}',
    '_redirects': '/old /new 301',
    'images/hero.png': 'png',
    '.well-known/security.txt': 'Contact: mailto:a@b.c',
  });
  const collected = assertByteIdentical('static-site', dir);
  assert.ok(collected.files['robots.txt']);
  assert.ok(collected.files['sitemap.xml']);
  assert.ok(collected.binaryFiles['favicon.ico']);
  assert.ok(collected.binaryFiles['images/hero.png']);
  // `.well-known/` is a dot-directory: the collector has never uploaded it and
  // still does not. Documented here so the next reader does not "fix" it by
  // accident — changing it is a separate, deliberate change.
  assert.equal(collected.files['.well-known/security.txt'], undefined);
});

test('fixture: a functions-only project is unchanged', () => {
  const dir = fixture({
    'package.json': '{"name":"api-only"}',
    'api/health.ts': 'export default async () => new Response("ok");',
    'api/_lib/db.ts': 'export const x = 1;',
    'db/schema.sql': 'CREATE TABLE t (id TEXT);',
  });
  const collected = assertByteIdentical('functions-only', dir);
  assert.ok(collected.functions['api/health.ts']);
  assert.ok(collected.functions['api/_lib/db.ts']);
  assert.ok(collected.files['db/schema.sql']);
});

test('fixture: an unreferenced-looking root file that IS referenced still ships', () => {
  const dir = fixture({
    'index.html': '<!doctype html><script type="module" src="/src/main.js"></script>',
    'package.json': '{}',
    'src/main.js': 'fetch("/pricing.yaml").then(r => r.text());',
    'pricing.yaml': 'pro: 20',
    // Same extension, nothing points at it — this one is the tester's scratch.
    'scratch.yaml': 'notes: private',
  });
  const collected = collectFiles(dir);
  assert.ok(collected.files['pricing.yaml'], 'a referenced root file must still publish');
  assert.deepEqual(collected.excluded.map((e) => e.path), ['scratch.yaml']);
});

// ── Direction 2: the rule's target fires ────────────────────────────────────

test('the run-2 shape: private notes are not published, and are named', () => {
  const dir = fixture({
    'index.html': '<!doctype html><div id="root"></div>',
    'package.json': '{"name":"team-links"}',
    'src/App.tsx': 'export const App = () => null;',
    'api/links.ts': 'export default async () => new Response("[]");',
    'NOTES.md': 'account uzairhaq+codexblind0902b@gmail.com\nfull evaluation log\n',
    'TODO.md': '- ship it',
    'design-doc.md': 'the plan',
    'run.log': 'deploy 200',
    'codex-transcript.jsonl': '{"event":1}',
    'notes.txt': 'scratch',
  });
  const collected = collectFiles(dir);
  const excluded = collected.excluded.map((e) => e.path).sort();
  assert.deepEqual(excluded, [
    'NOTES.md', 'TODO.md', 'codex-transcript.jsonl', 'design-doc.md', 'notes.txt', 'run.log',
  ]);
  for (const p of excluded) {
    assert.equal(collected.files[p], undefined, `${p} must not be published`);
    assert.match(collected.excluded.find((e) => e.path === p).reason, /--include/);
  }
  // The app itself is untouched.
  assert.ok(collected.files['index.html']);
  assert.ok(collected.files['package.json']);
  assert.ok(collected.files['src/App.tsx']);
  assert.ok(collected.functions['api/links.ts']);
});

test('--include publishes a held-back file on purpose', () => {
  const dir = fixture({
    'index.html': '<!doctype html>',
    'CHANGELOG.md': '# 1.0',
    'NOTES.md': 'private',
  });
  const collected = collectFiles(dir, { include: ['CHANGELOG.md'] });
  assert.ok(collected.files['CHANGELOG.md']);
  assert.equal(collected.files['NOTES.md'], undefined);
  assert.deepEqual(collected.excluded.map((e) => e.path), ['NOTES.md']);
});

test('a "!" line in .somewhereignore publishes a held-back file permanently', () => {
  const dir = fixture({
    'index.html': '<!doctype html>',
    'CHANGELOG.md': '# 1.0',
    'NOTES.md': 'private',
    '.somewhereignore': '!CHANGELOG.md\n',
  });
  const collected = collectFiles(dir);
  assert.ok(collected.files['CHANGELOG.md']);
  assert.deepEqual(collected.excluded.map((e) => e.path), ['NOTES.md']);
});

test('an ignore file still wins: a listed file is never even considered', () => {
  const dir = fixture({
    'index.html': '<!doctype html>',
    'NOTES.md': 'private',
    '.gitignore': 'NOTES.md\n',
  });
  const collected = collectFiles(dir);
  assert.equal(collected.files['NOTES.md'], undefined);
  assert.deepEqual(collected.excluded, [], 'ignored files are not re-reported as excluded');
});

test('nested notes keep todays behavior — the rule is root-scoped', () => {
  const dir = fixture({
    'index.html': '<!doctype html>',
    'docs/NOTES.md': 'nested notes still ship, exactly as before',
  });
  const collected = collectFiles(dir);
  assert.ok(collected.files['docs/NOTES.md']);
  assert.deepEqual(collected.excluded, []);
});
