// tsk_32e81790 / tsk_3e62d9b5: `verify` text output prints eval values and
// readable wait steps, and a page wider than the phone viewport is named in
// the verdict instead of passing silently.
import test from 'node:test';
import assert from 'node:assert/strict';

const { formatVerifyReport, normalizeVerifyFlow, overflowWarning, runVerification } = await import('../dist/commands/verify.js');

const OVERFLOW = 'Accessibility/layout: horizontal overflow 283px near div#wide; 2 tap targets below 44×44px (for example a.tiny 20×20px). Findings are reported only and do not block verification.';
const CLEAN = 'Accessibility/layout: no WCAG AA text-contrast failures, horizontal overflow, or tap targets below 44×44px detected.';

function report(viewportLayout, steps) {
  return {
    passed: true,
    final_url: 'https://fixture.somewhere.site/',
    console_errors: [], page_errors: [], failed_requests: [], request_expectations: [],
    steps,
    screenshots: [{ label: 'page', fs_path: '/_browser_tests/run/page.jpg', url: 'https://api.test/signed/page.jpg' }],
    accessibility_layout: viewportLayout,
  };
}
const client = (reports) => {
  let index = 0;
  return { async call() { return reports[index++] ?? reports.at(-1); } };
};

const actions = [{ goto: '/' }, { wait: { selector: 'body' } }, { wait: 250 }, { eval: 'JSON.stringify({w:innerWidth,sw:document.documentElement.scrollWidth})' }];
const steps = (width) => [
  { step: 0, action: 'goto', ok: true, duration_ms: 5 },
  { step: 1, action: 'wait', ok: true, duration_ms: 4 },
  { step: 2, action: 'wait', ok: true, duration_ms: 250 },
  { step: 3, action: 'eval', ok: true, duration_ms: 16, value: JSON.stringify({ w: width, sw: 665 }) },
];

test('text output prints the eval value under its step at both viewports, and wait targets in words', async () => {
  const result = await runVerification({ project_id: 'fixture' }, normalizeVerifyFlow({ actions }), client([report(CLEAN, steps(1280)), report(OVERFLOW, steps(390))]));
  const lines = formatVerifyReport(result).join('\n');
  assert.match(lines, /step 4 ✓ \[desktop\] eval JSON\.stringify.*\n {2}result: \{"w":1280,"sw":665\}/);
  assert.match(lines, /step 4 ✓ \[mobile\] eval JSON\.stringify.*\n {2}result: \{"w":390,"sw":665\}/);
  assert.match(lines, /step 2 ✓ \[desktop\] wait body/);
  assert.match(lines, /step 3 ✓ \[desktop\] wait 250ms/);
  assert.doesNotMatch(lines, /\[object Object\]/);
});

test('phone overflow is named in a PASS verdict; a clean layout adds nothing', async () => {
  const overflowing = await runVerification({ project_id: 'fixture' }, normalizeVerifyFlow({ actions }), client([report(CLEAN, steps(1280)), report(OVERFLOW, steps(390))]));
  assert.equal(overflowing.passed, true, 'overflow warns, it does not fail existing flows');
  assert.match(overflowing.verdict, /^PASS — .* WARNING — the page is wider than the viewport at mobile by 283px near div#wide \(horizontal scroll\)\.$/);

  const clean = await runVerification({ project_id: 'fixture' }, normalizeVerifyFlow({ actions }), client([report(CLEAN, steps(1280)), report(CLEAN, steps(390))]));
  assert.doesNotMatch(clean.verdict, /WARNING/);
});

test('overflowWarning parses selectors with dots and stops at the next finding', () => {
  assert.equal(
    overflowWarning([{ viewport: 'mobile', detail: 'Accessibility/layout: horizontal overflow 12px near div.card.wide. Findings are reported only and do not block verification.' }]),
    ' WARNING — the page is wider than the viewport at mobile by 12px near div.card.wide (horizontal scroll).',
  );
  assert.equal(overflowWarning([{ viewport: 'mobile', detail: 'Accessibility/layout: 1 WCAG AA text-contrast failure. Findings are reported only and do not block verification.' }]), '');
});
