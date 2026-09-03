/**
 * Run the `somewhere browser` health check against a page on this machine.
 *
 * Produces exactly the report shape the hosted browser produces, so the
 * command's formatter, exit code, and `--json` output do not care which half
 * answered. The interactive-element map comes from the platform's own vendored
 * probe (runtime/browser-probes.mjs) — the point of the local path is a
 * preview of the hosted answer, not a second opinion.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DevToolsSession,
  findBrowser,
  launchLocalBrowser,
  NO_BROWSER_MESSAGE,
} from './chrome.js';
import {
  actionLabel,
  matchesExpectedBrowserRequest,
  resolveBrowserRequestExpectations,
  type BrowserRequestExpectationResult,
  type BrowserSequenceAction,
  type ExpectedBrowserRequest,
} from '../lib/browser-actions.js';

/** Loopback and link-local hosts: the addresses only this machine can reach. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0', '[::]']);

/**
 * Is this URL an address only this machine can reach? The hosted browser is
 * remote, so these can only ever be served by the local half.
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(`[${host}]`)) return true;
  if (host.endsWith('.localhost')) return true;
  // 127.0.0.0/8 in full.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export interface LocalBrowserRequest {
  url: string;
  /** Navigate here first, relative to `url`'s origin. */
  path?: string;
  /** A CSS selector to wait for before reading the page. */
  wait?: string;
  /** A JS expression to evaluate in the page. */
  eval?: string;
  actions?: BrowserSequenceAction[];
  expectedRequests?: ExpectedBrowserRequest[];
  visibleOnly?: boolean;
  /** Write a screenshot to this file. */
  screenshotPath?: string;
  viewport: { width: number; height: number };
  /** Whole-run budget. */
  timeoutMs: number;
}

export interface LocalStepResult {
  step?: number;
  action: string;
  ok: boolean;
  selector?: string;
  path?: string;
  script?: string;
  result?: unknown;
  error?: string;
}

export interface LocalBrowserReport {
  passed: boolean;
  final_url: string;
  console_errors: string[];
  page_errors: string[];
  failed_requests: Array<{ status?: number; method?: string; url?: string }>;
  request_expectations?: BrowserRequestExpectationResult[];
  steps: LocalStepResult[];
  screenshots: Array<{ label: string; path: string }>;
  dom_outline: Array<Record<string, unknown>>;
  testid_map: Record<string, string>;
  /** Names the half that answered, so a report is never mistaken for the other. */
  environment: 'local';
}

/** The platform's interactive-element probe, vendored verbatim. */
async function domOutlineScript(): Promise<string> {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime', 'browser-probes.mjs');
  const probes = (await import(pathToFileURL(path).href)) as { DOM_OUTLINE_SCRIPT: string };
  return probes.DOM_OUTLINE_SCRIPT;
}

const SETTLE_MS = 250;
const POLL_MS = 100;

/** How long the preflight waits for the target to answer at all. */
const REACHABILITY_TIMEOUT_MS = 5_000;

/** How long the page gets to finish loading before the run says so and moves on. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * Is this the browser's OWN favicon request rather than one the page made?
 *
 * Chrome fetches /favicon.ico for every document whether or not the page asks
 * for one, so a 404 there says nothing about the app — and the hosted verdict
 * never counted it, because a deployed project answers that path. Counting it
 * locally made `somewhere init`'s own scaffold report FAIL with a clean page
 * underneath (tsk_10be456b). A favicon the page DECLARES has initiator type
 * `parser`, so a broken declared icon still fails, as it should.
 */
export function isBrowserOwnFaviconRequest(url: string | undefined, initiatorType: string | undefined): boolean {
  if (initiatorType !== 'other') return false;
  if (!url) return false;
  try {
    return new URL(url).pathname === '/favicon.ico';
  } catch {
    return false;
  }
}

/**
 * Confirm something is actually serving the local address BEFORE launching a
 * browser at it.
 *
 * Without this, a URL nothing is listening on (a stopped `somewhere dev`, the
 * wrong port, another tool's server that never completes a document) reached
 * the browser anyway, and the run drained its whole budget in silence. The
 * check is a bounded request, and its failure is the one sentence that says
 * what to run.
 */
export async function assertLocalTargetReachable(url: string, timeoutMs = REACHABILITY_TIMEOUT_MS): Promise<void> {
  try {
    await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (timedOut) {
      throw new Error(
        `${url} accepted the connection but did not answer within ${Math.round(timeoutMs / 1000)}s, ` +
        'so there was nothing to inspect. Check that the server on that port is healthy, then run this again.',
      );
    }
    throw new Error(
      `Nothing is serving ${url} on this machine. Start your app with \`somewhere dev\` and point this at the ` +
      'address it prints — or check the deployed app instead with `somewhere browser --project <name>`.',
    );
  }
}

/**
 * Timers are unref'd: the load race below arms one for the whole remaining
 * budget, and a ref'd timer would hold the process open for the rest of it
 * after the page had already loaded.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** Evaluate an expression in the page and return its JSON-ish value. */
async function evaluate(session: DevToolsSession, expression: string): Promise<unknown> {
  const res = (await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'evaluation failed';
    throw new Error(detail);
  }
  return res.result?.value;
}

export async function executeLocalAction(
  session: DevToolsSession,
  action: BrowserSequenceAction,
  deadline: number,
): Promise<LocalStepResult> {
  const label = actionLabel(action);
  const step: LocalStepResult = { action: label, ok: true };
  try {
    if ('click' in action) {
      step.selector = action.click;
      const errorText = await evaluate(session, `(() => {
        const el = document.querySelector(${JSON.stringify(action.click)});
        if (!el) return 'selector did not match any element';
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (el.closest('[hidden]') || el.closest('[aria-hidden="true"]') || style.display === 'none' || style.visibility === 'hidden' || (rect.width === 0 && rect.height === 0)) return 'matched element is hidden';
        el.click();
        return '';
      })()`);
      if (errorText) throw new Error(`click failed at "${action.click}": ${String(errorText)}.`);
      return step;
    }
    if ('fill' in action) {
      step.selector = action.fill;
      const errorText = await evaluate(session, `(() => {
        const el = document.querySelector(${JSON.stringify(action.fill)});
        if (!el) return 'selector did not match any element';
        if (!('value' in el)) return 'matched element cannot be filled';
        el.focus();
        el.value = ${JSON.stringify(action.value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return '';
      })()`);
      if (errorText) throw new Error(`fill failed at "${action.fill}": ${String(errorText)}.`);
      return step;
    }
    if ('select' in action) {
      step.selector = action.select;
      const errorText = await evaluate(session, `(() => {
        const el = document.querySelector(${JSON.stringify(action.select)});
        if (!el) return 'selector did not match any element';
        if (el.tagName !== 'SELECT') return 'matched element is not a select';
        el.value = ${JSON.stringify(action.value)};
        if (el.value !== ${JSON.stringify(action.value)}) return 'option value does not exist';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return '';
      })()`);
      if (errorText) throw new Error(`select failed at "${action.select}": ${String(errorText)}.`);
      return step;
    }
    if ('wait' in action) {
      if (typeof action.wait === 'number') {
        const remaining = Math.max(0, deadline - Date.now());
        await sleep(Math.min(action.wait, remaining));
        if (action.wait > remaining) throw new Error(`wait exceeded the browser run budget after ${remaining}ms.`);
        return step;
      }
      step.selector = action.wait;
      while (Date.now() < deadline) {
        const visible = await evaluate(session, `(() => {
          const el = document.querySelector(${JSON.stringify(action.wait)});
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return !el.closest('[hidden]') && !el.closest('[aria-hidden="true"]')
            && style.display !== 'none' && style.visibility !== 'hidden'
            && !(rect.width === 0 && rect.height === 0);
        })()`);
        if (visible === true) return step;
        await sleep(POLL_MS);
      }
      throw new Error(`wait timed out for "${action.wait}".`);
    }
    if ('expect' in action) {
      step.selector = action.expect.selector;
      const state = await evaluate(session, `(() => {
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(action.expect.selector)}));
        const el = nodes[0];
        if (!el) return { count: nodes.length, text: '', value: '', visible: false };
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          count: nodes.length,
          text: String(el.innerText || el.value || el.textContent || ''),
          value: 'value' in el ? String(el.value ?? '') : '',
          visible: !el.closest('[hidden]') && !el.closest('[aria-hidden="true"]')
            && style.display !== 'none' && style.visibility !== 'hidden'
            && !(rect.width === 0 && rect.height === 0),
        };
      })()`) as { count: number; text: string; value: string; visible: boolean };
      if (action.expect.count !== undefined && state.count !== action.expect.count) {
        throw new Error(`expect failed at "${action.expect.selector}": expected count ${action.expect.count}, got ${state.count}.`);
      }
      if (action.expect.text !== undefined) {
        if (state.count === 0) throw new Error(`expect failed at "${action.expect.selector}": selector did not match any element.`);
        if (!state.text.includes(action.expect.text)) {
          throw new Error(`expect failed at "${action.expect.selector}": text did not contain "${action.expect.text}". Got: "${state.text.trim().slice(0, 120)}".`);
        }
      }
      if (action.expect.value !== undefined) {
        if (state.count === 0) throw new Error(`expect failed at "${action.expect.selector}": selector did not match any element.`);
        if (state.value !== action.expect.value) {
          throw new Error(`expect failed at "${action.expect.selector}": expected value "${action.expect.value}", got "${state.value.slice(0, 120)}".`);
        }
      }
      if (action.expect.visible !== undefined) {
        if (state.count === 0) throw new Error(`expect failed at "${action.expect.selector}": selector did not match any element.`);
        if (state.visible !== action.expect.visible) {
          throw new Error(`expect failed at "${action.expect.selector}": expected visible=${action.expect.visible}, got ${state.visible}.`);
        }
      }
      return step;
    }
    step.script = action.eval;
    step.result = await evaluate(session, action.eval);
    return step;
  } catch (err) {
    step.ok = false;
    step.error = err instanceof Error ? err.message : String(err);
    return step;
  }
}

export async function executeLocalActions(
  session: DevToolsSession,
  actions: readonly BrowserSequenceAction[],
  deadline: number,
): Promise<LocalStepResult[]> {
  const results: LocalStepResult[] = [];
  for (const action of actions) {
    const result = await executeLocalAction(session, action, deadline);
    result.step = results.length;
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

/**
 * Drive the local browser and return the report.
 *
 * The whole run shares one deadline. A step that fails is reported as a failed
 * step and the run still returns everything it captured — the caller asked what
 * the page looks like, and "it broke here, and here is the rest" is the useful
 * answer.
 */
export async function runLocalBrowser(req: LocalBrowserRequest): Promise<LocalBrowserReport> {
  const found = findBrowser();
  if (!found) throw new Error(NO_BROWSER_MESSAGE);

  // Cheapest refusal first: no browser is launched at an address nothing serves.
  const startUrl = req.path ? new URL(req.path, req.url).toString() : req.url;
  await assertLocalTargetReachable(startUrl);

  const deadline = Date.now() + req.timeoutMs;
  const launched = await launchLocalBrowser({
    executablePath: found.path,
    viewport: req.viewport,
    timeoutMs: Math.min(req.timeoutMs, 20_000),
  });
  const { session } = launched;

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ status?: number; method?: string; url?: string }> = [];
  const responses: Array<{ status: number; url: string }> = [];
  const expectedRequests = req.expectedRequests ?? [];
  const steps: LocalStepResult[] = [];
  const screenshots: Array<{ label: string; path: string }> = [];
  const requestMethods = new Map<string, string>();
  const requestInitiators = new Map<string, string | undefined>();

  try {
    session.on('Runtime.consoleAPICalled', (params) => {
      if (params['type'] !== 'error') return;
      const args = (params['args'] as Array<{ value?: unknown; description?: string }>) ?? [];
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? '')).join(' ').trim();
      if (!expectedRequests.some((expected) => text.includes(expected.path) && text.includes(String(expected.status)))) {
        consoleErrors.push(text);
      }
    });
    session.on('Runtime.exceptionThrown', (params) => {
      const details = params['exceptionDetails'] as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      pageErrors.push(details?.exception?.description ?? details?.text ?? 'uncaught error');
    });
    session.on('Network.requestWillBeSent', (params) => {
      const id = String(params['requestId'] ?? '');
      const request = params['request'] as { method?: string } | undefined;
      if (id) requestMethods.set(id, request?.method ?? 'GET');
      const initiator = params['initiator'] as { type?: string } | undefined;
      if (id) requestInitiators.set(id, initiator?.type);
    });
    session.on('Network.responseReceived', (params) => {
      const response = params['response'] as { status?: number; url?: string } | undefined;
      if (!response || typeof response.status !== 'number' || typeof response.url !== 'string') return;
      responses.push({ status: response.status, url: response.url });
      if (response.status < 400) return;
      const requestId = String(params['requestId'] ?? '');
      // The browser's own favicon fetch is not a request the page made.
      if (response.status === 404
          && isBrowserOwnFaviconRequest(response.url, requestInitiators.get(requestId))) return;
      const failed = {
        status: response.status,
        method: requestMethods.get(requestId) ?? 'GET',
        url: response.url,
      };
      if (!matchesExpectedBrowserRequest(failed, expectedRequests)) failedRequests.push(failed);
    });
    session.on('Network.loadingFailed', (params) => {
      // A cancelled request is the page's own choice, not a failure.
      if (params['canceled'] === true) return;
      failedRequests.push({
        method: requestMethods.get(String(params['requestId'] ?? '')) ?? 'GET',
        url: String(params['errorText'] ?? 'request failed'),
      });
    });

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    await session.send('Log.enable');
    session.on('Log.entryAdded', (params) => {
      const entry = params['entry'] as { level?: string; text?: string; url?: string } | undefined;
      if (entry?.level !== 'error' || !entry.text) return;
      const expected = expectedRequests.some(
        (item) => (entry.url ?? '').includes(item.path) && entry.text?.includes(String(item.status)),
      );
      if (!expected && !consoleErrors.includes(entry.text)) consoleErrors.push(entry.text);
    });
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: req.viewport.width,
      height: req.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    let loadFired = false;
    const loaded = new Promise<void>((resolve) => {
      session.on('Page.loadEventFired', () => { loadFired = true; resolve(); });
    });
    await session.send('Page.navigate', { url: startUrl });
    // Either the page loads or its own navigation budget runs out; whichever
    // comes first, drop the other's timer rather than leaving it armed. The
    // budget is the navigation's, NOT the whole run's: spending every second on
    // a document that never loads and then reporting as if it had is what made
    // this command look hung (tsk_a605ff7b).
    const navigationBudgetMs = Math.max(0, Math.min(NAVIGATION_TIMEOUT_MS, deadline - Date.now()));
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      loaded,
      new Promise<void>((resolve) => {
        loadTimer = setTimeout(resolve, navigationBudgetMs);
        loadTimer.unref();
      }),
    ]);
    if (loadTimer) clearTimeout(loadTimer);
    if (!loadFired) {
      steps.push({
        action: 'goto',
        ok: false,
        path: req.path,
        error:
          `${startUrl} did not finish loading within ${Math.round(navigationBudgetMs / 1000)}s. ` +
          'Everything the page had produced by then is reported below.',
      });
    }
    await sleep(SETTLE_MS);

    if (req.path && loadFired) steps.push({ action: 'goto', ok: true, path: req.path });

    steps.push(...await executeLocalActions(session, req.actions ?? [], deadline));

    if (req.wait) {
      const selector = req.wait;
      const step: LocalStepResult = { action: 'wait_for', ok: false, selector };
      const expression = `!!document.querySelector(${JSON.stringify(selector)})`;
      while (Date.now() < deadline) {
        let matched = false;
        try {
          matched = (await evaluate(session, expression)) === true;
        } catch (err) {
          step.error = err instanceof Error ? err.message : String(err);
          break;
        }
        if (matched) {
          step.ok = true;
          break;
        }
        await sleep(POLL_MS);
      }
      if (!step.ok && !step.error) step.error = `Timed out waiting for \`${selector}\`.`;
      steps.push(step);
    }

    if (req.eval) {
      const step: LocalStepResult = { action: 'eval', ok: true, script: req.eval };
      try {
        step.result = await evaluate(session, req.eval);
      } catch (err) {
        step.ok = false;
        step.error = err instanceof Error ? err.message : String(err);
      }
      steps.push(step);
    }

    // The interactive-element map, read AFTER the steps — the same ordering the
    // hosted browser uses, so the map describes the page the run left behind
    // rather than the page before the wait resolved.
    let domOutline: Array<Record<string, unknown>> = [];
    let testidMap: Record<string, string> = {};
    try {
      const probe = (await evaluate(session, await domOutlineScript())) as {
        outline?: Array<Record<string, unknown>>;
        testid_map?: Record<string, string>;
      };
      domOutline = Array.isArray(probe?.outline)
        ? (req.visibleOnly ? probe.outline.filter((node) => node['visible'] === true) : probe.outline)
        : [];
      testidMap = probe?.testid_map ?? {};
    } catch (err) {
      consoleErrors.push(`[inspect] DOM probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (req.screenshotPath) {
      const step: LocalStepResult = { action: 'screenshot', ok: true, path: req.screenshotPath };
      try {
        const shot = (await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })) as {
          data?: string;
        };
        writeFileSync(req.screenshotPath, Buffer.from(shot.data ?? '', 'base64'));
        screenshots.push({ label: 'page', path: req.screenshotPath });
      } catch (err) {
        step.ok = false;
        step.error = err instanceof Error ? err.message : String(err);
      }
      steps.push(step);
    }

    let finalUrl = startUrl;
    try {
      finalUrl = String(await evaluate(session, 'location.href'));
    } catch {
      /* keep the URL we navigated to */
    }

    const requestExpectations = resolveBrowserRequestExpectations(expectedRequests, responses);
    const passed =
      steps.every((s) => s.ok)
      && pageErrors.length === 0
      && failedRequests.length === 0
      && requestExpectations.every((expectation) => expectation.ok);

    return {
      passed,
      final_url: finalUrl,
      console_errors: consoleErrors,
      page_errors: pageErrors,
      failed_requests: failedRequests,
      ...(requestExpectations.length ? { request_expectations: requestExpectations } : {}),
      steps,
      screenshots,
      dom_outline: domOutline,
      testid_map: testidMap,
      environment: 'local',
    };
  } finally {
    await launched.close();
  }
}
