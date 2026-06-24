import test from 'node:test';
import assert from 'node:assert/strict';

import { detectCapabilities } from './capabilities.mjs';

// --- Defensive / empty inputs ------------------------------------------------
test('non-string and empty inputs return []', () => {
  assert.deepEqual(detectCapabilities(undefined), []);
  assert.deepEqual(detectCapabilities(null), []);
  assert.deepEqual(detectCapabilities(''), []);
  assert.deepEqual(detectCapabilities(42), []);
  assert.deepEqual(detectCapabilities({}), []);
  assert.deepEqual(detectCapabilities([]), []);
  assert.deepEqual(detectCapabilities(NaN), []);
  assert.deepEqual(detectCapabilities(() => {}), []);
});

test('innocuous source yields []', () => {
  assert.deepEqual(detectCapabilities('export const add=(a,b)=>a+b'), []);
});

// --- network -----------------------------------------------------------------
test('network: require/import of each network module', () => {
  for (const mod of ['net', 'http', 'https', 'http2', 'dgram', 'tls', 'ws']) {
    assert.deepEqual(
      detectCapabilities(`const m = require('${mod}')`),
      ['network'],
      `cjs require ${mod}`,
    );
    assert.deepEqual(
      detectCapabilities(`import x from "${mod}"`),
      ['network'],
      `esm import ${mod}`,
    );
  }
});

test('network: fetch( call', () => {
  assert.deepEqual(detectCapabilities('await fetch("https://x")'), ['network']);
});

test('network: fetch word-boundary avoids prefetch false positive', () => {
  assert.deepEqual(detectCapabilities('function prefetch(x){return x}'), []);
});

test('network: new WebSocket(', () => {
  assert.deepEqual(detectCapabilities('const s = new WebSocket("ws://x")'), [
    'network',
  ]);
});

test('network: new XMLHttpRequest(', () => {
  assert.deepEqual(detectCapabilities('var r = new XMLHttpRequest();'), [
    'network',
  ]);
});

// --- fs ----------------------------------------------------------------------
test('fs: require/import of fs and fs/promises', () => {
  assert.deepEqual(detectCapabilities(`require('fs')`), ['fs']);
  assert.deepEqual(detectCapabilities(`require("fs/promises")`), ['fs']);
  assert.deepEqual(detectCapabilities(`import fs from 'fs'`), ['fs']);
  assert.deepEqual(
    detectCapabilities(`import { readFile } from 'fs/promises'`),
    ['fs'],
  );
});

test('fs: a word containing fs does not trigger', () => {
  // No require/import of fs — just an identifier.
  assert.deepEqual(detectCapabilities('const offset = 1; const fsx = 2;'), []);
});

// --- child_process -----------------------------------------------------------
test('child_process: require/import', () => {
  assert.deepEqual(detectCapabilities(`require('child_process')`), [
    'child_process',
  ]);
  assert.deepEqual(
    detectCapabilities(`import { spawn } from 'child_process'`),
    ['child_process'],
  );
});

test('child_process: each call form', () => {
  for (const fn of [
    'exec',
    'execSync',
    'spawn',
    'spawnSync',
    'fork',
    'execFile',
  ]) {
    assert.deepEqual(
      detectCapabilities(`${fn}("ls")`),
      ['child_process'],
      `call ${fn}`,
    );
  }
});

test('child_process: call word-boundary avoids substring false positive', () => {
  assert.deepEqual(detectCapabilities('myspawn("x"); doexec("y");'), []);
});

// --- process.env -------------------------------------------------------------
test('process.env: literal text', () => {
  assert.deepEqual(detectCapabilities('const k = process.env.SECRET'), [
    'process.env',
  ]);
});

// --- node: prefix ------------------------------------------------------------
test('node: prefix is tolerated for require and import', () => {
  assert.deepEqual(detectCapabilities(`require('node:fs')`), ['fs']);
  assert.deepEqual(detectCapabilities(`require("node:http")`), ['network']);
  assert.deepEqual(
    detectCapabilities(`import cp from 'node:child_process'`),
    ['child_process'],
  );
  assert.deepEqual(
    detectCapabilities(`import { readFile } from "node:fs/promises"`),
    ['fs'],
  );
});

// --- ESM dynamic import + bare import ----------------------------------------
test('ESM dynamic import() is recognized', () => {
  assert.deepEqual(detectCapabilities(`await import('node:net')`), ['network']);
  assert.deepEqual(detectCapabilities(`import("fs").then(m => m)`), ['fs']);
});

test('ESM bare side-effect import is recognized', () => {
  assert.deepEqual(detectCapabilities(`import 'fs'`), ['fs']);
  assert.deepEqual(detectCapabilities(`import "node:tls"`), ['network']);
});

test('ESM export ... from is recognized', () => {
  assert.deepEqual(detectCapabilities(`export { x } from 'http'`), ['network']);
});

// --- single vs double quotes -------------------------------------------------
test('single and double quotes both match', () => {
  assert.deepEqual(detectCapabilities(`require('fs')`), ['fs']);
  assert.deepEqual(detectCapabilities(`require("fs")`), ['fs']);
});

// --- dedup -------------------------------------------------------------------
test('dedup: same capability referenced many ways collapses to one token', () => {
  const src = `
    const a = require('fs');
    const b = require('node:fs');
    import c from 'fs/promises';
    await import('fs');
  `;
  assert.deepEqual(detectCapabilities(src), ['fs']);
});

// --- sort + multiple categories ---------------------------------------------
test('multiple categories returned sorted and de-duplicated', () => {
  const src = `
    import http from 'node:http';
    const cp = require('child_process');
    const fs = require('fs');
    const key = process.env.API_KEY;
    fetch('https://example.com');
    spawn('ls');
  `;
  assert.deepEqual(detectCapabilities(src), [
    'child_process',
    'fs',
    'network',
    'process.env',
  ]);
});

test('result is always sorted regardless of source order', () => {
  // process.env appears first, network module last — output still sorted.
  const src = `process.env.X; const s = require('net');`;
  assert.deepEqual(detectCapabilities(src), ['network', 'process.env']);
});