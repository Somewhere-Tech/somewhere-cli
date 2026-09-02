/**
 * Keep the platform's own telemetry out of the developer's terminal
 * (tsk_eef0a0ef).
 *
 * `somewhere dev` runs the DEPLOYED function runtime, vendored verbatim. That
 * runtime instruments itself for the platform's telemetry sink: it writes a
 * `SW_QUERY` line per database call, a `SW_DB_*` timing blob when a call is
 * slow or first-touch, and a warning when its background flush of query
 * observations is refused. In the deployed worker those lines go to the
 * platform's log pipeline. Locally there is no pipeline — they land in the
 * developer's terminal, next to their own console.log:
 *
 *     [SW_QUERY_OBSERVATIONS] deferred flush failed: HTTP 403
 *     [SW_DB_FIRST_TOUCH] {"event":"SW_DB_FIRST_TOUCH","execution_path":"rest",
 *                          "database_region":"WNAM","edge_region":null,…}
 *
 * Two things wrong with that, and this module fixes both without touching the
 * vendored file (it is hash-guarded; a hand-edit is a failing build, and a
 * local fork of the runtime is the divergence the whole loop exists to remove).
 *
 * 1. THE 403 IS NOT THE DEVELOPER'S. The observation channel is ours, it is
 *    entitlement-gated, and a plan without the entitlement is refused by
 *    design. Nothing in the app is wrong and nothing the developer can do
 *    changes it — but an agent reading the terminal treats a repeated
 *    "failed: HTTP 403" as a symptom of the code it just wrote.
 * 2. IT LEAKS OUR PLUMBING. `execution_path`, `database_region`, `edge_region`,
 *    "activation, placement, transport, queueing, binding" — internal database
 *    mechanics, rendered as raw JSON into a customer's terminal.
 *
 * WHAT IS NOT SUPPRESSED: anything the developer's own code prints, every
 * error the runtime raises, and every failure of a call they made. Only the
 * background telemetry channel is quiet, and only by default —
 * `SOMEWHERE_DEV_TELEMETRY=1` prints every line through untouched, so the
 * channel stays inspectable when we are the ones debugging it.
 */

/** Set this to any non-empty value other than `0`/`false` to see the raw lines. */
export const TELEMETRY_ENV = 'SOMEWHERE_DEV_TELEMETRY';

export function telemetryVisible(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TELEMETRY_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false' && value !== 'no';
}

/**
 * Is this console call the vendored runtime reporting to the platform, rather
 * than the app reporting to its developer?
 *
 * Matched by SHAPE, never by an enumerated list of event names — a list goes
 * stale on the next re-vendor and the leak comes back silently. The runtime
 * emits exactly three shapes, and each is self-identifying:
 *
 *   a. `[<EVENT>] <json>` where the JSON's own `event` field equals <EVENT>
 *      and starts with `SW_`. That pairing is what makes it ours; a developer
 *      logging a string that merely begins with `[SW_` does not produce it.
 *   b. `[SW_QUERY_OBSERVATIONS] …` — the background flush channel, whose only
 *      output is the failure of a request the developer did not make.
 *   c. a bare JSON object whose `event` starts with `SW_` (the per-query
 *      `SW_QUERY` line, emitted with no prefix at all).
 */
export function isPlatformTelemetry(args: unknown[]): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  if (typeof first !== 'string') return false;
  const line = first.trimStart();

  // (b) the observation channel — its own name is the whole signal.
  if (line.startsWith('[SW_QUERY_OBSERVATIONS]')) return true;

  // (a) `[EVENT] {json}` where the JSON agrees it is that event.
  const prefixed = /^\[(SW_[A-Z0-9_]+)\]\s*(\{[\s\S]*)$/.exec(line);
  if (prefixed) return eventNameOf(prefixed[2]) === prefixed[1];

  // (c) a bare telemetry object.
  if (line.startsWith('{')) {
    const event = eventNameOf(line);
    return event !== null && event.startsWith('SW_');
  }

  return false;
}

function eventNameOf(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const event = (parsed as { event?: unknown }).event;
    return typeof event === 'string' ? event : null;
  } catch {
    return null;
  }
}

let installed = false;

/**
 * Filter the platform's telemetry out of console.log / warn / error for the
 * rest of this process. Idempotent, and a no-op when the developer asked to
 * see it. Returns a restore function — the tests use it; the CLI does not,
 * because the local loop owns the process for its whole life.
 */
export function installTelemetryFilter(env: NodeJS.ProcessEnv = process.env): () => void {
  if (installed || telemetryVisible(env)) return () => {};
  installed = true;
  const methods = ['log', 'warn', 'error'] as const;
  const original = methods.map((m) => [m, console[m]] as const);
  for (const [method, fn] of original) {
    console[method] = (...args: unknown[]) => {
      if (isPlatformTelemetry(args)) return;
      fn(...(args as []));
    };
  }
  return () => {
    for (const [method, fn] of original) console[method] = fn;
    installed = false;
  };
}
