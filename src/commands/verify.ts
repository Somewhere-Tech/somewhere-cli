import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import {
  normalizeBrowserActions,
  type BrowserRequestExpectationResult,
  type BrowserSequenceAction,
  type ExpectedBrowserRequest,
} from '../lib/browser-actions.js';
import { isLoopbackUrl, runLocalBrowser } from '../lib/browser-run.js';
import { dim, error, green, red, teal } from '../lib/output.js';
import type { BrowserResult } from './browser.js';

const VERIFY_TIMEOUT_MS = 90_000;
const DEFAULT_VIEWPORTS = ['desktop', 'mobile'] as const;

export type VerifyViewportInput =
  | 'desktop'
  | 'mobile'
  | { label: string; width: number; height: number };

export interface VerifyFlow {
  actions: BrowserSequenceAction[];
  auth?: { user_id: string };
  local_storage?: Record<string, string>;
  cookies?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  expect_requests: ExpectedBrowserRequest[];
  visible_only: boolean;
  viewports: VerifyViewportInput[];
}

export interface VerifyStepReport {
  viewport: string;
  step: number;
  name: string;
  passed: boolean;
  error?: string;
  duration_ms?: number;
  value?: unknown;
}

export interface VerifyScreenshotReport {
  viewport: string;
  label: string;
  path?: string;
  url?: string;
  url_expires_at?: string;
  fs_path?: string;
  scratch_url?: string;
  scratch_expires_at?: string;
  error?: string;
}

export interface VerifySignal<T> {
  viewport: string;
  detail: T;
}

export interface VerifyReport {
  passed: boolean;
  verdict: string;
  target: string;
  viewports: Array<{ label: string; width: number; height: number; passed: boolean; final_url: string }>;
  steps: VerifyStepReport[];
  health: {
    page: { passed: boolean; errors: Array<VerifySignal<unknown>> };
    console: { passed: boolean; errors: Array<VerifySignal<unknown>> };
    network: {
      passed: boolean;
      failed_requests: Array<VerifySignal<unknown>>;
      expectations: Array<VerifySignal<BrowserRequestExpectationResult>>;
    };
  };
  screenshots: VerifyScreenshotReport[];
}

interface ResolvedViewport {
  label: string;
  width: number;
  height: number;
  wire: 'desktop' | 'mobile' | { width: number; height: number };
}

export interface VerificationTarget {
  project_id?: string;
  url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeExpectedRequests(raw: unknown): ExpectedBrowserRequest[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('expect_requests must be a JSON array.');
  if (raw.length > 30) throw new Error(`expect_requests has ${raw.length} items; max is 30.`);
  return raw.map((value, index) => {
    if (!isRecord(value) || typeof value.path !== 'string' || !value.path) {
      throw new Error(`expect_requests[${index}].path must be a non-empty string.`);
    }
    if (typeof value.status !== 'number' || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) {
      throw new Error(`expect_requests[${index}].status must be an integer from 100 through 599.`);
    }
    return { path: value.path, status: value.status };
  });
}

function normalizeStringRecord(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${field} must be a JSON object with string values.`);
  const entries = Object.entries(raw);
  if (entries.some(([, value]) => typeof value !== 'string')) {
    throw new Error(`${field} must contain only string values.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function normalizeCookies(raw: unknown): Array<{ name: string; value: string }> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('cookies must be a JSON array of { name, value } objects.');
  return raw.map((value, index) => {
    if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.value !== 'string') {
      throw new Error(`cookies[${index}] must have a non-empty string name and a string value.`);
    }
    return { name: value.name.trim(), value: value.value };
  });
}

function normalizeAuth(raw: unknown): { user_id: string } | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.user_id !== 'string' || !raw.user_id.trim()) {
    throw new Error('auth must be { "user_id": "<app-user-id>" }.');
  }
  return { user_id: raw.user_id.trim() };
}

function assertSessionSeedSize(flow: Pick<VerifyFlow, 'local_storage' | 'cookies' | 'headers'>): void {
  const bytes = Buffer.byteLength(JSON.stringify({
    local_storage: flow.local_storage ?? {},
    cookies: flow.cookies ?? [],
    headers: flow.headers ?? {},
  }));
  if (bytes > 8 * 1024) throw new Error(`Verification session seed is ${bytes} bytes; the platform limit is 8192 bytes (8 KB).`);
}

function normalizeViewports(raw: unknown): VerifyViewportInput[] {
  if (raw === undefined) return [...DEFAULT_VIEWPORTS];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('viewports must be a non-empty JSON array.');
  if (raw.length > 4) throw new Error(`viewports has ${raw.length} items; max is 4.`);
  const labels = new Set<string>();
  return raw.map((value, index) => {
    if (value === 'desktop' || value === 'mobile') {
      if (labels.has(value)) throw new Error(`viewports[${index}] duplicates label "${value}".`);
      labels.add(value);
      return value;
    }
    if (!isRecord(value)
        || typeof value.label !== 'string'
        || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(value.label)
        || typeof value.width !== 'number'
        || !Number.isInteger(value.width)
        || value.width < 100
        || value.width > 3840
        || typeof value.height !== 'number'
        || !Number.isInteger(value.height)
        || value.height < 100
        || value.height > 2160) {
      throw new Error(`viewports[${index}] must be "desktop", "mobile", or { "label", "width": 100..3840, "height": 100..2160 }.`);
    }
    if (labels.has(value.label)) throw new Error(`viewports[${index}] duplicates label "${value.label}".`);
    labels.add(value.label);
    return { label: value.label, width: value.width, height: value.height };
  });
}

export function normalizeVerifyFlow(raw: unknown, baseDir = process.cwd()): VerifyFlow {
  if (raw === undefined) {
    return { actions: [], expect_requests: [], visible_only: false, viewports: [...DEFAULT_VIEWPORTS] };
  }
  if (!isRecord(raw)) throw new Error('flow must be a JSON object.');
  const supported = new Set(['actions', 'auth', 'local_storage', 'cookies', 'headers', 'expect_requests', 'visible_only', 'viewports']);
  const unknown = Object.keys(raw).filter((key) => !supported.has(key));
  if (unknown.length) throw new Error(`flow has unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  const actions = normalizeBrowserActions(raw.actions ?? [], baseDir);
  if (!actions.ok) throw new Error(actions.error);
  if (raw.visible_only !== undefined && typeof raw.visible_only !== 'boolean') {
    throw new Error('visible_only must be boolean.');
  }
  const auth = normalizeAuth(raw.auth);
  const localStorage = normalizeStringRecord(raw.local_storage, 'local_storage');
  const cookies = normalizeCookies(raw.cookies);
  const headers = normalizeStringRecord(raw.headers, 'headers');
  const flow: VerifyFlow = {
    actions: actions.actions,
    ...(auth ? { auth } : {}),
    ...(localStorage ? { local_storage: localStorage } : {}),
    ...(cookies ? { cookies } : {}),
    ...(headers ? { headers } : {}),
    expect_requests: normalizeExpectedRequests(raw.expect_requests),
    visible_only: raw.visible_only === true,
    viewports: normalizeViewports(raw.viewports),
  };
  assertSessionSeedSize(flow);
  return flow;
}

export function loadVerifyFlow(path?: string, cwd = process.cwd()): VerifyFlow {
  if (!path) return normalizeVerifyFlow(undefined);
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) throw new Error(`Flow file not found: ${absolute}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(`Flow file is not valid JSON: ${absolute} — ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return normalizeVerifyFlow(parsed, dirname(absolute));
}

function resolveViewport(input: VerifyViewportInput): ResolvedViewport {
  if (input === 'desktop') return { label: 'desktop', width: 1280, height: 800, wire: 'desktop' };
  if (input === 'mobile') return { label: 'mobile', width: 390, height: 844, wire: 'mobile' };
  return { label: input.label, width: input.width, height: input.height, wire: { width: input.width, height: input.height } };
}

function actionName(action: BrowserSequenceAction | undefined, fallback: string): string {
  if (!action) return fallback;
  if ('click' in action) return `click ${action.click}`;
  if ('fill' in action) return `fill ${action.fill}`;
  if ('upload' in action) return `upload ${action.upload}`;
  if ('select' in action) return `select ${action.select}`;
  if ('wait' in action) return `wait ${String(action.wait)}`;
  if ('expect' in action) return `expect ${action.expect.selector}`;
  if ('screenshot' in action) return `screenshot ${action.screenshot}`;
  return `eval ${action.eval}`;
}

function reportPassed(report: BrowserResult): boolean {
  const screenshotHealthy = (report.screenshots ?? []).some((shot) => {
    if (typeof shot === 'string') return shot.length > 0;
    return !shot.error && !!(shot.path ?? shot.url ?? shot.fs_path ?? shot.scratch_url);
  });
  return report.passed !== false
    && (report.page_errors?.length ?? 0) === 0
    && (report.console_errors?.length ?? 0) === 0
    && (report.failed_requests?.length ?? 0) === 0
    && !(report.request_expectations ?? []).some((item) => !item.ok)
    && screenshotHealthy;
}

function shapeVerificationReport(
  target: string,
  flow: VerifyFlow,
  runs: Array<{ viewport: ResolvedViewport; report: BrowserResult }>,
): VerifyReport {
  const steps: VerifyStepReport[] = [];
  const pageErrors: Array<VerifySignal<unknown>> = [];
  const consoleErrors: Array<VerifySignal<unknown>> = [];
  const failedRequests: Array<VerifySignal<unknown>> = [];
  const expectations: Array<VerifySignal<BrowserRequestExpectationResult>> = [];
  const screenshots: VerifyScreenshotReport[] = [];

  for (const { viewport, report } of runs) {
    for (const [index, step] of (report.steps ?? []).entries()) {
      const sourceIndex = typeof step.step === 'number' ? step.step : index;
      // The local browser models its requested final capture as an internal
      // screenshot step. Hosted capture_after does not, so keep the public
      // verification steps limited to the caller's flow on both halves.
      if (sourceIndex >= flow.actions.length && step.action === 'screenshot') continue;
      const passed = (step.ok ?? step.passed) !== false;
      steps.push({
        viewport: viewport.label,
        step: sourceIndex + 1,
        name: actionName(flow.actions[sourceIndex], step.action ?? 'page load'),
        passed,
        ...(step.error ? { error: step.error } : {}),
        ...(typeof step.duration_ms === 'number' ? { duration_ms: step.duration_ms } : {}),
        ...(step.value !== undefined ? { value: step.value } : step.result !== undefined ? { value: step.result } : {}),
      });
    }
    for (const detail of report.page_errors ?? []) pageErrors.push({ viewport: viewport.label, detail });
    for (const detail of report.console_errors ?? []) consoleErrors.push({ viewport: viewport.label, detail });
    for (const detail of report.failed_requests ?? []) failedRequests.push({ viewport: viewport.label, detail });
    for (const detail of report.request_expectations ?? []) expectations.push({ viewport: viewport.label, detail });
    for (const shot of report.screenshots ?? []) {
      if (typeof shot === 'string') {
        screenshots.push({ viewport: viewport.label, label: 'page', path: shot });
      } else {
        screenshots.push({ viewport: viewport.label, label: shot.label ?? 'page', ...shot });
      }
    }
  }

  const failingStep = steps.find((step) => !step.passed);
  const failedExpectation = expectations.find((item) => !item.detail.ok);
  const failedScreenshot = runs.find(({ report }) => !report.screenshots?.some((shot) => {
    if (typeof shot === 'string') return shot.length > 0;
    return !shot.error && !!(shot.path ?? shot.url ?? shot.fs_path ?? shot.scratch_url);
  }));
  const passed = runs.every(({ report }) => reportPassed(report));
  let verdict: string;
  if (failingStep) {
    verdict = `FAIL — step ${failingStep.step} (${failingStep.name}) failed at ${failingStep.viewport}${failingStep.error ? `: ${failingStep.error}` : '.'}`;
  } else if (pageErrors.length) {
    verdict = `FAIL — page error at ${pageErrors[0].viewport}: ${String(pageErrors[0].detail)}`;
  } else if (consoleErrors.length) {
    verdict = `FAIL — console error at ${consoleErrors[0].viewport}: ${String(consoleErrors[0].detail)}`;
  } else if (failedRequests.length) {
    verdict = `FAIL — unexpected request failure at ${failedRequests[0].viewport}: ${JSON.stringify(failedRequests[0].detail)}`;
  } else if (failedExpectation) {
    verdict = `FAIL — expected request ${failedExpectation.detail.path}:${failedExpectation.detail.status} was not observed at ${failedExpectation.viewport}.`;
  } else if (failedScreenshot) {
    verdict = `FAIL — screenshot capture failed at ${failedScreenshot.viewport.label}.`;
  } else {
    verdict = flow.actions.length
      ? `PASS — ${flow.actions.length} step${flow.actions.length === 1 ? '' : 's'} passed at ${runs.map((run) => run.viewport.label).join(' and ')}; page, console, and network healthy.`
      : `PASS — default page check passed at ${runs.map((run) => run.viewport.label).join(' and ')}; page, console, and network healthy.`;
  }

  return {
    passed,
    verdict,
    target,
    viewports: runs.map(({ viewport, report }) => ({
      label: viewport.label,
      width: viewport.width,
      height: viewport.height,
      passed: reportPassed(report),
      final_url: report.final_url ?? target,
    })),
    steps,
    health: {
      page: { passed: pageErrors.length === 0, errors: pageErrors },
      console: { passed: consoleErrors.length === 0, errors: consoleErrors },
      network: {
        passed: failedRequests.length === 0 && expectations.every((item) => item.detail.ok),
        failed_requests: failedRequests,
        expectations,
      },
    },
    screenshots,
  };
}

export async function runVerification(
  target: VerificationTarget,
  flow: VerifyFlow,
  client?: ApiClient,
): Promise<VerifyReport> {
  if (!target.url && !target.project_id) throw new Error('Verification needs a URL or project.');
  const hasSessionSeed = flow.auth !== undefined || flow.local_storage !== undefined
    || flow.cookies !== undefined || flow.headers !== undefined;
  if (hasSessionSeed && !target.project_id && !(target.url && isLoopbackUrl(target.url))) {
    throw new Error('Authenticated verification needs --project so session data stays locked to that project origin.');
  }
  const resolved = flow.viewports.map(resolveViewport);
  const targetLabel = target.url ?? target.project_id ?? '(unknown target)';
  if (target.url && isLoopbackUrl(target.url)) {
    if (flow.auth) {
      throw new Error('auth user impersonation is not available against a local address; use local_storage, cookies, or headers for a session you already hold.');
    }
    const localUrl = target.url;
    const runs = await Promise.all(resolved.map(async (viewport) => {
      const report = await runLocalBrowser({
        url: localUrl,
        actions: flow.actions,
        actionScreenshotPrefix: `somewhere-verify-${viewport.label}`,
        expectedRequests: flow.expect_requests,
        visibleOnly: flow.visible_only,
        localStorage: flow.local_storage,
        cookies: flow.cookies,
        headers: flow.headers,
        screenshotPath: resolve(`somewhere-verify-${viewport.label}.jpg`),
        viewport: { width: viewport.width, height: viewport.height },
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      return { viewport, report };
    }));
    return shapeVerificationReport(targetLabel, flow, runs);
  }

  if (!client) throw new Error('Hosted verification needs an authenticated API client.');
  const runs = await Promise.all(resolved.map(async (viewport) => {
    const report = await client.call<BrowserResult>('POST', '/browser/test', {
      ...target,
      actions: flow.actions,
      ...(flow.auth ? { auth: flow.auth } : {}),
      ...(flow.local_storage ? { local_storage: flow.local_storage } : {}),
      ...(flow.cookies ? { cookies: flow.cookies } : {}),
      ...(flow.headers ? { headers: flow.headers } : {}),
      expect_requests: flow.expect_requests,
      visible_only: flow.visible_only,
      viewport: viewport.wire,
      capture_after: true,
      inline: false,
      ...(!target.project_id ? { store: true } : {}),
    }, undefined, { timeoutMs: VERIFY_TIMEOUT_MS });
    return { viewport, report };
  }));
  return shapeVerificationReport(targetLabel, flow, runs);
}

export function formatVerifyReport(report: VerifyReport): string[] {
  const lines = [report.passed ? green(report.verdict) : red(report.verdict)];
  for (const step of report.steps) {
    lines.push(`step ${step.step} ${step.passed ? green('✓') : red('✗')} [${step.viewport}] ${step.name}${step.error ? ` ${dim(`— ${step.error}`)}` : ''}`);
  }
  lines.push(`page_health: ${report.health.page.passed ? green('PASS') : red('FAIL')}`);
  lines.push(`console_health: ${report.health.console.passed ? green('PASS') : red('FAIL')}`);
  lines.push(`network_health: ${report.health.network.passed ? green('PASS') : red('FAIL')}`);
  for (const shot of report.screenshots) {
    const location = shot.url ?? shot.scratch_url ?? shot.fs_path ?? shot.path ?? shot.error ?? '(missing)';
    lines.push(`screenshot: [${shot.viewport}] ${teal(location)}`);
    if (shot.fs_path && (shot.url || shot.scratch_url)) lines.push(`screenshot_file: [${shot.viewport}] ${shot.fs_path}`);
  }
  return lines;
}

export function registerVerify(program: Command): void {
  const cliCookies: Array<{ name: string; value: string }> = [];
  const collectCookie = (value: string): string => {
    const at = value.indexOf('=');
    if (at <= 0) throw new Error('--cookie expects <name>=<value>.');
    cliCookies.push({ name: value.slice(0, at), value: value.slice(at + 1) });
    return value;
  };
  program
    .command('verify [target]')
    .description('Run one browser flow at desktop and phone size, report every step and health signal, and capture both screenshots.')
    .option('--project <ref>', 'Project to verify. Defaults to the linked project when --url is omitted.')
    .option('--url <url>', 'Live or local URL to verify.')
    .option('--flow <file.json>', 'Flow JSON with actions, session seeds, expect_requests, visible_only, and viewports. Omit for the default health check.')
    .option('--session <session-id>', 'Existing app session value to seed as localStorage sw_auth in every viewport.')
    .option('--cookie <name=value>', 'Existing app cookie to seed in every viewport. Repeatable.', collectCookie)
    .option('--json', 'Print the structured verification report as JSON.')
    .action(async (target: string | undefined, opts: { project?: string; url?: string; flow?: string; session?: string; cookie?: string; json?: boolean }) => {
      try {
        const url = opts.url ?? (target && /^https?:\/\//i.test(target) ? target : undefined);
        const project = opts.project ?? (url ? undefined : target ?? loadProjectConfig()?.project_id);
        if (!url && !project) throw new Error('Nothing to verify. Pass --url, --project, or run from a linked project directory.');
        const loadedFlow = loadVerifyFlow(opts.flow);
        const flow: VerifyFlow = {
          ...loadedFlow,
          ...(opts.session ? { local_storage: { ...loadedFlow.local_storage, sw_auth: opts.session } } : {}),
          ...(cliCookies.length ? { cookies: [...(loadedFlow.cookies ?? []), ...cliCookies] } : {}),
        };
        assertSessionSeedSize(flow);
        const local = !!url && isLoopbackUrl(url);
        const report = await runVerification(
          { ...(project ? { project_id: project } : {}), ...(url ? { url } : {}) },
          flow,
          local ? undefined : new ApiClient(getToken()),
        );
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else for (const line of formatVerifyReport(report)) console.log(line);
        process.exit(report.passed ? 0 : 1);
      } catch (cause) {
        if (cause instanceof CliApiError && cause.code === 'VALIDATION_ERROR'
            && /provide exactly one of|unknown action|unsupported action|upload is not supported|screenshot is not supported/i.test(cause.message)) {
          error('VERIFY_ACTION_NOT_AVAILABLE: Browser upload and named screenshot actions are not available on this platform version yet.');
          process.exit(1);
        }
        if (cause instanceof CliApiError) {
          error(`${cause.message} ${dim(`[${cause.code}${cause.statusCode ? `, HTTP ${cause.statusCode}` : ''}]`)}`);
        } else {
          error(cause instanceof Error ? cause.message : String(cause));
        }
        process.exit(1);
      }
    });
}
