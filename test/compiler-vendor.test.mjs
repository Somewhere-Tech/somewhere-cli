/**
 * The vendored compiler is the platform's compiler, unmodified.
 *
 * `somewhere dev` claims "same app, same data, same build". The claim rests
 * entirely on runtime/compiler/ being a byte-for-byte copy of what the compile
 * container runs. A hand-edit here — a quick local fix, a merge that resolved
 * the wrong way — would silently make the local loop a DIFFERENT compiler
 * while every message still promised parity. That is the single worst failure
 * this feature can have, because it is invisible: the page still renders.
 *
 * So the vendor step records each file's sha256 and the monorepo commit in
 * VENDOR.json, and this asserts the shipped copy still hashes to it. Re-sync
 * with `node scripts/extract-runtime.mjs <monorepo>`; never edit runtime/
 * by hand.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const compilerDir = join(root, 'runtime', 'compiler');
const manifest = JSON.parse(readFileSync(join(compilerDir, 'VENDOR.json'), 'utf8'));

test('every vendored compiler file matches the hash the vendor step recorded', () => {
  assert.ok(Object.keys(manifest.files).length >= 3, 'the manifest lists the compiler files');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = join(compilerDir, name);
    assert.ok(existsSync(path), `${name} is present in runtime/compiler/`);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(
      actual,
      expected,
      `runtime/compiler/${name} was modified after vendoring. The local dev loop must run the platform's ` +
        'compiler unchanged — re-sync with `node scripts/extract-runtime.mjs <monorepo>` instead of editing it.',
    );
  }
});

test('the CLI runs the exact esbuild version the compile container pins', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // esbuild-wasm, not native esbuild: the published CLI bundles every
  // production dependency inside its signed artifact, and native esbuild ships
  // 24 optional PLATFORM packages of which only the build machine's own can
  // ever be installed. The VERSION still has to match exactly — esbuild is the
  // compiler, and a different version emits different bytes.
  assert.equal(
    pkg.dependencies['esbuild-wasm'],
    manifest.esbuild,
    'the CLI must pin esbuild-wasm at the container\'s exact esbuild version',
  );
  assert.ok(
    pkg.bundledDependencies.includes('esbuild-wasm'),
    'esbuild-wasm must be bundled, like every other production dependency',
  );
  assert.equal(pkg.dependencies.esbuild, undefined, 'native esbuild must not be a CLI dependency');
});

test('the vendored core exposes the host contract the CLI builds against', async () => {
  const { createRequire } = await import('node:module');
  const core = createRequire(join(compilerDir, 'compile-core.cjs'))('./compile-core.cjs');
  assert.equal(typeof core.createCompileCore, 'function', 'createCompileCore is the factory the CLI calls');
  // The pure exports the CLI reads WITHOUT constructing a host (it needs
  // detectTailwind to know which Tailwind engine to cache before it can build
  // one). If these stop being module-scope exports, the CLI cannot prepare.
  assert.equal(typeof core.detectTailwind, 'function');
  assert.equal(typeof core.isFunctionPath, 'function');
  assert.equal(typeof core.sourceDigest, 'function');
});

test('the vendored toolchain pins are complete', () => {
  // The compiler treats typescript/postcss/autoprefixer/tailwind as its OWN
  // machinery and refuses to install them from the app's package.json, so the
  // CLI has to supply the container's exact versions. A missing pin here means
  // the local loop would compile with whatever npm resolved today.
  for (const group of ['base', 'tw3', 'tw4']) {
    const pins = manifest.toolchain[group];
    assert.ok(pins && Object.keys(pins).length, `toolchain group ${group} is pinned`);
    for (const [name, range] of Object.entries(pins)) {
      assert.equal(typeof range, 'string', `${group}/${name} has a version range`);
      assert.ok(range.length > 0, `${group}/${name} range is not empty`);
    }
  }
  assert.equal(manifest.toolchain.base.typescript !== undefined, true);
  assert.equal(manifest.toolchain.tw3.tailwindcss !== undefined, true);
});
