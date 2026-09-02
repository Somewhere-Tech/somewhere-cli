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
  /** Write a screenshot to this file. */
  screenshotPath?: string;
  viewport: { width: number; height: number };
  /** Whole-run budget. */
  timeoutMs: number;
}

export interface LocalStepResult {
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
  const steps: LocalStepResult[] = [];
  const screenshots: Array<{ label: string; path: string }> = [];
  const requestMethods = new Map<string, string>();

  try {
    session.on('Runtime.consoleAPICalled', (params) => {
      if (params['type'] !== 'error') return;
      const args = (params['args'] as Array<{ value?: unknown; description?: string }>) ?? [];
      consoleErrors.push(
        args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? '')).join(' ').trim(),
      );
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
    });
    session.on('Network.responseReceived', (params) => {
      const response = params['response'] as { status?: number; url?: string } | undefined;
      if (!response || typeof response.status !== 'number' || response.status < 400) return;
      failedRequests.push({
        status: response.status,
        method: requestMethods.get(String(params['requestId'] ?? '')) ?? 'GET',
        url: response.url,
      });
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
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: req.viewport.width,
      height: req.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const startUrl = req.path ? new URL(req.path, req.url).toString() : req.url;
    const loaded = new Promise<void>((resolve) => {
      session.on('Page.loadEventFired', () => resolve());
    });
    await session.send('Page.navigate', { url: startUrl });
    // Either the page loads or the budget runs out; whichever comes first, drop
    // the other's timer rather than leaving it armed for the rest of the budget.
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      loaded,
      new Promise<void>((resolve) => {
        loadTimer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        loadTimer.unref();
      }),
    ]);
    if (loadTimer) clearTimeout(loadTimer);
    await sleep(SETTLE_MS);

    if (req.path) steps.push({ action: 'goto', ok: true, path: req.path });

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
      domOutline = Array.isArray(probe?.outline) ? probe.outline : [];
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

    const passed =
      steps.every((s) => s.ok) && pageErrors.length === 0 && failedRequests.length === 0;

    return {
      passed,
      final_url: finalUrl,
      console_errors: consoleErrors,
      page_errors: pageErrors,
      failed_requests: failedRequests,
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
