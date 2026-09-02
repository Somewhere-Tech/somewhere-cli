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
const manifest = readVendorManifest(root);
const pins = manifest.toolchain.react19;
const baked = manifest.toolchain.baked;
// The container's own order: the baked tree first, the isolated React 19 set
// only when the baked React 18 does not satisfy the pin.
const groups = [baked ?? {}, pins ?? {}];

test('the image React pins are vendored and exact', () => {
  assert.ok(pins, 'the vendored manifest records the image\'s React set');
  assert.match(pins.react, /^\d+\.\d+\.\d+$/, 'an exact version, not a range');
  assert.match(pins['react-dom'], /^\d+\.\d+\.\d+$/);
});

test('the whole baked set is vendored at exact versions (tsk_a8cb3d23)', () => {
  // Not just React. `ensureDeps` prefers a baked copy for ANY dependency whose
  // declared range the baked version satisfies, so the local loop needs every
  // one of them or it floor-pins where deploy serves the image's copy.
  assert.ok(baked && Object.keys(baked).length > 5, 'the manifest records the image\'s baked set');
  for (const [name, version] of Object.entries(baked)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:[-+].*)?$/, `${name} is pinned to an exact version`);
  }
  // The long-tail libraries the image bakes for the hot path.
  for (const name of ['react-router-dom', 'zod', 'zustand', 'date-fns', 'lucide-react']) {
    assert.ok(baked[name], `${name} is part of the vendored baked set`);
  }
});

test('a declared React range installs at the image version, not the range floor', () => {
  // What the compiler asks for, floor-pinned from `^19.2.0`, is `react@19.2.0`.
  const specs = ['react@19.2.0', 'react-dom@19.2.0'];
  const deps = { react: '^19.2.0', 'react-dom': '^19.2.0' };
  assert.deepEqual(applyImagePins(specs, deps, groups), [
    `react@${pins.react}`,
    `react-dom@${pins['react-dom']}`,
  ]);
});

test('a baked long-tail dependency installs at the image version too', () => {
  // The general case of the React bug: `zod: ^3.23.0` floor-pinned to 3.23.0
  // locally while the image served its own baked copy.
  const range = `^${baked.zod.split('.')[0]}.0.0`;
  assert.deepEqual(applyImagePins(['zod@3.0.0'], { zod: range }, groups), [`zod@${baked.zod}`]);
});

test('a pin is only taken when the image version SATISFIES the declared range', () => {
  // The image bakes react-router-dom 6.x. A project on 7 must not be dragged
  // back to 6 — the container would not do it either (bakedSatisfies), and a
  // build that works today must not start failing (repo rule 9).
  assert.deepEqual(
    applyImagePins(['react-router-dom@7.9.5'], { 'react-router-dom': '^7.9.5' }, groups),
    ['react-router-dom@7.9.5'],
  );
  // An exact pin the image cannot serve is left exactly as declared.
  assert.deepEqual(applyImagePins(['react@19.1.0'], { react: '19.1.0' }, groups), ['react@19.1.0']);
});

test('an unprovable range is never repinned', () => {
  // The core's own one-directional bias: anything semver cannot prove — a git
  // spec, an alias, `latest` — falls back to the spec the core produced.
  for (const range of ['latest', 'github:me/react', 'npm:preact@10']) {
    assert.deepEqual(applyImagePins(['react@19.2.0'], { react: range }, groups), ['react@19.2.0']);
  }
});

test('an empty range means "any version", and the image copy is what any version gets', () => {
  // Not a gap — this is bakedSatisfies' own rule ("Empty / missing range means
  // any version — the baked copy is fine"), so the container serves its baked
  // React 18 here and the local loop must resolve the same one.
  assert.deepEqual(applyImagePins(['react@19.2.0'], { react: '' }, groups), [`react@${baked.react}`]);
  assert.deepEqual(applyImagePins(['react@19.2.0'], {}, groups), [`react@${baked.react}`]);
});

test('a dependency the image does not bake passes through untouched', () => {
  const specs = ['@somewhere-tech/sdk@^0.7.2', 'preact@10.0.0'];
  const deps = { '@somewhere-tech/sdk': '^0.7.2', preact: '^10.0.0' };
  assert.deepEqual(applyImagePins(specs, deps, groups), specs);
});

test('a scoped package name survives the @-split', () => {
  assert.deepEqual(applyImagePins(['@scope/react@1.0.0'], { '@scope/react': '^1.0.0' }, groups), [
    '@scope/react@1.0.0',
  ]);
});

test('an older manifest with no pins changes nothing', () => {
  const specs = ['react@19.2.0'];
  assert.deepEqual(applyImagePins(specs, { react: '^19.2.0' }, []), specs);
  assert.deepEqual(applyImagePins(specs, { react: '^19.2.0' }, [{}, {}]), specs);
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
