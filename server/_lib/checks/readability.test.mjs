import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReadability, isMinified } from './readability.mjs';

test('normal multi-line module is NOT minified', () => {
  const src = [
    'export function add(a, b) {',
    '  // sum two numbers',
    '  const result = a + b;',
    '  return result;',
    '}',
    '',
    'export function mul(a, b) {',
    '  return a * b;',
    '}',
  ].join('\n');
  const r = analyzeReadability(src);
  assert.equal(r.minified, false);
  assert.deepEqual(r.reasons, []);
  assert.equal(isMinified(src), false);
});

test('long single bundled line IS minified (single-huge-line)', () => {
  // One physical line > 50000 chars.
  const src = 'var a=1;' + 'x'.repeat(60000) + ';';
  const r = analyzeReadability(src);
  assert.equal(r.minified, true);
  assert.ok(r.reasons.includes('single-huge-line'));
  // Such a giant single line also trips long-lines (avg > 500).
  assert.ok(r.reasons.includes('long-lines'));
  assert.equal(isMinified(src), true);
});

test('dense one-line blob with low whitespace IS minified (low-whitespace)', () => {
  // ~1200 chars, on one line, almost no whitespace.
  const src = 'function f(){return' + 'a+'.repeat(600) + '1}';
  assert.ok(src.length >= 500);
  const r = analyzeReadability(src);
  assert.equal(r.minified, true);
  assert.ok(r.reasons.includes('low-whitespace'));
  assert.equal(isMinified(src), true);
});

test('empty string is NOT minified', () => {
  const r = analyzeReadability('');
  assert.equal(r.minified, false);
  assert.deepEqual(r.reasons, []);
  assert.equal(isMinified(''), false);
});

test('undefined / null / garbage input does not throw and is safe default', () => {
  for (const bad of [undefined, null, 123, {}, [], true, Symbol('x'), () => {}]) {
    const r = analyzeReadability(bad);
    assert.equal(r.minified, false);
    assert.deepEqual(r.reasons, []);
    assert.equal(isMinified(bad), false);
  }
});

test('source with no newlines is treated as one line', () => {
  // 200-char single line, plenty of whitespace, short enough to not fire anything.
  const src = 'const x = 1; '.repeat(10).trim();
  const r = analyzeReadability(src);
  assert.equal(r.minified, false);
  assert.deepEqual(r.reasons, []);
});

test('long-lines fires when average line length > 500', () => {
  // Two lines, each ~700 chars of mostly non-whitespace but with spaces so
  // low-whitespace does NOT fire (ratio kept >= 0.10).
  const line = ('ab cd '.repeat(120)).trim(); // ~700 chars, ratio ~0.17
  const src = line + '\n' + line;
  const r = analyzeReadability(src);
  assert.ok(r.reasons.includes('long-lines'));
  assert.ok(!r.reasons.includes('low-whitespace'), 'whitespace ratio kept above threshold');
  assert.equal(r.minified, true);
});

test('avg line length boundary: exactly 500 does NOT fire long-lines', () => {
  // Single line of exactly 500 chars => avg === 500, NOT > 500.
  // Use enough whitespace so low-whitespace stays quiet, length < huge-line.
  const half = 'a '.repeat(250); // 500 chars, ratio 0.5
  assert.equal(half.length, 500);
  const r = analyzeReadability(half);
  assert.ok(!r.reasons.includes('long-lines'), 'avg exactly 500 is not > 500');
  assert.equal(r.minified, false);
});

test('avg line length boundary: 501 DOES fire long-lines', () => {
  // 501-char single line with lots of spaces so whitespace ratio stays high.
  const exact = ('z '.repeat(250)) + 'z'; // 250*2 + 1 = 501 chars
  assert.equal(exact.length, 501);
  const r = analyzeReadability(exact);
  assert.ok(r.reasons.includes('long-lines'), 'avg 501 is > 500');
  assert.equal(r.minified, true);
});

test('whitespace-ratio heuristic is skipped for tiny files (< 500 chars)', () => {
  // 100 chars, zero whitespace -> would be ratio 0, but length < 500 so skip.
  const src = 'x'.repeat(100);
  const r = analyzeReadability(src);
  assert.ok(!r.reasons.includes('low-whitespace'), 'tiny file exempt from whitespace rule');
  // Also avg line length is 100, no huge line -> nothing fires.
  assert.equal(r.minified, false);
});

test('whitespace-ratio boundary: length exactly 500 is eligible', () => {
  // Exactly 500 chars, zero whitespace -> ratio 0 < 0.10, length >= 500 -> fires.
  const src = 'x'.repeat(500);
  const r = analyzeReadability(src);
  assert.ok(r.reasons.includes('low-whitespace'));
  // avg line length is 500, not > 500, so long-lines does NOT fire.
  assert.ok(!r.reasons.includes('long-lines'));
  assert.equal(r.minified, true);
});

test('whitespace-ratio boundary: ratio exactly 0.10 does NOT fire', () => {
  // 1000 chars total, exactly 100 whitespace chars -> ratio = 0.10, NOT < 0.10.
  // Build: 100 spaces + 900 non-space, single line.
  const src = ' '.repeat(100) + 'x'.repeat(900);
  assert.equal(src.length, 1000);
  const r = analyzeReadability(src);
  assert.ok(!r.reasons.includes('low-whitespace'), 'ratio exactly 0.10 is not < 0.10');
  // avg line length 1000 > 500 -> long-lines fires (that's fine).
  assert.ok(r.reasons.includes('long-lines'));
});

test('whitespace-ratio boundary: just under 0.10 DOES fire', () => {
  // 1000 chars, 99 whitespace -> ratio 0.099 < 0.10.
  const src = ' '.repeat(99) + 'x'.repeat(901);
  assert.equal(src.length, 1000);
  const r = analyzeReadability(src);
  assert.ok(r.reasons.includes('low-whitespace'));
  assert.equal(r.minified, true);
});

test('single-huge-line boundary: exactly 50000 does NOT fire', () => {
  // One line of exactly 50000 chars. With abundant whitespace so low-whitespace
  // does not fire; we want to isolate the huge-line boundary.
  const src = 'a '.repeat(25000); // 50000 chars, ratio 0.5, single line (no newline)
  assert.equal(src.length, 50000);
  const r = analyzeReadability(src);
  assert.ok(!r.reasons.includes('single-huge-line'), 'exactly 50000 is not > 50000');
  // avg line length 50000 > 500 -> long-lines fires; that's expected and fine.
  assert.ok(r.reasons.includes('long-lines'));
});

test('single-huge-line boundary: 50001 DOES fire', () => {
  const line = 'a '.repeat(25000) + 'b'; // 50001 chars
  assert.equal(line.length, 50001);
  const r = analyzeReadability(line);
  assert.ok(r.reasons.includes('single-huge-line'));
  assert.equal(r.minified, true);
});

test('huge line detected even when buried among normal lines', () => {
  const huge = 'q'.repeat(60000);
  const src = 'const a = 1;\nconst b = 2;\n' + huge + '\nconst c = 3;\n';
  const r = analyzeReadability(src);
  assert.ok(r.reasons.includes('single-huge-line'));
  assert.equal(isMinified(src), true);
});

test('isMinified always equals analyzeReadability(...).minified', () => {
  const samples = [
    '',
    'short',
    'a\nb\nc',
    'x'.repeat(500),
    'x'.repeat(60000),
    undefined,
    null,
    42,
  ];
  for (const s of samples) {
    assert.equal(isMinified(s), analyzeReadability(s).minified);
  }
});

test('CRLF and CR line endings split correctly', () => {
  const crlf = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
  const cr = 'const a = 1;\rconst b = 2;\rconst c = 3;\r';
  assert.equal(analyzeReadability(crlf).minified, false);
  assert.equal(analyzeReadability(cr).minified, false);
});
