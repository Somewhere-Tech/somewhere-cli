import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeBrowserActions,
  parseExpectFlag,
  parseExpectedRequestFlag,
  parseFillFlag,
  parseSelectFlag,
  parseUploadFlag,
  MAX_BROWSER_UPLOAD_BYTES,
  matchesExpectedBrowserRequest,
  resolveBrowserRequestExpectations,
} from '../dist/lib/browser-actions.js';
import { executeLocalAction, executeLocalActions } from '../dist/lib/browser-run.js';
import { DOM_OUTLINE_SCRIPT } from '../runtime/browser-probes.mjs';

function fakeSession(mode = 'success') {
  return {
    async send(method, params) {
      if (method === 'Page.captureScreenshot') {
        return { data: Buffer.from('fixture png').toString('base64') };
      }
      assert.equal(method, 'Runtime.evaluate');
      const expression = String(params.expression);
      if (mode === 'missing') {
        if (expression.includes('input instanceof HTMLInputElement')) {
          return { exceptionDetails: { text: 'upload target must be an <input type="file">' } };
        }
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
      if (expression.includes('new File')) {
        return { result: { value: { name: 'shot.png', type: 'image/png', size: 7 } } };
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
    { upload: '#avatar', file: 'data:image/png;base64,cG5n', name: 'shot.png' },
    { select: '#plan', value: 'pro' },
    { wait: '#ready' },
    { wait: 10 },
    { expect: { selector: '.saved', text: 'Saved', visible: true, count: 1 } },
    { screenshot: 'after-save' },
    { eval: 'document.title' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 9);
});

test('shared JSON action contract rejects missing selectors and invalid eval', () => {
  assert.equal(normalizeBrowserActions([{ click: '' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ fill: '', value: 'x' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ upload: '', file: 'cG5n' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ upload: '#avatar', file: 'not base64!' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ select: '', value: 'x' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ wait: '' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ expect: { selector: '', visible: true } }]).ok, false);
  assert.equal(normalizeBrowserActions([{ screenshot: '' }]).ok, false);
  assert.equal(normalizeBrowserActions([{ eval: '' }]).ok, false);
});

test('repeatable flag parsers map to the same JSON contract', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-browser-upload-'));
  writeFileSync(join(fixtureDir, 'shot.png'), Buffer.from('real png bytes'));
  assert.deepEqual(parseFillFlag('#email=a@b.co'), { fill: '#email', value: 'a@b.co' });
  assert.deepEqual(parseUploadFlag('#avatar=shot.png', fixtureDir), {
    upload: '#avatar',
    file: `data:image/png;base64,${Buffer.from('real png bytes').toString('base64')}`,
    name: 'shot.png',
  });
  assert.deepEqual(parseSelectFlag('#plan=pro'), { select: '#plan', value: 'pro' });
  assert.deepEqual(parseExpectFlag('.saved:text=Ready'), { expect: { selector: '.saved', text: 'Ready' } });
  assert.deepEqual(parseExpectFlag('#new-book-title:value=Kindred'), { expect: { selector: '#new-book-title', value: 'Kindred' } });
  assert.deepEqual(parseExpectFlag('.dialog:visible=false'), { expect: { selector: '.dialog', visible: false } });
  assert.deepEqual(parseExpectFlag('.row:count=2'), { expect: { selector: '.row', count: 2 } });
});

test('wait accepts the documented object selector form and rejects an ambiguous object with the accepted shape', () => {
  assert.deepEqual(normalizeBrowserActions([{ wait: { selector: '#ready' } }]), { ok: true, actions: [{ wait: { selector: '#ready' } }] });
  const invalid = normalizeBrowserActions([{ wait: { text: 'Ready' } }]);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /\{ "selector": "#ready" \}/);
});

test('local upload paths preserve bytes, filename, and MIME type while unsafe inputs fail before navigation', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-browser-upload-contract-'));
  writeFileSync(join(fixtureDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  mkdirSync(join(fixtureDir, 'folder'));
  writeFileSync(join(fixtureDir, 'large.bin'), Buffer.alloc(MAX_BROWSER_UPLOAD_BYTES + 1));

  const normalized = normalizeBrowserActions([{ upload: '#file', file: './shot.png' }], fixtureDir);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.actions[0].name, 'shot.png');
  assert.match(normalized.actions[0].file, /^data:image\/png;base64,/);
  assert.deepEqual(
    Buffer.from(normalized.actions[0].file.split(',')[1], 'base64'),
    readFileSync(join(fixtureDir, 'shot.png')),
  );

  const directory = normalizeBrowserActions([{ upload: '#file', file: './folder' }], fixtureDir);
  assert.equal(directory.ok, false);
  assert.match(directory.error, /not a regular file/);
  const oversized = normalizeBrowserActions([{ upload: '#file', file: './large.bin' }], fixtureDir);
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /BROWSER_UPLOAD_TOO_LARGE/);
  assert.match(oversized.error, /10 MB/);
});

test('each local action succeeds and reports its own result', async () => {
  const screenshotPrefix = join(mkdtempSync(join(tmpdir(), 'sw-browser-screenshot-')), 'browser');
  const actions = [
    { click: '#open' },
    { fill: '#email', value: 'a@b.co' },
    { upload: '#avatar', file: 'data:image/png;base64,cG5n', name: 'shot.png' },
    { select: '#plan', value: 'pro' },
    { wait: '#ready' },
    { expect: { selector: '.saved', text: 'Saved', visible: true, count: 1 } },
    { screenshot: 'after-save' },
    { eval: 'document.title' },
  ];
  const results = [];
  for (const action of actions) {
    results.push(await executeLocalAction(fakeSession(), action, Date.now() + 1000, screenshotPrefix));
  }
  assert.ok(results.every((result) => result.ok));
  const screenshot = results.find((result) => result.action === 'screenshot');
  assert.equal(readFileSync(screenshot.path, 'utf8'), 'fixture png');
  assert.equal(results.at(-1).result, 'Fixture title');
});

test('selector actions fail with a reason when the selector does not exist', async () => {
  const actions = [
    { click: '#missing' },
    { fill: '#missing', value: 'x' },
    { upload: '#missing', file: 'data:image/png;base64,cG5n', name: 'shot.png' },
    { select: '#missing', value: 'x' },
    { wait: '#missing' },
    { expect: { selector: '#missing', visible: true } },
  ];
  for (const action of actions) {
    const result = await executeLocalAction(fakeSession('missing'), action, Date.now() - 1);
    assert.equal(result.ok, false);
    assert.match(result.error, /missing|did not match|timed out|upload target/i);
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

// tsk_eb818014 — a CSS attribute selector carries its own "=", so first-"="
// splitting cut the selector in half and tried to open the remainder as a path.
test('upload mappings take the file path from the last equals so attribute selectors survive', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-upload-split-'));
  writeFileSync(join(fixtureDir, 'shot.png'), 'png');
  writeFileSync(join(fixtureDir, 'a=b.png'), 'png');

  // The reported break: this used to resolve the path "y]=./shot.png".
  const attribute = parseUploadFlag('[data-testid=file]=./shot.png', fixtureDir);
  assert.equal(attribute.upload, '[data-testid=file]');
  assert.equal(attribute.name, 'shot.png');

  // Multiple equals in the selector still leave the path whole.
  const multi = parseUploadFlag('[data-x=y][data-z=w]=./shot.png', fixtureDir);
  assert.equal(multi.upload, '[data-x=y][data-z=w]');
  assert.equal(multi.name, 'shot.png');

  // A pseudo-CLASS uses a single colon and is untouched by the "::" form.
  const pseudoClass = parseUploadFlag('input:not([disabled])=./shot.png', fixtureDir);
  assert.equal(pseudoClass.upload, 'input:not([disabled])');
  assert.equal(pseudoClass.name, 'shot.png');

  // The explicit form is there for a path that itself contains "=".
  const explicit = parseUploadFlag('[data-testid=file]::./a=b.png', fixtureDir);
  assert.equal(explicit.upload, '[data-testid=file]');
  assert.equal(explicit.name, 'a=b.png');
});

test('the simple upload mapping and the fill/select splits are byte-for-byte unchanged', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-upload-compat-'));
  writeFileSync(join(fixtureDir, 'photo.png'), 'png');

  const simple = parseUploadFlag('#avatar=./photo.png', fixtureDir);
  assert.deepEqual(
    { upload: simple.upload, name: simple.name },
    { upload: '#avatar', name: 'photo.png' },
  );

  // fill/select values routinely contain "=", so they keep first-"=" splitting.
  assert.deepEqual(parseFillFlag('#q=a=b'), { fill: '#q', value: 'a=b' });
  assert.deepEqual(parseSelectFlag('#plan=pro=1'), { select: '#plan', value: 'pro=1' });
});

test('an upload mapping missing either side fails locally with actionable copy', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-upload-invalid-'));
  for (const raw of ['#avatar', '=./photo.png', '#avatar=', '#avatar::', '::./photo.png']) {
    assert.throws(
      () => parseUploadFlag(raw, fixtureDir),
      (err) => {
        assert.match(err.message, /--upload expects <selector>=<file>/);
        assert.match(err.message, /LAST "="/);
        assert.match(err.message, /<selector>::<file>/);
        return true;
      },
      `expected ${raw} to be rejected`,
    );
  }
});
