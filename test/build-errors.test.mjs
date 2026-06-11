import test from 'node:test';
import assert from 'node:assert/strict';
import { localCodeFrame, isBuildError, buildErrorSummary } from '../dist/lib/build-errors.js';
import { CliApiError } from '../dist/lib/client.js';

const SRC = ['const a = 1;', 'const b = 2;', 'const c = ;', 'const d = 4;', 'const e = 5;'].join('\n');

test('localCodeFrame shows line ±2 with caret at column', () => {
  const frame = localCodeFrame(SRC, 3, 11);
  // eslint-disable-next-line no-control-regex
  const plain = frame.replace(/\[[0-9;]*m/g, '');
  assert.match(plain, />\s+3 \| const c = ;/);
  assert.match(plain, /1 \| const a = 1;/);
  assert.match(plain, /5 \| const e = 5;/);
  const caretLine = plain.split('\n').find((l) => l.includes('^'));
  assert.ok(caretLine, 'caret line present');
  assert.equal(caretLine.indexOf('^'), caretLine.indexOf('|') + 1 + 11);
});

test('localCodeFrame out-of-range line returns empty', () => {
  assert.equal(localCodeFrame(SRC, 99), '');
  assert.equal(localCodeFrame(SRC, 0), '');
});

test('isBuildError requires code + data', () => {
  assert.ok(isBuildError(new CliApiError('BUILD_ERROR', 'm', 400, { file: 'a.ts' })));
  assert.ok(!isBuildError(new CliApiError('BUILD_ERROR', 'm', 400)));
  assert.ok(!isBuildError(new CliApiError('VALIDATION_ERROR', 'm', 400, {})));
  assert.ok(!isBuildError(new Error('m')));
});

test('buildErrorSummary prefers first structured error', () => {
  const err = new CliApiError('BUILD_ERROR', 'long server message', 400, {
    errors: [{ file: 'src/App.tsx', line: 12, column: 3, message: 'Unexpected token' }],
  });
  assert.equal(buildErrorSummary(err), 'src/App.tsx:12:3 — Unexpected token');
});

test('parseBundleErrorText extracts esbuild diagnostics', async () => {
  const { parseBundleErrorText } = await import('../dist/lib/build-errors.js');
  const text = '✗ Build failed with 2 errors:\nsrc/App.tsx:2:18: ERROR: Unexpected ";"\nsrc/other.ts:5:0: ERROR: Could not resolve "./gone"';
  const parsed = parseBundleErrorText(text);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { file: 'src/App.tsx', line: 2, column: 19, message: 'Unexpected ";"' });
  assert.equal(parsed[1].file, 'src/other.ts');
});
