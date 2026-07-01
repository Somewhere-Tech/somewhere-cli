import { Command } from 'commander';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, green, red, teal } from '../lib/output.js';

/** The browser run drives a real headless session server-side (navigate +
 *  settle + screenshot) — give it a wider budget than a normal API call. */
const BROWSER_TIMEOUT_MS = 90_000;

interface BrowserStepResult {
  action?: string;
  ok?: boolean;
  passed?: boolean;
  selector?: string;
  script?: string;
  path?: string;
  result?: unknown;
  error?: string;
}

/** The combined health response from POST /v1/browser (confirmed shape: the
 *  agent-native browser returns these signals whether or not `steps` ran). */
export interface BrowserResult {
  passed?: boolean;
  final_url?: string;
  console_errors?: unknown[];
  page_errors?: unknown[];
  failed_requests?: unknown[];
  steps?: BrowserStepResult[];
  /** A screenshot is a bare path string (legacy) OR an object. In VERIFY mode
   *  it carries `fs_path` (durable project file); in EYES mode it carries either
   *  `inline_base64` (the image bytes — not renderable in a terminal) or, with
   *  --store, a short-TTL `scratch_url` (+ `scratch_expires_at`). */
  screenshots?: Array<
    | string
    | {
        label?: string;
        path?: string;
        url?: string;
        fs_path?: string;
        inline_base64?: string;
        scratch_url?: string;
        scratch_expires_at?: string;
        error?: string;
      }
  >;
  dom_outline?: Array<{
    tag?: string;
    id?: string;
    testid?: string;
    name?: string;
    aria?: string;
    text?: string;
    selector?: string;
  }>;
  testid_map?: Record<string, unknown>;
}

export interface BrowserOptions {
  project?: string;
  url?: string;
  path?: string;
  wait?: string;
  eval?: string;
  screenshot?: boolean;
  snapshot?: boolean;
  viewport?: string;
  store?: boolean;
  include?: string;
  json?: boolean;
}

const looksLikeUrl = (s?: string): boolean => !!s && /^https?:\/\//i.test(s);

/**
 * Build the POST /v1/browser request body from the positional `target` + flags.
 *
 * Target precedence: an explicit --url (or a positional that looks like a URL)
 * becomes `url`; otherwise --project (or a non-URL positional, then the linked
 * project) becomes `project_id`. The action flags compile to an ordered `steps`
 * array (goto → wait_for → eval → screenshot). `--snapshot` is display-only
 * (the DOM map is always returned) so it is NOT a step here. `--store` (EYES
 * mode: get a scratch signed URL instead of an inline shot) and `--include`
 * (opt-in `network`/`dom` sections) forward the matching request params.
 */
export function buildBrowserBody(
  target: string | undefined,
  opts: BrowserOptions,
  linkedProject?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  const url = opts.url ?? (looksLikeUrl(target) ? target : undefined);
  const project = opts.project ?? (!looksLikeUrl(target) ? target : undefined) ?? linkedProject;
  if (url) body.url = url;
  if (project) body.project_id = project;

  const steps: Array<Record<string, unknown>> = [];
  if (opts.path) steps.push({ action: 'goto', path: opts.path });
  if (opts.wait) steps.push({ action: 'wait_for', selector: opts.wait });
  if (opts.eval) steps.push({ action: 'eval', script: opts.eval });
  if (opts.screenshot) steps.push({ action: 'screenshot' });
  if (steps.length) body.steps = steps;

  if (opts.viewport) body.viewport = opts.viewport;
  if (opts.store) body.store = true;
  // Opt-in heavy sections for a no-steps inspect call. Split the CSV, trim, and
  // drop empties; the worker filters to the known section names.
  if (opts.include) {
    const sections = opts.include.split(',').map((s) => s.trim()).filter(Boolean);
    if (sections.length) body.include = sections;
  }
  return body;
}

/**
 * Exit non-zero when the page is UNHEALTHY: a step failed (`passed === false`),
 * a request failed, or JS threw. Console errors alone are advisory (favicon
 * 404s etc.) and don't fail the gate — they're still printed.
 */
export function browserExitCode(r: BrowserResult): number {
  if (r.passed === false) return 1;
  if ((r.failed_requests?.length ?? 0) > 0) return 1;
  if ((r.page_errors?.length ?? 0) > 0) return 1;
  return 0;
}

function signalText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const msg = o.message ?? o.text ?? o.error ?? JSON.stringify(o);
    const loc = o.url ?? o.source;
    return loc ? `${String(msg)} (${String(loc)})` : String(msg);
  }
  return String(e);
}

function failedRequestText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const parts = [o.status ?? o.statusCode, o.method, o.url].filter(
      (x) => x !== '' && x !== undefined && x !== null,
    );
    return parts.length ? parts.map(String).join(' ') : JSON.stringify(o);
  }
  return String(e);
}

function stringifyResult(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Render the combined health signal as grep-able lines (one signal per line,
 * stable `label:` prefixes) — never the screenshot image itself, just its
 * stored path. Returns the lines so the formatting is unit-testable.
 */
export function formatBrowserReport(
  r: BrowserResult,
  opts: { snapshot?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const ce = r.console_errors ?? [];
  const pe = r.page_errors ?? [];
  const fr = r.failed_requests ?? [];
  const dom = r.dom_outline ?? [];

  const verdict = r.passed === false ? red('FAIL') : green('PASS');
  lines.push(`${verdict} ${teal(r.final_url ?? '(no url)')}`);
  lines.push(`console_errors: ${ce.length}`);
  lines.push(`page_errors: ${pe.length}`);
  lines.push(`failed_requests: ${fr.length}`);
  lines.push(`dom: ${dom.length} interactive element${dom.length === 1 ? '' : 's'}`);

  for (const [i, s] of (r.steps ?? []).entries()) {
    const ok = s.ok ?? s.passed;
    const mark = ok === false ? red('✗') : green('✓');
    const label = [s.action, s.selector ?? s.path ?? s.script].filter(Boolean).join(' ');
    let line = `step ${i + 1} ${mark} ${label}`.trimEnd();
    if (s.error) line += ` ${dim(`— ${s.error}`)}`;
    lines.push(line);
    if (s.result !== undefined) lines.push(`  result: ${stringifyResult(s.result)}`);
  }

  for (const e of ce) lines.push(`console_error: ${signalText(e)}`);
  for (const e of pe) lines.push(`page_error: ${signalText(e)}`);
  for (const e of fr) lines.push(`failed_request: ${failedRequestText(e)}`);

  for (const shot of r.screenshots ?? []) {
    if (typeof shot === 'string') {
      lines.push(`screenshot: ${shot}`);
      continue;
    }
    const label = shot.label ? `${shot.label} — ` : '';
    if (shot.error) {
      lines.push(`screenshot: ${label}${red(`error — ${shot.error}`)}`);
    } else if (shot.scratch_url) {
      // EYES mode + --store: a short-TTL signed link to the full-res image.
      const exp = shot.scratch_expires_at ? dim(` (expires ${shot.scratch_expires_at})`) : '';
      lines.push(`screenshot: ${label}${shot.scratch_url}${exp}`);
    } else if (shot.fs_path ?? shot.path ?? shot.url) {
      // VERIFY mode: a durable project file path (or a legacy path/url).
      lines.push(`screenshot: ${label}${shot.fs_path ?? shot.path ?? shot.url}`);
    } else if (shot.inline_base64) {
      // EYES mode default: the image came back inline. A terminal can't render
      // it — say it was captured and point at the ways to actually view it.
      lines.push(
        `screenshot: ${label}${dim('captured inline (image bytes — not shown in the terminal; re-run with --store for a viewable link, or --json for the base64)')}`,
      );
    }
  }

  // Full interactive-element map only on demand; the count above is the default.
  if (opts.snapshot) {
    for (const el of dom) {
      const handle = el.testid ? `[data-testid=${el.testid}]` : el.selector ?? el.tag ?? '?';
      const text = el.text ? ` "${el.text}"` : '';
      lines.push(`dom: ${el.tag ?? '?'} ${handle}${text}`);
    }
  }
  return lines;
}

export function registerBrowser(program: Command) {
  program
    .command('browser [target]')
    .description(
      'SEE, inspect, and DRIVE any web page and print the combined HEALTH SIGNAL — console ' +
        'errors, failed requests, JS page errors, and the interactive-element (DOM) map — as ' +
        'grep-able text, not a dumped image. Two modes: EYES (no --project, any public URL — look ' +
        'at / screenshot ANY page) and VERIFY (--project — drive + assert YOUR deployed app). ' +
        '`target` is a URL (https://…) or a project ref; defaults to the linked project. ' +
        'Add steps with --path / --wait / --eval / --screenshot. ' +
        'Exits non-zero when the page is unhealthy (a step failed, a request failed, or JS threw).',
    )
    .option(
      '--project <ref>',
      'Project to open (UUID, slug, or subdomain). Defaults to the linked project.',
    )
    .option(
      '--url <url>',
      "Explicit URL to open — any public page, or a path on --project's origin.",
    )
    .option('--path <path>', 'Navigate to this path first (e.g. /login) before the other steps.')
    .option('--wait <selector>', 'Wait for a CSS selector to appear before capturing the signal.')
    .option('--eval <js>', 'Evaluate a JS expression in the page and print its result.')
    .option('--screenshot', 'Capture a screenshot and print its stored path (requires a project).')
    .option('--snapshot', 'Print the full interactive-element / DOM map, not just the count.')
    .option('--viewport <size>', 'desktop (default) or mobile.')
    .option(
      '--store',
      'EYES mode only: store the screenshot in an ephemeral, self-expiring scratch store and print a short-lived signed URL (plus its expiry) instead of an inline capture. Ignored with a project.',
    )
    .option(
      '--include <sections>',
      'Opt-in heavy sections for a no-steps inspect call: a comma list of "network" and/or "dom" (e.g. --include network,dom). Lean by default.',
    )
    .option('--json', 'Print the raw browser response envelope as JSON.')
    .action(async (target: string | undefined, opts: BrowserOptions) => {
      if (opts.viewport && opts.viewport !== 'desktop' && opts.viewport !== 'mobile') {
        error(`--viewport must be "desktop" or "mobile" (got "${opts.viewport}")`);
        process.exit(1);
      }
      if (opts.include) {
        const bad = opts.include
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && s !== 'network' && s !== 'dom');
        if (bad.length) {
          error(`--include only accepts "network" and/or "dom" (got "${bad.join(', ')}")`);
          process.exit(1);
        }
      }

      const client = new ApiClient(getToken());
      const linked = loadProjectConfig()?.project_id;
      const body = buildBrowserBody(target, opts, linked);

      if (!body.url && !body.project_id) {
        error(
          'Nothing to open. Pass a URL or --project, or run from a linked project directory.',
        );
        process.exit(1);
      }
      // The endpoint can only store a screenshot on a project you own.
      if (opts.screenshot && !body.project_id) {
        error('--screenshot needs a project to store the image — pass --project (or a project URL you own).');
        process.exit(1);
      }

      let r: BrowserResult;
      try {
        r = await client.call<BrowserResult>('POST', '/browser/test', body, undefined, {
          timeoutMs: BROWSER_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof CliApiError) {
          error(
            `${err.message} ${dim(`[${err.code}${err.statusCode ? `, HTTP ${err.statusCode}` : ''}]`)}`,
          );
        } else {
          error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        process.exit(browserExitCode(r));
      }

      for (const line of formatBrowserReport(r, { snapshot: opts.snapshot })) {
        console.log(line);
      }
      process.exit(browserExitCode(r));
    });
}
