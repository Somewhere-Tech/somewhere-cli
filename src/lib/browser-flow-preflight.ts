import { Script } from 'node:vm';
import type { BrowserSequenceAction } from './browser-actions.js';

/** Only definitive Playwright pseudo-functions; this is not a CSS validator.
 * Query-handler arguments are opaque text, including nested Puppeteer handlers. */
export function unsupportedSelectorFunction(selector: string): string | undefined {
  if (/^[a-zA-Z][\w-]*[=/]/.test(selector)) return undefined;
  let quote = '', handlerDepth = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '/' && selector[i + 1] === '*') {
      const end = selector.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      i = end + 1; continue;
    }
    if (handlerDepth) {
      if (c === '(') handlerDepth++;
      if (c === ')') handlerDepth--;
      continue;
    }
    if (c !== ':') continue;
    const handler = /^::-p-[\w-]+\(/.exec(selector.slice(i));
    if (handler) { i += handler[0].length - 1; handlerDepth = 1; continue; }
    const unsupported = /^:(text-is|has-text)\(/.exec(selector.slice(i));
    if (unsupported) return unsupported[1];
  }
  return undefined;
}

/** Parse the entire action list before any browser work; never execute source. */
export function preflightBrowserActions(actions: readonly BrowserSequenceAction[], at = 'actions'): void {
  for (const [index, action] of actions.entries()) {
    const location = `${at}[${index}]`;
    const selector = 'click' in action ? action.click : 'fill' in action ? action.fill
      : 'upload' in action ? action.upload : 'select' in action ? action.select
      : 'expect' in action ? action.expect.selector
      : 'wait' in action ? (typeof action.wait === 'string' ? action.wait
        : typeof action.wait === 'object' ? action.wait.selector : undefined) : undefined;
    if (selector) {
      const unsupported = unsupportedSelectorFunction(selector);
      if (unsupported) throw new Error(`${location}: Playwright :${unsupported}(...) is unsupported. Use CSS and an element text condition (expect.text). No browser actions ran.`);
    }
    if ('eval' in action) {
      try { new Script(action.eval); }
      catch (error) {
        // Other diagnostics may reflect Node's grammar rather than Chromium's.
        if (!(error instanceof SyntaxError) || !error.message.includes('Illegal return statement')) continue;
        throw new Error(`${location}.eval: invalid JavaScript Script syntax: ${error instanceof Error ? error.message : String(error)}. eval accepts an expression or Script; wrap a returned value in an IIFE, such as (() => { return value; })(). No browser actions ran.`);
      }
    }
  }
}
