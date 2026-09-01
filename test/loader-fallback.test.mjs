/**
 * A local function can import a package the PROJECT never installed.
 *
 * The frontend half of `somewhere dev` needs no npm install — the compiler
 * resolves the app's declared dependencies into the CLI's own cache. The
 * function half loads through Node's ESM resolver, which looks only in the
 * project's node_modules, so on a fresh scaffold the page rendered perfectly
 * and every api/ route 500'd with ERR_MODULE_NOT_FOUND (tsk_3269026d). Half a
 * loop is worse than none: it looks like it started correctly.
 *
 * The resolve hook now falls back to the compiler's search path. The project's
 * own node_modules must still WIN — a fallback that overrode the project's copy
 * would silently run different code locally than on deploy.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { installLoader, entryUrl } from '../dist/local/loader.js';

/** Write a tiny ESM package into `<dir>/node_modules/<name>`. */
function writePackage(dir, name, body) {
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js' },
  }));
  writeFileSync(join(pkgDir, 'index.js'), body);
}

test('a function resolves a package from the CLI cache when the project has none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-loader-project-'));
  const cache = mkdtempSync(join(tmpdir(), 'sw-loader-cache-'));
  try {
    writePackage(cache, 'sw-fixture-only-in-cache', "export const origin = 'cache';\n");
    // The project has NO node_modules at all — the fresh-scaffold case.
    writeFileSync(join(root, 'handler.mjs'), [
      "import { origin } from 'sw-fixture-only-in-cache';",
      'export default origin;',
    ].join('\n'));

    installLoader(root, [join(cache, 'node_modules')]);
    const mod = await import(entryUrl(join(root, 'handler.mjs')));
    assert.equal(mod.default, 'cache', 'the cached copy resolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("the project's own copy wins over the cache", async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-loader-project-'));
  const cache = mkdtempSync(join(tmpdir(), 'sw-loader-cache-'));
  try {
    // Same package name in both. The project installed it deliberately; running
    // the cache's copy instead would mean local and deploy execute different
    // code, which is the one thing this loop must never do.
    writePackage(root, 'sw-fixture-in-both', "export const origin = 'project';\n");
    writePackage(cache, 'sw-fixture-in-both', "export const origin = 'cache';\n");
    writeFileSync(join(root, 'handler.mjs'), [
      "import { origin } from 'sw-fixture-in-both';",
      'export default origin;',
    ].join('\n'));

    installLoader(root, [join(cache, 'node_modules')]);
    const mod = await import(entryUrl(join(root, 'handler.mjs')));
    assert.equal(mod.default, 'project', "the project's installed copy takes priority");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test('a package in neither place still fails with Node\'s own clear error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-loader-project-'));
  const cache = mkdtempSync(join(tmpdir(), 'sw-loader-cache-'));
  try {
    mkdirSync(join(cache, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'handler.mjs'), "import 'sw-fixture-nowhere';\nexport default 1;\n");
    installLoader(root, [join(cache, 'node_modules')]);
    await assert.rejects(
      import(entryUrl(join(root, 'handler.mjs'))),
      // The fallback must not swallow a genuinely missing package into some
      // vaguer failure — the developer needs the name.
      (err) => err.code === 'ERR_MODULE_NOT_FOUND' && /sw-fixture-nowhere/.test(err.message),
      'a truly missing package still reports its name',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test('files outside the project are left entirely to Node', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'sw-loader-outside-'));
  const root = mkdtempSync(join(tmpdir(), 'sw-loader-project-'));
  const cache = mkdtempSync(join(tmpdir(), 'sw-loader-cache-'));
  try {
    writePackage(cache, 'sw-fixture-cache-scoped', "export const origin = 'cache';\n");
    // A module OUTSIDE the project root must not gain access to the project's
    // dependency cache — the hook is scoped to the project on purpose.
    writeFileSync(join(outside, 'stranger.mjs'), "import 'sw-fixture-cache-scoped';\nexport default 1;\n");
    installLoader(root, [join(cache, 'node_modules')]);
    await assert.rejects(
      import(pathToFileURL(join(outside, 'stranger.mjs')).href),
      (err) => err.code === 'ERR_MODULE_NOT_FOUND',
      'the cache is not on the resolution path for files outside the project',
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
