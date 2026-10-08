import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import ts from 'typescript';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';
import { resolveInitSelection } from '../dist/lib/init-features.js';
import { findBrowser, launchLocalBrowser } from '../dist/lib/chrome.js';

// Uses the CLI's existing local DevTools transport and isolated starter dependencies.
test('generated styled starter links meet 44x44 on desktop/mobile and retain keyboard skip focus', async t => {
  const modules = process.env.SOMEWHERE_TEST_STARTER_NODE_MODULES;
  const browser = findBrowser();
  if (!modules || !browser) {
    t.skip('Requires existing starter React dependencies and installed Chrome; no downloads');
    return;
  }
  const require = createRequire(join(modules, '../package.json'));
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const files = createFeatureTemplate(resolveInitSelection('auth', 'styled'), { appName: 'X' });
  const file = path => { const entry = files.find(f => f.path === path); assert(entry, path); return entry.content; };
  const js = ts.transpileModule(file('src/ui/AppShell.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} }; new Function('require', 'exports', js)(require, module.exports);
  const shell = renderToStaticMarkup(createElement(module.exports.AppShell, { appName: 'X', homeLink: { href: '/' }, account: { label: 'Account', onSignOut() {}, signingOut: false, error: null } }, createElement('h1', null, 'Content')));
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${file('src/styles/tokens.css')}\n${file('src/styles/app.css')}</style></head><body>${shell}</body></html>`;
  const launched = await launchLocalBrowser({ executablePath: browser.path, viewport: { width: 1280, height: 800 }, timeoutMs: 20000 });
  const session = launched.session;
  const evaluate = async expression => {
    const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result));
    return result.result.value;
  };
  const key = async (key, code) => {
    for (const type of ['keyDown', 'keyUp']) await session.send('Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  };
  try {
    await session.send('Page.enable');
    for (const width of [1280, 390]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
      await session.send('Page.navigate', { url: 'about:blank' });
      const tree = await session.send('Page.getFrameTree');
      await session.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html });
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      const sizes = await evaluate(`['.skip-link','.brand'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {selector,width:r.width,height:r.height};})`);
      for (const size of sizes) {
        assert(size.width >= 44 && size.height >= 44, JSON.stringify({ viewport: width, ...size }));
      }
      await key('Tab', 9);
      assert.equal(await evaluate('document.activeElement.className'), 'skip-link');
      assert((await evaluate("document.querySelector('.skip-link').getBoundingClientRect().top")) >= 0);
      await key('Enter', 13);
      assert.equal(await evaluate('document.activeElement.id'), 'content');
      console.log(JSON.stringify({ viewport: width, sizes, keyboardSkipFocus: true }));
    }
  } finally { await launched.close(); }
});
