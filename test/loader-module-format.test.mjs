/**
 * The local runtime never advises editing a package.json outside the project.
 *
 * With no format declared, Node walks UP from each module looking for the
 * nearest package.json — an unbounded walk — and then prints advice naming
 * whatever it found, on a real machine `/Users/<name>/package.json`
 * (pfb_c4aee81d756a). The loader declares the format instead, which ends the
 * walk. The declaration must agree with what Node would have decided, or it
 * would break CommonJS functions that deploy and run today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredFormat } from '../dist/local/loader.js';

const src = (s) => () => s;
const ESM_JS = 'export default async function (req, sw) { return 1; }';
const CJS_JS = 'module.exports = async function (req, sw) { return 1; };';
const ESM_TS = 'const l: string = "x";\nexport default async function (req: Request) { return l; }';
const CJS_TS = 'const l: string = "x";\nmodule.exports = async function (req: Request) { return l; };';

// --- extensions Node decides without any package.json ----------------------

test('.mjs/.mts are module, .cjs/.cts are commonjs, with no lookup at all', () => {
  assert.equal(declaredFormat('api/a.mjs', null, src('')), 'module');
  assert.equal(declaredFormat('api/a.mts', null, src('')), 'module-typescript');
  assert.equal(declaredFormat('api/a.cjs', null, src('')), 'commonjs');
  assert.equal(declaredFormat('api/a.cts', null, src('')), 'commonjs-typescript');
});

// --- the project's OWN package.json is honoured ----------------------------

test('an explicit "type" in the project package.json decides', () => {
  assert.equal(declaredFormat('api/a.js', 'commonjs', src(ESM_JS)), 'commonjs');
  assert.equal(declaredFormat('api/a.js', 'module', src(CJS_JS)), 'module');
  assert.equal(declaredFormat('api/a.ts', 'commonjs', src(ESM_TS)), 'commonjs-typescript');
  assert.equal(declaredFormat('api/a.ts', 'module', src(CJS_TS)), 'module-typescript');
});

// --- no declaration: decided from the source, never from a parent directory --

test('an ESM function with no declared project type is module', () => {
  assert.equal(declaredFormat('api/a.js', null, src(ESM_JS)), 'module');
  assert.equal(declaredFormat('api/a.ts', null, src(ESM_TS)), 'module-typescript');
});

test('a CommonJS function with no declared project type stays commonjs', () => {
  // `module.exports = async function (req, sw)` deploys and runs on the
  // platform. Declaring ESM for it would have broken it in the local loop only.
  assert.equal(declaredFormat('api/a.js', null, src(CJS_JS)), 'commonjs');
  assert.equal(declaredFormat('api/a.ts', null, src(CJS_TS)), 'commonjs-typescript');
});

test('top-level await is module, the way Node reads it', () => {
  assert.equal(declaredFormat('api/a.js', null, src('const x = await fetch("/");')), 'module');
});

test('an unreadable source declares nothing rather than guessing', () => {
  const throwing = () => {
    throw new Error('EACCES');
  };
  assert.equal(declaredFormat('api/a.js', null, throwing), null);
});

test('files the loader has no business classifying are left to Node', () => {
  assert.equal(declaredFormat('api/data.json', null, src('{}')), null);
  assert.equal(declaredFormat('public/style.css', null, src('')), null);
});
