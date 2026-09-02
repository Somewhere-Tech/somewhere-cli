import { resolve } from 'node:path';
import { Command } from 'commander';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { isLoopbackUrl, runLocalBrowser, type LocalBrowserReport } from '../local/browser-run.js';
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
   *  it carries `fs_path` (where the file lives) plus `url` (a short-lived link
   *  that opens it); in EYES mode it carries either `inline_base64` (the image
   *  bytes — not renderable in a terminal) or, with --store, a short-TTL
   *  `scratch_url` (+ `scratch_expires_at`). */
  screenshots?: Array<
    | string
    | {
        label?: string;
        path?: string;
        /** A link that OPENS the stored image. `fs_path` is where the file
         *  lives; this is what you fetch to see it. Short-lived. */
        url?: string;
        url_expires_at?: string;
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
  /** Structured extraction (--extract / --include markdown): the page as clean markdown. */
  markdown?: string;
  /** Persistent session (--session): the handle to reconnect on the next call. */
  session_id?: string;
  session_expires_at?: string;
  /** Fail-soft note, e.g. "session expired, started fresh". */
  session_note?: string;
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
  extract?: boolean;
  session?: string;
  json?: boolean;
}

const looksLikeUrl = (s?: string): boolean => !!s && /^https?:\/\//i.test(s);

/**
 * Build the POST /v1/browser request body from the positional `target` + flags.
 *
 * Target precedence: an explicit --url (or a positional that looks like a URL)
 * becomes `url`; otherwise --project (or a non-URL positional, then the linked
 * project) becomes `project_id`. The action flags compile to an ordered `steps`
 * array (goto → wait_for → eval → screenshot). `--snapshot` is not a step — it
 * prints the DOM map — but the map is an opt-in section, so it adds `dom` to
 * `include`. `--store` (EYES mode: get a scratch signed URL instead of an
 * inline shot) and `--include` forward the matching request params.
 */
export function buildBrowserBody(
  target: string | undefined,
  opts: BrowserOptions,
  linkedProject?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  const url = opts.url ?? (looksLikeUrl(target) ? target : undefined);
  // A URL is an explicit EYES-mode target. Do not let an unrelated linked
  // project silently turn it into origin-locked VERIFY mode. An explicit
  // --project still wins when the caller intentionally supplies both.
  const project = opts.project ?? (url ? undefined : target ?? linkedProject);
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
  // Opt-in heavy sections. Split the CSV, trim, and drop empties; the worker
  // filters to the known section names.
  const sections = new Set(
    (opts.include ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  // `--snapshot` PRINTS the interactive-element map, so it has to ASK for it.
  // The DOM map is an opt-in section; without this the flag rendered whatever
  // the response happened to carry, which was nothing — `--wait button
  // --snapshot` matched a button and then printed "dom: 0 interactive
  // elements" on a page with three of them (tsk_bdd72f02c2).
  if (opts.snapshot) sections.add('dom');
  if (sections.size) body.include = [...sections];
  // Structured extraction: read the page as clean markdown (feature A).
  if (opts.extract) body.extract = 'markdown';
  // Persistent session: reuse ONE live browser across calls (feature B).
  if (opts.session) body.session_id = opts.session;
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

/** Make the response verdict agree with the command's health/exit contract. */
export function normalizeBrowserVerdict(r: BrowserResult): BrowserResult {
  if (browserExitCode(r) === 0 || r.passed === false) return r;
  return { ...r, passed: false };
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
  // Persistent session (feature B): surface the handle to reconnect + its expiry.
  if (r.session_id) {
    const exp = r.session_expires_at ? dim(` (expires ${r.session_expires_at})`) : '';
    lines.push(`session: ${r.session_id}${exp}`);
    if (r.session_note) lines.push(`session_note: ${dim(r.session_note)}`);
  }
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
    } else if (shot.url ?? shot.fs_path ?? shot.path) {
      // VERIFY mode: the image is a file in the project. Lead with the link
      // that OPENS it — a bare storage path reads like a URL and is not one,
      // so the value the command handed back for "here is your screenshot"
      // could not be used to see it (tsk_70fd0f63a9). The stored path follows,
      // because that is the durable handle for reading or replacing it later.
      const openable = shot.url ?? shot.path;
      const stored = shot.fs_path;
      if (openable && stored) {
        const exp = shot.url_expires_at ? dim(` (link expires ${shot.url_expires_at})`) : '';
        lines.push(`screenshot: ${label}${openable}${exp}`);
        lines.push(`screenshot_file: ${label}${stored}`);
      } else {
        lines.push(`screenshot: ${label}${openable ?? stored}`);
      }
    } else if (shot.inline_base64) {
      // EYES mode default: the image came back inline. A terminal can't render
      // it — say it was captured and point at the ways to actually view it.
      lines.push(
        `screenshot: ${label}${dim('captured inline (image bytes — not shown in the terminal; re-run with --store for a viewable link, or --json for the base64)')}`,
      );
    }
  }

  // Structured extraction (feature A): the page as clean markdown, printed last
  // so it doesn't bury the signals. Fenced so it's obvious where it starts/ends.
  if (typeof r.markdown === 'string' && r.markdown.length) {
    lines.push('--- markdown ---');
    for (const l of r.markdown.split('\n')) lines.push(l);
    lines.push('--- end markdown ---');
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

/** Layout geometry, matching the hosted browser's two presets. */
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

/**
 * Flags the local half cannot honour, and why. Named individually — a flag
 * that is silently ignored is worse than one that is refused, because the
 * report still looks complete.
 */
const LOCAL_UNSUPPORTED: Array<{ flag: keyof BrowserOptions; why: string }> = [
  { flag: 'store', why: 'the scratch store is a platform feature; the local run writes the image to a file with --screenshot' },
  { flag: 'session', why: 'persistent sessions are kept alive on the platform; a local run is always a fresh browser' },
  { flag: 'extract', why: 'markdown extraction runs on the platform' },
];

/**
 * Run the health check against a page this machine is serving, and print it
 * with the same formatter the hosted run uses.
 */
async function runLocalBrowserCommand(url: string, opts: BrowserOptions): Promise<void> {
  for (const { flag, why } of LOCAL_UNSUPPORTED) {
    if (opts[flag]) {
      error(`--${flag} is not available against a local address — ${why}.`);
      process.exit(1);
    }
  }
  const unsupportedSections = (opts.include ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'dom');
  if (unsupportedSections.length) {
    error(
      `--include ${unsupportedSections.join(',')} is not available against a local address — ` +
        'only the DOM map is collected locally.',
    );
    process.exit(1);
  }

  const viewport = opts.viewport === 'mobile' ? VIEWPORTS.mobile : VIEWPORTS.desktop;
  let report: LocalBrowserReport;
  try {
    report = await runLocalBrowser({
      url,
      path: opts.path,
      wait: opts.wait,
      eval: opts.eval,
      // No project is involved, so there is nowhere on the platform to store
      // the image; write it beside the developer instead.
      screenshotPath: opts.screenshot ? resolve('somewhere-browser.jpg') : undefined,
      viewport,
      timeoutMs: BROWSER_TIMEOUT_MS,
    });
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const shaped: BrowserResult = report;
  if (opts.json) {
    console.log(JSON.stringify(shaped, null, 2));
    process.exit(browserExitCode(shaped));
  }
  console.log(dim(`local browser — this machine, not the platform's`));
  for (const line of formatBrowserReport(shaped, { snapshot: opts.snapshot })) {
    console.log(line);
  }
  process.exit(browserExitCode(shaped));
}

export function registerBrowser(program: Command) {
  program
    .command('browser [target]')
    .description(
      'SEE, inspect, and DRIVE any web page and print the combined HEALTH SIGNAL — console ' +
        'errors, failed requests, JS page errors, and the interactive-element (DOM) map — as ' +
        'grep-able text, not a dumped image. Two modes: EYES (no --project, any public URL — look ' +
        'at / screenshot ANY page) and VERIFY (--project — drive + assert YOUR deployed app). ' +
        'A localhost / 127.0.0.1 target — the app `somewhere dev` is serving — is driven by the ' +
        'browser installed on THIS machine, so you can check a page before you deploy it. ' +
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
      'EYES mode only (no project): store the screenshot in an ephemeral, self-expiring scratch store and print a short-lived link instead of an inline capture. With a project the screenshot is saved into the project files and the report already prints a link that opens it, so this flag is not needed there.',
    )
    .option(
      '--include <sections>',
      'Opt-in heavy sections for a no-steps inspect call: a comma list of "network", "dom", and/or "markdown" (e.g. --include network,dom). Lean by default.',
    )
    .option(
      '--extract',
      'Read the page as clean MARKDOWN (headings, links, lists, main content) in the output instead of vision-parsing a screenshot. Same as --include markdown. No-steps inspect calls.',
    )
    .option(
      '--session <id>',
      'Keep ONE live browser page alive across calls under this handle (1–64 chars: letters/digits/dot/dash/underscore). Navigate in one call, then reconnect with the same --session to wait/screenshot the SAME page (cookies, current URL, in-flight stream preserved). A reconnect skips the initial navigation — use --path to move. Idles out after ~3 min. Omit for the default fresh-per-call browser.',
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
          .filter((s) => s && s !== 'network' && s !== 'dom' && s !== 'markdown');
        if (bad.length) {
          error(`--include only accepts "network", "dom", and/or "markdown" (got "${bad.join(', ')}")`);
          process.exit(1);
        }
      }

      const linked = loadProjectConfig()?.project_id;
      const body = buildBrowserBody(target, opts, linked);

      if (!body.url && !body.project_id) {
        error(
          'Nothing to open. Pass a URL or --project, or run from a linked project directory.',
        );
        process.exit(1);
      }

      // A loopback address is served by THIS machine, so the hosted browser —
      // which runs on the platform, not here — can never reach it. That is why
      // it refuses one. Answer with the browser on this machine instead, so the
      // app `somewhere dev` is serving can be checked before it is deployed.
      if (typeof body.url === 'string' && isLoopbackUrl(body.url)) {
        await runLocalBrowserCommand(body.url, opts);
        return;
      }

      const client = new ApiClient(getToken());
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

      r = normalizeBrowserVerdict(r);

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
