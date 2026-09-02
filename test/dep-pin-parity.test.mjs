/**
 * `somewhere dev` must resolve React the way deploy does (tsk_0312cf17).
 *
 * The compile image keeps React 19 in its own tree at a lockfile-pinned
 * version and prefers it over installing the app's declared range. Locally that
 * set does not exist, so the compiler floor-pinned the range instead:
 * `react: ^19.2.0` became exactly 19.2.0 while the image served 19.2.7. Same
 * tree, same compiler, two different Reacts — with a third reachable via npm
 * `latest`, since a peer dependency could drag its own copy in.
 *
 * The fix rewrites the install spec rather than adding a second node_modules
 * tree. A separate tree was tried and is worse: a package that physically lives
 * in the dependency cache resolves `react` to its own sibling before any search
 * path is consulted, so the pinned copy gets bundled ALONGSIDE the cache's —
 * two Reacts in one bundle, which is a blank page. One flat tree, like the
 * image has, is the only shape that works.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyImagePins, readVendorManifest } from '../dist/local/compiler.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pins = readVendorManifest(root).toolchain.react19;

test('the image React pins are vendored and exact', () => {
  assert.ok(pins, 'the vendored manifest records the image\'s React set');
  assert.match(pins.react, /^\d+\.\d+\.\d+$/, 'an exact version, not a range');
  assert.match(pins['react-dom'], /^\d+\.\d+\.\d+$/);
});

test('a declared React range installs at the image version, not the range floor', () => {
  // What the compiler asks for, floor-pinned from `^19.2.0`, is `react@19.2.0`.
  const specs = ['react@19.2.0', 'react-dom@19.2.0', 'react-router-dom@7.9.5'];
  assert.deepEqual(applyImagePins(specs, pins), [
    `react@${pins.react}`,
    `react-dom@${pins['react-dom']}`,
    'react-router-dom@7.9.5',
  ]);
});

test('nothing but React is repinned — other dependencies pass through untouched', () => {
  const specs = ['@somewhere-tech/sdk@^0.7.2', 'zustand@5.0.0', 'preact@10.0.0'];
  assert.deepEqual(applyImagePins(specs, pins), specs);
});

test('a scoped package name survives the @-split', () => {
  assert.deepEqual(applyImagePins(['@scope/react@1.0.0'], pins), ['@scope/react@1.0.0']);
});

test('an older manifest with no pins changes nothing', () => {
  const specs = ['react@19.2.0'];
  assert.deepEqual(applyImagePins(specs, {}), specs);
});

test('the local loop keeps ONE React tree — the pins never become a second node_modules', () => {
  // The dual-React regression this file exists to prevent. If the host is ever
  // handed a separate pinned tree again, the cache's own React is bundled
  // beside it. The compiler is asked for no isolated set at all.
  const source = readFileSync(join(root, 'src', 'local', 'compiler.ts'), 'utf8');
  const assigned = source.match(/react19NodeModules:\s*([^,\n]+)/);
  assert.ok(assigned, 'the host still declares react19NodeModules');
  assert.equal(
    assigned[1].trim(),
    'null',
    'the local loop must resolve React inside its single dependency cache — a second pinned '
      + 'tree puts two Reacts in one bundle and renders a blank page',
  );
});
