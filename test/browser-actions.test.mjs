import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBrowserActions,
  parseExpectFlag,
  parseExpectedRequestFlag,
  parseFillFlag,
  parseSelectFlag,
  matchesExpectedBrowserRequest,
  resolveBrowserRequestExpectations,
} from '../dist/lib/browser-actions.js';
import { executeLocalAction, executeLocalActions } from '../dist/local/browser-run.js';
import { DOM_OUTLINE_SCRIPT } from '../runtime/browser-probes.mjs';

function fakeSession(mode = 'success') {
  return {
    async send(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      const expression = String(params.expression);
      if (mode === 'missing') {
        if (expression.includes('querySelectorAll')) {
          return { result: { value: { count: 0, text: '', visible: false } } };
        }
        if (expression === 'document.title') {
          return { exceptionDetails: { text: 'ReferenceError: missing value' } };
        }
        if (expression.includes('querySelector')) {
          return { result: { value: expression.includes('return false') ? false : 'selector did not match any element' } };
        }
      }
      if (expression.includes('querySelectorAll')) {
        return { result: { value: { count: 1, text: 'Saved', visible: true } } };
      }
      if (expression.includes('querySelector') && expression.includes('return false')) {
        return { result: { value: true } };
      }
      if (expression.includes('querySelector')) return { result: { value: '' } };
      if (expression === 'document.title') return { result: { value: 'Fixture title' } };
      return { result: { value: undefined } };
    },
  };
}

test('shared JSON action contract accepts every step type in order', () => {
  const result = normalizeBrowserActions([
    { click: '#open' },
    { fill: '#email', value: 'a@b.co' },
    { select: '#plan', value: 'pro' },
    { wait: '#ready' },
    { wait: 10 },
    { expect: { selector: '.saved', text: 'Saved', visible: true, count: 1 } },
    { eval: 'document.title' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 7);
});

test('shared JSON action contract rejects missing selectors and invalid eval', () => {
  assert.equal(normalizeBrowserActions([{ click: '' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ fill: '', value: 'x' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ select: '', value: 'x' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ wait: '' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ expect: { selector: '', visible: true } }]).ok, false);
  assert.equal(normalizeBrowserActions([{ eval: '' }]).ok, false);
});

test('repeatable flag parsers map to the same JSON contract', () => {
  assert.deepEqual(parseFillFlag('#email=a@b.co'), { fill: '#email', value: 'a@b.co' });
  assert.deepEqual(parseSelectFlag('#plan=pro'), { select: '#plan', value: 'pro' });
  assert.deepEqual(parseExpectFlag('.saved:text=Ready'), { expect: { selector: '.saved', text: 'Ready' } });
  assert.deepEqual(parseExpectFlag('.dialog:visible=false'), { expect: { selector: '.dialog', visible: false } });
  assert.deepEqual(parseExpectFlag('.row:count=2'), { expect: { selector: '.row', count: 2 } });
});

test('each local action succeeds and reports its own result', async () => {
  const actions = [
    { click: '#open' },
    { fill: '#email', value: 'a@b.co' },
    { select: '#plan', value: 'pro' },
    { wait: '#ready' },
    { expect: { selector: '.saved', text: 'Saved', visible: true, count: 1 } },
    { eval: 'document.title' },
  ];
  const results = [];
  for (const action of actions) {
    results.push(await executeLocalAction(fakeSession(), action, Date.now() + 1000));
  }
  assert.ok(results.every((result) => result.ok));
  assert.equal(results.at(-1).result, 'Fixture title');
});

test('selector actions fail with a reason when the selector does not exist', async () => {
  const actions = [
    { click: '#missing' },
    { fill: '#missing', value: 'x' },
    { select: '#missing', value: 'x' },
    { wait: '#missing' },
    { expect: { selector: '#missing', visible: true } },
  ];
  for (const action of actions) {
    const result = await executeLocalAction(fakeSession('missing'), action, Date.now() - 1);
    assert.equal(result.ok, false);
    assert.match(result.error, /missing|did not match|timed out/i);
  }
});

test('eval failure is reported and stops being a false pass', async () => {
  const result = await executeLocalAction(fakeSession('missing'), { eval: 'document.title' }, Date.now() + 1000);
  assert.equal(result.ok, false);
  assert.match(result.error, /ReferenceError/);
});

test('a failed action stops the sequence and preserves its index in the report order', async () => {
  const results = await executeLocalActions(
    fakeSession('missing'),
    [{ click: '#missing' }, { eval: 'document.title' }],
    Date.now() + 1000,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].step, 0);
  assert.equal(results[0].action, 'click');
  assert.equal(results[0].ok, false);
});

test('expected request matching excludes only the exact expected status', () => {
  const expected = [parseExpectedRequestFlag('/api/tasks:401')];
  assert.equal(matchesExpectedBrowserRequest({ url: 'http://localhost/api/tasks', status: 401 }, expected), true);
  assert.equal(matchesExpectedBrowserRequest({ url: 'http://localhost/api/tasks', status: 500 }, expected), false);
  assert.equal(resolveBrowserRequestExpectations(expected, [{ url: 'http://localhost/api/tasks', status: 401 }])[0].ok, true);
  const missed = resolveBrowserRequestExpectations(expected, [{ url: 'http://localhost/api/tasks', status: 500 }])[0];
  assert.equal(missed.ok, false);
  assert.match(missed.error, /saw 500/);
});

test('vendored outline probe carries the platform visibility annotations', () => {
  assert.match(DOM_OUTLINE_SCRIPT, /visible/);
  assert.match(DOM_OUTLINE_SCRIPT, /disabled/);
  assert.match(DOM_OUTLINE_SCRIPT, /aria-hidden/);
});
