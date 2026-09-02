export interface DatabaseCallTiming {
  totalMs: number;
  platformMs: number | null;
}

export interface DatabaseTimingBreakdown {
  calls: number;
  totalMs: number;
  platformMs: number | null;
  platformReportedCalls: number;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchResult = Awaited<ReturnType<typeof fetch>>;
type FetchLike = (input: FetchInput, init?: FetchInit) => Promise<FetchResult>;

const DATABASE_PATHS = new Set(['/v1/db/query', '/v1/db/batch', '/v1/db/raw-read']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responseData(payload: unknown): Record<string, unknown> | null {
  const root = record(payload);
  return record(root?.data) ?? root;
}

function durationFromMeta(value: unknown): number | null {
  const duration = record(value)?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null;
}

/** Read the current database response contract: data.meta.duration for one
 * query, or each data.results[].meta.duration for a batch. */
export function platformDatabaseDuration(payload: unknown): number | null {
  const data = responseData(payload);
  const direct = durationFromMeta(data?.meta);
  if (direct !== null) return direct;
  if (!Array.isArray(data?.results)) return null;
  const durations = data.results.map((item) => durationFromMeta(record(item)?.meta));
  if (!durations.length || durations.some((duration) => duration === null)) return null;
  return durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0);
}

function requestPath(input: FetchInput): string | null {
  try {
    const url = typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url;
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function roundedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}

/** One collector per incoming localhost request. It observes only database
 * calls and never changes their request, response, retry, or failure behavior. */
export class LocalRequestTiming {
  private readonly calls: DatabaseCallTiming[] = [];
  private readonly pending: Array<Promise<void>> = [];

  constructor(private readonly fetchImpl: FetchLike = globalThis.fetch) {}

  readonly fetch: FetchLike = async (input, init) => {
    if (!DATABASE_PATHS.has(requestPath(input) ?? '')) return this.fetchImpl(input, init);
    const startedAt = performance.now();
    let response: FetchResult;
    try {
      response = await this.fetchImpl(input, init);
    } catch (err) {
      this.calls.push({ totalMs: roundedMs(startedAt), platformMs: null });
      throw err;
    }
    const captured = response.clone().json()
      .then((payload: unknown) => {
        this.calls.push({
          totalMs: roundedMs(startedAt),
          platformMs: platformDatabaseDuration(payload),
        });
      })
      .catch(() => {
        this.calls.push({ totalMs: roundedMs(startedAt), platformMs: null });
      });
    this.pending.push(captured);
    return response;
  };

  async finish(): Promise<DatabaseTimingBreakdown | null> {
    await Promise.all(this.pending);
    if (!this.calls.length) return null;
    const reported = this.calls.filter((call) => call.platformMs !== null);
    return {
      calls: this.calls.length,
      totalMs: Math.round(this.calls.reduce((sum, call) => sum + call.totalMs, 0) * 10) / 10,
      platformMs: reported.length
        ? Math.round(reported.reduce((sum, call) => sum + (call.platformMs ?? 0), 0) * 1000) / 1000
        : null,
      platformReportedCalls: reported.length,
    };
  }
}

export function formatDatabaseTiming(timing: DatabaseTimingBreakdown | null | undefined): string {
  if (!timing) return '';
  const calls = timing.calls === 1 ? '' : ` across ${timing.calls} calls`;
  const platform = timing.platformMs === null
    ? 'platform timing not reported'
    : `${timing.platformMs}ms platform-reported${timing.platformReportedCalls === timing.calls ? '' : ` for ${timing.platformReportedCalls}/${timing.calls} calls`}`;
  return `database ${timing.totalMs}ms total${calls}, ${platform}`;
}
