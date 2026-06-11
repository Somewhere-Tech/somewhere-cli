import type { ApiResponse } from '../types.js';

const BASE_URL = 'https://api.somewhere.tech/v1';

/** Default request timeout. Long-running calls (deploy compiles, pulls)
 *  pass an explicit budget via opts.timeoutMs instead. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Budget for calls that run a real build server-side (npm install alone
 *  can take minutes): /deploy, /deploy/patch, pull/export. */
export const LONG_CALL_TIMEOUT_MS = 10 * 60_000;

export class ApiClient {
  constructor(private readonly token: string) {}

  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    let url = `${BASE_URL}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };

    let reqBody: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(body);
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: reqBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // AbortSignal.timeout fired — no bytes back within the budget. Name it
      // so the user can tell a hang from a rejection (review F8/Q5: a bare
      // fetch hung `somewhere deploy` forever on network silence).
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new CliApiError(
          'TIMEOUT',
          `No response from ${method} ${url.split('?')[0]} after ${Math.round(timeoutMs / 1000)}s. ` +
            'The request may still be processing server-side — check `somewhere status` before retrying a deploy.',
          0,
        );
      }
      // Node's fetch rejects network-level failures with a bare
      // "fetch failed" and buries the real reason (ENOTFOUND,
      // ECONNRESET, UND_ERR_*) in err.cause. Surfacing only the bare
      // message cost a customer an hour of guessing whether it was
      // auth, payload, or network (pfb_70e9d140c5a0) — name the
      // endpoint and the underlying cause.
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail =
        cause?.code ??
        cause?.message ??
        (err instanceof Error ? err.message : String(err));
      throw new CliApiError(
        'NETWORK_ERROR',
        `Could not reach ${method} ${url.split('?')[0]} — ${detail}. ` +
          'No HTTP response was received (this is a connection problem, not a server rejection). ' +
          'Check your network and retry; for large deploys a flaky connection can drop the upload mid-request.',
        0,
      );
    }
    const text = await res.text();
    let parsed: ApiResponse<T>;

    try {
      parsed = JSON.parse(text) as ApiResponse<T>;
    } catch {
      throw new CliApiError(
        'INVALID_RESPONSE',
        `Non-JSON response (${res.status}): ${text.slice(0, 200)}`,
        res.status,
      );
    }

    if (parsed.ok === true) return parsed.data;

    const errBody = parsed as {
      error?: string;
      message?: string;
      data?: Record<string, unknown>;
      hint?: string;
    };
    throw new CliApiError(
      errBody.error ?? 'UNKNOWN',
      errBody.message ?? 'Unknown error',
      res.status,
      errBody.data,
      errBody.hint,
    );
  }
}

export class CliApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    /** Structured payload some errors carry (e.g. BUILD_ERROR file/line/frame). */
    public readonly data?: Record<string, unknown>,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliApiError';
  }
}
