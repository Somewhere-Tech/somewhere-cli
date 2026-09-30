import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightBrowserActions, unsupportedSelectorFunction } from '../dist/lib/browser-flow-preflight.js';
import { createVerifyJourneyRun, normalizeVerifyJourney, normalizeVerifyFlow, runVerification } from '../dist/commands/verify.js';

test('only definitive unsupported syntax refuses; legitimate selector and Script forms remain accepted', () => {
  for (const selector of ['button:text-is("Save")', 'button:has-text("Save")', 'form:has(button:text-is("Save"))']) {
    assert.ok(unsupportedSelectorFunction(selector));
  }
  for (const selector of ['form:has(input)', '[title=":text-is(Save)"]', 'button/*:text-is(x)*/', '#\\:text-is\\(x\\)', '#\\3a text-is', 'text/:text-is(Save)', 'aria/:text-is(Save)', 'xpath//button', 'custom/:text-is(Save)', 'div ::-p-text(:text-is(Save))', '::-p-aria([name="a :text-is(Save)"])']) {
    assert.equal(unsupportedSelectorFunction(selector), undefined, selector);
    assert.doesNotThrow(() => preflightBrowserActions([{ click: selector }]));
  }
  for (const script of ['document.title', '(() => { return 1; })()', '(async () => { return await Promise.resolve(1); })()', 'function value() { return 1; }; value()', '"return 1"', '/return/.test("return")', '`return ${1}`', '/* return 1 */ 1', 'const broken = ;', 'using item = resource;']) {
    assert.doesNotThrow(() => preflightBrowserActions([{ eval: script }]), script);
  }
  assert.throws(() => preflightBrowserActions([{ eval: 'return document.title;' }]), /actions\[0\].eval.*IIFE/);
});

test('later actor/viewport syntax failure prevents every API call including cleanup', async () => {
  let calls = 0;
  const client = { async call() { calls++; throw new Error('unexpected API call'); } };
  for (const invalid of [{ eval: 'return document.title;' }, { click: 'button:text-is("Save")' }]) {
    const journey = normalizeVerifyJourney({ actors: { alice: {}, guest: {} }, journey: [
      { as: 'alice', viewport: 'desktop', actions: [{ click: '#save' }] },
      { as: 'guest', viewport: 'mobile', actions: [invalid] },
    ] });
    await assert.rejects(createVerifyJourneyRun({ project_id: 'fixture' }, journey, client).run(), /journey\[1\].actions\[0\]/);
  }
  assert.equal(calls, 0);
  await assert.rejects(runVerification({ project_id: 'fixture' }, normalizeVerifyFlow({ actions: [{ click: '#save' }, { eval: 'return 1;' }] }), client), /actions\[1\]/);
  assert.equal(calls, 0);
});
