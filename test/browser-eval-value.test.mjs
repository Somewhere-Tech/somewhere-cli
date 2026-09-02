/**
 * `somewhere browser --eval` prints the evaluated value in text mode.
 *
 * The hosted browser returns it in `steps[].value`; the local loopback browser
 * returns it in `steps[].result`. The text formatter read only `result`, so the
 * default output mode of the command an agent uses to assert on a live page
 * silently dropped what it asserted — `--json` had it all along
 * (pfb_4a4d8dd84186).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBrowserReport, stepResultLines, stringifyResult } from '../dist/commands/browser.js';

const report = (steps) => ({
  passed: true,
  final_url: 'https://example.com/',
  console_errors: [],
  page_errors: [],
  failed_requests: [],
  steps,
});

const resultText = (steps) =>
  formatBrowserReport(report(steps))
    .filter((l) => l.trimStart().startsWith('result:') || l.startsWith('    '))
    .join('\n');

// --- the hosted shape (steps[].value) --------------------------------------

test('a hosted eval value is printed in text mode', () => {
  const lines = formatBrowserReport(report([{ action: 'eval', ok: true, value: 'JS entry|hello world' }]));
  assert.ok(lines.includes('  result: JS entry|hello world'), lines.join('\n'));
});

test('a hosted object value is pretty-printed under its label', () => {
  const text = resultText([{ action: 'eval', ok: true, value: { title: 'a', count: 2 } }]);
  assert.match(text, /result:/);
  assert.match(text, /"title": "a"/);
  assert.match(text, /"count": 2/);
});

// --- the local shape (steps[].result) --------------------------------------

test('a local loopback result is still printed', () => {
  const lines = formatBrowserReport(report([{ action: 'eval', ok: true, result: 42 }]));
  assert.ok(lines.includes('  result: 42'), lines.join('\n'));
});

// --- nothing is ever silently blank ----------------------------------------

test('an expression that returned undefined prints null, not a blank line', () => {
  // The hosted browser maps an `undefined` return to null; that IS the answer.
  const lines = formatBrowserReport(report([{ action: 'eval', ok: true, value: null }]));
  assert.ok(lines.includes('  result: null'), lines.join('\n'));
});

test('an eval step carrying no value at all says so explicitly', () => {
  const [line] = stepResultLines({ action: 'eval', ok: true });
  assert.ok(line && /no value returned/.test(line), line);
});

test('a failed eval reports its error, not a missing-value note', () => {
  assert.deepEqual(stepResultLines({ action: 'eval', ok: false, error: 'ReferenceError: x' }), []);
});

// --- steps that were never going to carry a value stay quiet ---------------

test('goto/wait_for/screenshot steps print no result line', () => {
  for (const action of ['goto', 'wait_for', 'screenshot', 'assert_text']) {
    assert.deepEqual(stepResultLines({ action, ok: true }), [], action);
  }
});

test('stringifyResult matches what --json would have shown', () => {
  assert.equal(stringifyResult('plain'), 'plain');
  assert.equal(stringifyResult(7), '7');
  assert.equal(stringifyResult(false), 'false');
  assert.equal(stringifyResult(null), 'null');
  assert.equal(stringifyResult({ a: 1 }), '{\n  "a": 1\n}');
});
