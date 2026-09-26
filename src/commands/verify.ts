import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadConfig, loadProjectConfig, loadTempSession } from '../lib/config.js';
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
  /** The platform's non-blocking layout line per run: contrast, horizontal
   *  overflow, and tap-target sizing at that viewport. */
  layout: Array<VerifySignal<string>>;
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

interface ProjectOrigins {
  prod?: string | null;
  prod_fallback?: string | null;
  dev?: string | null;
}

/** A directory link is a hint, never proof that the current login owns a URL. */
export async function linkedVerifyTarget(
  url: string,
  client: ApiClient,
  linkedProjectId?: string,
): Promise<string | undefined> {
  if (!linkedProjectId) return undefined;
  let origin: string;
  try { origin = new URL(url).origin; } catch { return undefined; }
  try {
    const urls = await client.call<ProjectOrigins>('GET', `/projects/${encodeURIComponent(linkedProjectId)}/urls`);
    return [urls.prod, urls.prod_fallback, urls.dev].some((candidate) => {
      if (!candidate) return false;
      try { return new URL(candidate).origin === origin; } catch { return false; }
    }) ? linkedProjectId : undefined;
  } catch {
    // Failed ownership lookups confer no authority. The browser route remains
    // the final authority for any explicitly supplied project.
    return undefined;
  }
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
  if (raw.actors !== undefined || raw.journey !== undefined) {
    throw new Error('This is a multi-user flow (actors + journey). Run it with `somewhere verify --project <project> --flow <file>`.');
  }
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
  if ('goto' in action) return `goto ${action.goto}`;
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
  flow: Pick<VerifyFlow, 'actions'>,
  runs: Array<{ viewport: ResolvedViewport; report: BrowserResult; actions?: BrowserSequenceAction[] }>,
): VerifyReport {
  const steps: VerifyStepReport[] = [];
  const pageErrors: Array<VerifySignal<unknown>> = [];
  const consoleErrors: Array<VerifySignal<unknown>> = [];
  const failedRequests: Array<VerifySignal<unknown>> = [];
  const expectations: Array<VerifySignal<BrowserRequestExpectationResult>> = [];
  const screenshots: VerifyScreenshotReport[] = [];
  const layout: Array<VerifySignal<string>> = [];

  for (const { viewport, report, actions: runActions } of runs) {
    const actions = runActions ?? flow.actions;
    if (typeof report.accessibility_layout === 'string' && report.accessibility_layout) {
      layout.push({ viewport: viewport.label, detail: report.accessibility_layout });
    }
    for (const [index, step] of (report.steps ?? []).entries()) {
      const sourceIndex = typeof step.step === 'number' ? step.step : index;
      // The local browser models its requested final capture as an internal
      // screenshot step. Hosted capture_after does not, so keep the public
      // verification steps limited to the caller's flow on both halves.
      if (sourceIndex >= actions.length && step.action === 'screenshot') continue;
      const passed = (step.ok ?? step.passed) !== false;
      steps.push({
        viewport: viewport.label,
        step: sourceIndex + 1,
        name: actionName(actions[sourceIndex], step.action ?? 'page load'),
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
    layout,
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

// ── Multi-user journeys (tsk_f49ccbb75f994f1fb5179198087d24de) ──────────────
//
// Several signed-in people in one run: each actor is its own named browser
// session on the platform (a separate browser, so no cookie, storage or cache
// is shared between actors), and the journey's segments run in the order
// written, each as one ordinary bounded browser call. Every call carries the
// project, so the platform's owned-origin rules apply to every actor on every
// step. Sessions this run opened are closed when it ends, whatever the outcome.

export const VERIFY_JOURNEY_LIMITS = {
  actors: 3,
  segments: 12,
  actions_per_segment: 30,
  total_actions: 120,
  deadline_ms: 10 * 60 * 1000,
  segment_timeout_ms: VERIFY_TIMEOUT_MS,
} as const;

export interface VerifyActor {
  auth?: { user_id: string };
  local_storage?: Record<string, string>;
  cookies?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
}

export interface VerifyJourneySegment {
  as: string;
  path?: string;
  actions: BrowserSequenceAction[];
  expect_requests: ExpectedBrowserRequest[];
  visible_only: boolean;
  viewport: VerifyViewportInput;
}

export interface VerifyJourney {
  actors: Record<string, VerifyActor>;
  journey: VerifyJourneySegment[];
}

export interface VerifyJourneySegmentReport {
  segment: number;
  as: string;
  viewport: string;
  path?: string;
  ran: boolean;
  passed: boolean;
  final_url?: string;
  error?: { code: string; message: string };
}

export interface VerifyJourneyReport extends VerifyReport {
  mode: 'journey';
  actors: string[];
  segments: VerifyJourneySegmentReport[];
  browser_runs: number;
  limits: typeof VERIFY_JOURNEY_LIMITS;
  cleanup: Array<{ actor: string; closed: boolean; error?: string }>;
}

const ACTOR_NAME = /^[a-z][a-z0-9_-]{0,15}$/;

function isJourneyPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\s]/.test(value);
}

export function isVerifyJourneyInput(raw: unknown): boolean {
  return isRecord(raw) && (raw.actors !== undefined || raw.journey !== undefined);
}

export function normalizeVerifyJourney(raw: unknown, baseDir = process.cwd()): VerifyJourney {
  const limits = VERIFY_JOURNEY_LIMITS;
  if (!isRecord(raw)) throw new Error('flow must be a JSON object.');
  const extra = Object.keys(raw).filter((key) => key !== 'actors' && key !== 'journey');
  if (extra.length) {
    throw new Error(`A multi-user flow has only "actors" and "journey" (found ${extra.join(', ')}). Put actions, path, viewport and expect_requests on each journey segment, and session seeds on each actor.`);
  }
  if (!isRecord(raw.actors)) throw new Error('actors must be an object such as { "alice": {}, "bob": { "auth": { "user_id": "..." } } }.');
  const names = Object.keys(raw.actors);
  if (names.length < 1 || names.length > limits.actors) {
    throw new Error(`actors has ${names.length} entries; a journey has 1 to ${limits.actors} actors, each its own browser.`);
  }
  const actors: Record<string, VerifyActor> = {};
  for (const name of names) {
    if (!ACTOR_NAME.test(name)) throw new Error(`actor name "${name}" must be 1-16 lowercase letters, digits, "-" or "_", starting with a letter.`);
    const value = raw.actors[name];
    if (!isRecord(value)) throw new Error(`actors.${name} must be an object ({} for a signed-out browser).`);
    const unknown = Object.keys(value).filter((key) => !['auth', 'local_storage', 'cookies', 'headers'].includes(key));
    if (unknown.length) throw new Error(`actors.${name} has unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
    const actor: VerifyActor = {};
    const auth = normalizeAuth(value.auth);
    const localStorage = normalizeStringRecord(value.local_storage, `actors.${name}.local_storage`);
    const cookies = normalizeCookies(value.cookies);
    const headers = normalizeStringRecord(value.headers, `actors.${name}.headers`);
    if (auth) actor.auth = auth;
    if (localStorage) actor.local_storage = localStorage;
    if (cookies) actor.cookies = cookies;
    if (headers) actor.headers = headers;
    assertSessionSeedSize(actor);
    actors[name] = actor;
  }
  if (!Array.isArray(raw.journey) || raw.journey.length < 1) throw new Error('journey must be a non-empty array of segments like { "as": "alice", "path": "/", "actions": [...] }.');
  if (raw.journey.length > limits.segments) {
    throw new Error(`journey has ${raw.journey.length} segments; the limit is ${limits.segments}. Each segment is one browser run, so combine consecutive steps by the same actor.`);
  }
  const seen = new Set<string>();
  let total = 0;
  const journey = raw.journey.map((value, index): VerifyJourneySegment => {
    const at = `journey[${index}]`;
    if (!isRecord(value)) throw new Error(`${at} must be an object.`);
    const unknown = Object.keys(value).filter((key) => !['as', 'path', 'actions', 'expect_requests', 'visible_only', 'viewport'].includes(key));
    if (unknown.length) throw new Error(`${at} has unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
    if (typeof value.as !== 'string' || !(value.as in actors)) {
      throw new Error(`${at}.as must name one of the actors (${names.join(', ')}).`);
    }
    if (value.path !== undefined && !isJourneyPath(value.path)) {
      throw new Error(`${at}.path must be a path on this app starting with "/" (for example "/club").`);
    }
    const actions = normalizeBrowserActions(value.actions ?? [], baseDir);
    if (!actions.ok) throw new Error(`${at}: ${actions.error}`);
    if (value.visible_only !== undefined && typeof value.visible_only !== 'boolean') throw new Error(`${at}.visible_only must be boolean.`);
    const continued = seen.has(value.as);
    seen.add(value.as);
    // A continued actor's page moves with a leading goto, which is one action.
    const count = actions.actions.length + (continued && value.path ? 1 : 0);
    if (count > limits.actions_per_segment) {
      throw new Error(`${at} has ${count} actions${continued && value.path ? ' (including the goto for its path)' : ''}; the limit per segment is ${limits.actions_per_segment}. Split it into two segments by the same actor.`);
    }
    total += count;
    const viewport = value.viewport === undefined ? 'desktop' : normalizeViewports([value.viewport])[0];
    return {
      as: value.as,
      ...(value.path !== undefined ? { path: value.path as string } : {}),
      actions: actions.actions,
      expect_requests: normalizeExpectedRequests(value.expect_requests),
      visible_only: value.visible_only === true,
      viewport,
    };
  });
  if (total > limits.total_actions) throw new Error(`journey has ${total} actions in total; the limit is ${limits.total_actions}.`);
  const unused = names.filter((name) => !seen.has(name));
  if (unused.length) throw new Error(`actor${unused.length === 1 ? '' : 's'} ${unused.join(', ')} ${unused.length === 1 ? 'is' : 'are'} declared but never used in the journey.`);
  return { actors, journey };
}

export function loadVerifyInput(path?: string, cwd = process.cwd()):
  | { kind: 'single'; flow: VerifyFlow }
  | { kind: 'journey'; journey: VerifyJourney } {
  if (!path) return { kind: 'single', flow: normalizeVerifyFlow(undefined) };
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) throw new Error(`Flow file not found: ${absolute}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(`Flow file is not valid JSON: ${absolute} — ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return isVerifyJourneyInput(parsed)
    ? { kind: 'journey', journey: normalizeVerifyJourney(parsed, dirname(absolute)) }
    : { kind: 'single', flow: normalizeVerifyFlow(parsed, dirname(absolute)) };
}

export interface VerifyJourneyRun {
  /** The session id each actor uses in this run. */
  readonly sessions: Readonly<Record<string, string>>;
  run(): Promise<VerifyJourneyReport>;
  /** Close every session this run opened. Idempotent; never throws. */
  closeAll(): Promise<VerifyJourneyReport['cleanup']>;
}

export function createVerifyJourneyRun(
  target: VerificationTarget,
  journey: VerifyJourney,
  client: Pick<ApiClient, 'call'>,
  opts: { runId?: string; now?: () => number } = {},
): VerifyJourneyRun {
  const now = opts.now ?? Date.now;
  const runId = opts.runId ?? randomBytes(4).toString('hex');
  const sessions: Record<string, string> = Object.fromEntries(
    Object.keys(journey.actors).map((name) => [name, `vf-${runId}-${name}`]),
  );
  const opened = new Set<string>();
  let closing: Promise<VerifyJourneyReport['cleanup']> | null = null;

  const closeAll = (): Promise<VerifyJourneyReport['cleanup']> => {
    closing ??= (async () => {
      const results: VerifyJourneyReport['cleanup'] = [];
      for (const actor of Object.keys(sessions).filter((name) => opened.has(name))) {
        try {
          const closed = await client.call<{ closed?: boolean }>('POST', '/browser/test', { session_id: sessions[actor] }, undefined, { timeoutMs: 15_000 });
          // false = the platform had already closed it (a failed call closes its own browser).
          results.push({ actor, closed: closed?.closed === true });
        } catch (cause) {
          results.push({
            actor,
            closed: false,
            error: cause instanceof CliApiError ? cause.code : cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      return results;
    })();
    return closing;
  };

  const run = async (): Promise<VerifyJourneyReport> => {
    if (!target.project_id) {
      throw new Error('Multi-user verification needs --project <project>: every actor signs in to that project, and its browsers stay on its addresses.');
    }
    if (target.url && isLoopbackUrl(target.url)) {
      throw new Error('Multi-user journeys run on the deployed app. Deploy first, then run somewhere verify --project <project> --flow <file>.');
    }
    const startedAt = now();
    const segments: VerifyJourneySegmentReport[] = [];
    const runs: Array<{ viewport: ResolvedViewport; report: BrowserResult; actions: BrowserSequenceAction[] }> = [];
    const started = new Set<string>();
    // 'report': the segment ran and its own report failed (the step verdict
    // says why). 'error': the segment could not run or could not continue.
    let stopped: { kind: 'report' | 'error'; segment: number; as: string; viewport: string; code: string; message: string } | null = null;
    try {
      for (const [index, segment] of journey.journey.entries()) {
        const viewport = resolveViewport(segment.viewport);
        const label = `${segment.as} #${index + 1} ${viewport.label}`;
        const base: VerifyJourneySegmentReport = {
          segment: index + 1,
          as: segment.as,
          viewport: viewport.label,
          ...(segment.path ? { path: segment.path } : {}),
          ran: false,
          passed: false,
        };
        if (stopped) { segments.push(base); continue; }
        if (now() - startedAt > VERIFY_JOURNEY_LIMITS.deadline_ms) {
          const message = `The journey passed its ${VERIFY_JOURNEY_LIMITS.deadline_ms / 60000}-minute limit before this segment started.`;
          stopped = { kind: 'error', segment: index + 1, as: segment.as, viewport: viewport.label, code: 'VERIFY_JOURNEY_DEADLINE', message };
          segments.push({ ...base, error: { code: stopped.code, message } });
          continue;
        }
        const actor = journey.actors[segment.as];
        const first = !started.has(segment.as);
        const actions = !first && segment.path ? [{ goto: segment.path } as BrowserSequenceAction, ...segment.actions] : segment.actions;
        const hasSeeds = actor.local_storage !== undefined || actor.cookies !== undefined || actor.headers !== undefined;
        const url = first ? (segment.path ?? target.url ?? (hasSeeds ? '/' : undefined)) : undefined;
        const body: Record<string, unknown> = {
          project_id: target.project_id,
          session_id: sessions[segment.as],
          ...(url ? { url } : {}),
          actions,
          expect_requests: segment.expect_requests,
          visible_only: segment.visible_only,
          viewport: viewport.wire,
          capture_after: true,
          inline: false,
          ...(first && actor.auth ? { auth: actor.auth } : {}),
          ...(first && actor.local_storage ? { local_storage: actor.local_storage } : {}),
          ...(first && actor.cookies ? { cookies: actor.cookies } : {}),
          ...(first && actor.headers ? { headers: actor.headers } : {}),
        };
        opened.add(segment.as);
        started.add(segment.as);
        let report: BrowserResult;
        try {
          report = await client.call<BrowserResult>('POST', '/browser/test', body, undefined, { timeoutMs: VERIFY_JOURNEY_LIMITS.segment_timeout_ms });
        } catch (cause) {
          const code = cause instanceof CliApiError ? cause.code : 'VERIFY_SEGMENT_FAILED';
          const message = cause instanceof Error ? cause.message : String(cause);
          stopped = { kind: 'error', segment: index + 1, as: segment.as, viewport: viewport.label, code, message };
          // A refusal (limit, authority, validation) happens before a browser runs.
          segments.push({ ...base, error: { code, message } });
          continue;
        }
        runs.push({ viewport: { ...viewport, label }, report, actions });
        // A continued actor whose browser was reaped would carry on signed out
        // in a fresh browser; that is a different person, so the journey stops.
        if (!first && report.session_note) {
          const message = `${segment.as}'s browser ended between segments (${report.session_note}), so ${segment.as} is no longer the same signed-in user. Keep each actor's gap between segments under 3 minutes and run the journey again.`;
          stopped = { kind: 'error', segment: index + 1, as: segment.as, viewport: viewport.label, code: 'VERIFY_ACTOR_SESSION_ENDED', message };
          segments.push({ ...base, ran: true, final_url: report.final_url, error: { code: stopped.code, message } });
          continue;
        }
        const passed = reportPassed(report);
        segments.push({ ...base, ran: true, passed, ...(report.final_url ? { final_url: report.final_url } : {}) });
        if (!passed) stopped = { kind: 'report', segment: index + 1, as: segment.as, viewport: viewport.label, code: '', message: '' };
      }
    } finally {
      await closeAll();
    }
    const shaped = shapeVerificationReport(target.url ?? target.project_id, { actions: [] }, runs);
    const names = Object.keys(journey.actors);
    const passed = !stopped && runs.length === journey.journey.length && shaped.passed;
    let verdict: string;
    if (stopped?.kind === 'error') {
      verdict = `FAIL — segment ${stopped.segment} (${stopped.as}, ${stopped.viewport}): ${stopped.message} [${stopped.code}]`;
    } else if (!passed) {
      verdict = shaped.verdict.replace(/^FAIL — /, `FAIL — segment ${stopped?.segment ?? '?'} — `);
    } else {
      verdict = `PASS — ${journey.journey.length} segment${journey.journey.length === 1 ? '' : 's'} by ${names.length} user${names.length === 1 ? '' : 's'} (${names.join(', ')}) passed; page, console, and network healthy.`;
    }
    const cleanup = await closeAll();
    return {
      ...shaped,
      passed,
      verdict,
      mode: 'journey',
      actors: names,
      segments,
      browser_runs: segments.filter((segment) => segment.ran).length,
      limits: VERIFY_JOURNEY_LIMITS,
      cleanup,
    };
  };

  return { sessions, run, closeAll };
}

/** The flow file contract, for agents: `somewhere verify --schema`. */
export function verifyFlowSchema(): Record<string, unknown> {
  const L = VERIFY_JOURNEY_LIMITS;
  const path = { type: 'string', pattern: '^/(?!/)[^\\s\\\\]*$', description: 'A path on the app, e.g. "/club".' };
  const action = {
    description: 'Exactly one action key per item.',
    oneOf: [
      { type: 'object', required: ['click'], properties: { click: { type: 'string', description: 'CSS selector' } }, additionalProperties: false },
      { type: 'object', required: ['fill', 'value'], properties: { fill: { type: 'string' }, value: { type: 'string' } }, additionalProperties: false },
      { type: 'object', required: ['select', 'value'], properties: { select: { type: 'string' }, value: { type: 'string' } }, additionalProperties: false },
      { type: 'object', required: ['upload', 'file'], properties: { upload: { type: 'string' }, file: { type: 'string', description: 'Local path, data URL, or base64' }, name: { type: 'string' } }, additionalProperties: false },
      { type: 'object', required: ['wait'], properties: { wait: { oneOf: [{ type: 'string' }, { type: 'number', minimum: 0 }, { type: 'object', required: ['selector'], properties: { selector: { type: 'string' } } }] } }, additionalProperties: false },
      { type: 'object', required: ['expect'], properties: { expect: { type: 'object', required: ['selector'], properties: { selector: { type: 'string' }, text: { type: 'string' }, value: { type: 'string' }, visible: { type: 'boolean' }, count: { type: 'integer', minimum: 0 } } } }, additionalProperties: false },
      { type: 'object', required: ['screenshot'], properties: { screenshot: { type: 'string', description: 'Label' } }, additionalProperties: false },
      { type: 'object', required: ['eval'], properties: { eval: { type: 'string', description: 'Page script on your own app; its value is reported and a throw fails the step. Use it for in-page API checks.' } }, additionalProperties: false },
      { type: 'object', required: ['goto'], properties: { goto: path }, additionalProperties: false },
    ],
  };
  const expectRequests = { type: 'array', maxItems: 30, items: { type: 'object', required: ['path', 'status'], properties: { path: { type: 'string' }, status: { type: 'integer', minimum: 100, maximum: 599 } }, additionalProperties: false }, description: 'Responses the flow intends, such as a 403 for another user. Seen = not a failure; missing = failure.' };
  const viewport = { oneOf: [{ enum: ['desktop', 'mobile'] }, { type: 'object', required: ['label', 'width', 'height'], properties: { label: { type: 'string' }, width: { type: 'integer', minimum: 100, maximum: 3840 }, height: { type: 'integer', minimum: 100, maximum: 2160 } } }] };
  const seeds = {
    auth: { type: 'object', required: ['user_id'], properties: { user_id: { type: 'string', description: 'An existing app user of this project to sign in as.' } }, additionalProperties: false },
    local_storage: { type: 'object', additionalProperties: { type: 'string' } },
    cookies: { type: 'array', items: { type: 'object', required: ['name', 'value'], properties: { name: { type: 'string' }, value: { type: 'string' } } } },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'somewhere verify --flow',
    oneOf: [
      {
        title: 'One user',
        type: 'object',
        properties: { actions: { type: 'array', maxItems: 30, items: action }, ...seeds, expect_requests: expectRequests, visible_only: { type: 'boolean' }, viewports: { type: 'array', minItems: 1, maxItems: 4, items: viewport } },
        additionalProperties: false,
      },
      {
        title: 'Several users (needs --project; hosted apps; claimed accounts)',
        type: 'object',
        required: ['actors', 'journey'],
        properties: {
          actors: {
            type: 'object', minProperties: 1, maxProperties: L.actors,
            propertyNames: { pattern: ACTOR_NAME.source },
            additionalProperties: { type: 'object', properties: seeds, additionalProperties: false, description: 'Each actor is its own browser. {} starts signed out.' },
          },
          journey: {
            type: 'array', minItems: 1, maxItems: L.segments,
            items: {
              type: 'object', required: ['as'],
              properties: {
                as: { type: 'string', description: 'Actor name' },
                path: { ...path, description: 'Where this segment starts: the actor\'s first page, or a goto for a continued actor.' },
                actions: { type: 'array', maxItems: L.actions_per_segment, items: action },
                expect_requests: expectRequests,
                viewport: { ...viewport, default: 'desktop' },
                visible_only: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    'x-limits': L,
  };
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
  for (const item of report.layout ?? []) lines.push(`layout: [${item.viewport}] ${dim(item.detail)}`);
  return lines;
}

export function formatVerifyJourneyReport(report: VerifyJourneyReport): string[] {
  const lines = formatVerifyReport(report);
  const segmentLines = report.segments.map((segment) => {
    const mark = !segment.ran && !segment.error ? dim('not run') : segment.passed ? green('✓') : red('✗');
    return `segment ${segment.segment} ${mark} ${segment.as} [${segment.viewport}]${segment.path ? ` ${segment.path}` : ''}${segment.error ? ` ${dim(`— ${segment.error.code}`)}` : ''}`;
  });
  const cleanup = report.cleanup.length
    ? `browsers closed: ${report.cleanup.map((item) => `${item.actor} ${item.closed ? 'closed' : item.error ? `not closed (${item.error}; it expires within 3 minutes)` : 'already closed'}`).join(', ')}`
    : 'browsers closed: none were opened';
  return [lines[0], ...segmentLines, ...lines.slice(1), `browser runs used: ${report.browser_runs}`, cleanup];
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
    .option('--project <ref>', 'Project to verify. With --url, use this when the directory is unlinked or points to another project.')
    .option('--url <url>', 'Live or local URL to verify.')
    .option('--flow <file.json>', 'Flow JSON with actions, session seeds, expect_requests, visible_only, and viewports. Omit for the default health check.')
    .option('--session <session-id>', 'Existing app session value to seed as localStorage sw_auth in every viewport.')
    .option('--cookie <name=value>', 'Existing app cookie to seed in every viewport. Repeatable.', collectCookie)
    .option('--json', 'Print the structured verification report as JSON.')
    .option('--schema', 'Print the JSON Schema for --flow files (one user, or several users) and exit.')
    .addHelpText('after', `
Minimal --flow JSON:
  {
    "actions": [
      { "click": "#save" },
      { "expect": { "selector": "#status", "text": "Saved" } }
    ],
    "expect_requests": [{ "path": "/api/save", "status": 200 }],
    "viewports": ["desktop", "mobile"]
  }

Save that object as flow.json, then pass --flow flow.json.
For the complete flow and action schema, run: somewhere docs browser

Several users in one run (--project required; each actor is its own browser):
  {
    "actors": { "alice": {}, "bob": {} },
    "journey": [
      { "as": "alice", "path": "/signup", "actions": [{ "click": "#create" }] },
      { "as": "bob", "path": "/club", "actions": [{ "click": "#join" }],
        "expect_requests": [{ "path": "/api/admin", "status": 403 }] },
      { "as": "alice", "path": "/club", "viewport": "mobile",
        "actions": [{ "eval": "fetch('/api/state').then(r => r.status)" }] }
    ]
  }
Segments run in order; a later segment for the same actor continues in that
actor's browser (path becomes a goto). Limits: ${VERIFY_JOURNEY_LIMITS.actors} actors, ${VERIFY_JOURNEY_LIMITS.segments} segments,
${VERIFY_JOURNEY_LIMITS.actions_per_segment} actions per segment, ${VERIFY_JOURNEY_LIMITS.total_actions} in total, ${VERIFY_JOURNEY_LIMITS.deadline_ms / 60000} minutes. Each segment is one browser
run against your plan's browser limits. Actor browsers are closed when the run
ends. Print the full flow schema with: somewhere verify --schema
`)
    .action(async (target: string | undefined, opts: { project?: string; url?: string; flow?: string; session?: string; cookie?: string; json?: boolean; schema?: boolean }) => {
      if (opts.schema) {
        console.log(JSON.stringify(verifyFlowSchema(), null, 2));
        process.exit(0);
      }
      try {
        const url = opts.url ?? (target && /^https?:\/\//i.test(target) ? target : undefined);
        const local = !!url && isLoopbackUrl(url);
        const linkedProjectId = loadProjectConfig()?.project_id;
        const config = loadConfig();
        const primaryUsable = !!config?.token && (!config.temporary
          || !config.temp_expires_at || Date.parse(config.temp_expires_at) > Date.now());
        let client: ApiClient | undefined = local || !primaryUsable ? undefined : new ApiClient(getToken());
        let project = opts.project ?? (target && !/^https?:\/\//i.test(target) ? target : undefined)
          ?? (url ? undefined : linkedProjectId);
        if (!url && !project) throw new Error('Nothing to verify. Pass --url, --project, or run from a linked project directory.');
        if (url && !local && !opts.project) {
          if (!project && client) project = await linkedVerifyTarget(url, client, linkedProjectId);
          if (!project) {
            const temporary = loadTempSession();
            if (temporary?.project?.project_id && temporary.token
                && (!temporary.temp_expires_at || Date.parse(temporary.temp_expires_at) > Date.now())) {
              const tempClient = new ApiClient(temporary.token);
              const tempProject = await linkedVerifyTarget(url, tempClient, temporary.project.project_id);
              if (tempProject) {
                project = tempProject;
                client = tempClient;
              }
            }
          }
        }
        if (!local && !client) client = new ApiClient(getToken());
        const input = loadVerifyInput(opts.flow);
        if (input.kind === 'journey') {
          if (opts.session || cliCookies.length) {
            throw new Error('--session and --cookie seed one browser; in a multi-user flow put each actor\'s seeds on that actor in the flow file.');
          }
          if (!client) client = new ApiClient(getToken());
          const journeyRun = createVerifyJourneyRun({ ...(project ? { project_id: project } : {}), ...(url ? { url } : {}) }, input.journey, client);
          // Ctrl-C or a terminating signal still closes every actor's browser.
          const onSignal = (signal: NodeJS.Signals) => {
            void journeyRun.closeAll().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
          };
          process.once('SIGINT', onSignal);
          process.once('SIGTERM', onSignal);
          let report: VerifyJourneyReport;
          try {
            report = await journeyRun.run();
          } finally {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
          }
          if (opts.json) console.log(JSON.stringify(report, null, 2));
          else for (const line of formatVerifyJourneyReport(report)) console.log(line);
          process.exit(report.passed ? 0 : 1);
        }
        const loadedFlow = input.flow;
        const flow: VerifyFlow = {
          ...loadedFlow,
          ...(opts.session ? { local_storage: { ...loadedFlow.local_storage, sw_auth: opts.session } } : {}),
          ...(cliCookies.length ? { cookies: [...(loadedFlow.cookies ?? []), ...cliCookies] } : {}),
        };
        assertSessionSeedSize(flow);
        const report = await runVerification(
          { ...(project ? { project_id: project } : {}), ...(url ? { url } : {}) },
          flow,
          client,
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
          if (cause.code === 'BROWSER_ORIGIN_NOT_AUTHORIZED') {
            error(`${cause.message} ${dim(`[${cause.code}${cause.statusCode ? `, HTTP ${cause.statusCode}` : ''}]`)} To drive an app you own, rerun with --project <your-project-id> (for example: somewhere verify --project <your-project-id> --url <your-app-url> --flow flow.json).`, cause);
          } else {
            error(`${cause.message} ${dim(`[${cause.code}${cause.statusCode ? `, HTTP ${cause.statusCode}` : ''}]`)}`, cause);
          }
        } else {
          error(cause instanceof Error ? cause.message : String(cause), cause);
        }
        process.exit(1);
      }
    });
}
