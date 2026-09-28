import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'onboarding-output-'));
process.env.SOMEWHERE_CONFIG_DIR = root;
const { saveVerifyReport } = await import('../dist/lib/verify-report.js');
const { formatVerifyOutput } = await import('../dist/commands/verify.js');
const { formatTempExpiry } = await import('../dist/commands/deploy.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const link = 'https://api.example.invalid/screenshot?signature=' + 'long'.repeat(100);
const report = {
  passed: false, verdict: 'FAIL — expected save did not complete',
  steps: [{ step: 1, viewport: 'desktop', passed: false, name: 'Save', error: 'HTTP 403 FORBIDDEN' }],
  health: { page: { passed: true }, console: { passed: false }, network: { passed: false } },
  screenshots: [{ viewport: 'desktop', url: link, url_expires_at: '2026-09-28T23:00:00Z', fs_path: '/_browser_tests/page.jpg' }],
  undeclared_statuses: [],
};
test('human output saves complete private evidence atomically without shortening failures', () => {
  const original = JSON.stringify(report);
  const lines = formatVerifyOutput(report), output = lines.join('\n');
  assert.doesNotMatch(output, /signature=/); assert.match(output, /HTTP 403 FORBIDDEN/); assert.match(output, /console_health: FAIL/);
  const path = lines.at(-1).replace('Full report and screenshot links: ', '');
  assert.equal(JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))), original);
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(existsSync(join(dirname(path), 'report.pending')), false);
  assert.equal(JSON.stringify(report), original, 'machine report is untouched');
  const second = saveVerifyReport(report); assert.notEqual(second, path);
  assert.equal(readFileSync(second, 'utf8'), readFileSync(path, 'utf8'));
});
test('report failure retains usable full links and every diagnostic', () => {
  const output = formatVerifyOutput(report, () => { throw new Error('fixture disk failure'); }).join('\n');
  assert.match(output, /Could not save/); assert.ok(output.includes(link)); assert.match(output, /HTTP 403 FORBIDDEN/);
});
test('screenshot capture error remains actionable after report persistence', () => {
  const output = formatVerifyOutput({ ...report, screenshots: [{ viewport: 'mobile', error: 'capture unavailable' }] }).join('\n');
  assert.match(output, /capture unavailable/);
});
test('expiry uses the same server instant for fresh and reused sessions, independent of timezone', () => {
  const now = Date.parse('2026-09-28T18:00:00Z'), expires = '2026-09-28T21:00:00.000Z';
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Karachi']) {
    process.env.TZ = zone;
    assert.equal(formatTempExpiry(expires, 10800, now), `Expires at: ${expires} (UTC; about 3h 0m remaining)`);
    assert.equal(formatTempExpiry(expires, undefined, now + 90 * 60_000), `Expires at: ${expires} (UTC; about 1h 30m remaining)`);
  }
  assert.equal(formatTempExpiry(expires, undefined, now + 4 * 3600_000), `Expires at: ${expires} (UTC; about 0m remaining)`);
});
test('detectable clock disagreement or invalid local clock never invents a longer lifetime', () => {
  const expires = '2026-09-28T21:00:00.000Z';
  assert.equal(formatTempExpiry(expires, 10800, Date.parse('2026-09-28T11:00:00Z')), `Expires at: ${expires} (UTC)`);
  assert.equal(formatTempExpiry(expires, 10800, Number.NaN), `Expires at: ${expires} (UTC)`);
});
