import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyPublishedVersion,
  releaseInputsDiffer,
} from '../scripts/version-guard.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('version guard accepts unrelated descendants and rejects release-input drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'somewhere-version-guard-'));
  try {
    git(root, 'init', '--quiet', '--initial-branch=master');
    git(root, 'config', 'user.name', 'Version Guard Test');
    git(root, 'config', 'user.email', 'version-guard@example.test');
    git(root, 'config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'server'));
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}\n');
    writeFileSync(join(root, 'npm-shrinkwrap.json'), '{"version":"1.0.0"}\n');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'server', 'index.mjs'), 'export const server = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'published release');
    const publishedHead = git(root, 'rev-parse', 'HEAD');

    writeFileSync(join(root, 'server', 'index.mjs'), 'export const server = 2;\n');
    git(root, 'add', 'server/index.mjs');
    git(root, 'commit', '-m', 'server-only descendant');
    const serverHead = git(root, 'rev-parse', 'HEAD');
    assert.equal(releaseInputsDiffer(publishedHead, serverHead, root), false);
    assert.equal(classifyPublishedVersion(publishedHead, serverHead, false), 'in-sync');

    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 2;\n');
    git(root, 'add', 'src/index.ts');
    git(root, 'commit', '-m', 'cli source drift');
    const cliHead = git(root, 'rev-parse', 'HEAD');
    assert.equal(releaseInputsDiffer(publishedHead, cliHead, root), true);
    assert.equal(classifyPublishedVersion(publishedHead, cliHead, true), 'drift');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version guard releases an unpublished version and accepts its exact published head', () => {
  const head = 'a'.repeat(40);
  assert.equal(classifyPublishedVersion(undefined, head, false), 'release');
  assert.equal(classifyPublishedVersion(head, head, false), 'in-sync');
});
