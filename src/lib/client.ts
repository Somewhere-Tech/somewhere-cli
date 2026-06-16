import type { ApiResponse } from '../types.js';
import { Agent } from 'undici';

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
        // Match undici's internal header/body timeouts to OUR budget. Node's
        // global fetch defaults headersTimeout to ~300s — SHORTER than a long
        // deploy's 10-min budget — so a cold first deploy (while the project is
        // provisioned) tripped UND_ERR_HEADERS_TIMEOUT before our AbortSignal
        // fired, and the failure got mislabeled as the user's network
        // (tsk_896f9c7b). Now our AbortSignal is the only real deadline.
        dispatcher: new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
      } as RequestInit & { dispatcher: Agent });
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
      const code = cause?.code;
      // undici's own header/body timeout means the CONNECTION established but the
      // server was slow to respond — NOT the user's network. Common on a first
      // deploy while the project is provisioned (tsk_896f9c7b). With the matching
      // dispatcher above this should rarely fire now, but if it does, say what's
      // actually happening instead of blaming the network.
      if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
        throw new CliApiError(
          'SERVER_SLOW',
          `${method} ${url.split('?')[0]} connected, but the server didn't finish responding in time. ` +
            'This is usually a first deploy while your project is being provisioned — the request may ' +
            'still be completing server-side. Check `somewhere status` before retrying ' +
            '(retrying a first deploy is safe — it just creates a new version).',
          0,
        );
      }
      const detail =
        code ??
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

  /** Like call(), but returns the raw response TEXT instead of JSON-parsing it
   *  — for endpoints that legitimately return non-JSON (e.g. a SQL db dump). A
   *  200 with a non-JSON body is NOT an error (audit #14 / tsk_30633bb3). Used
   *  by `somewhere api --raw`. call() is intentionally left untouched so every
   *  existing command keeps its exact behavior. */
  async callRaw(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<{ status: number; ok: boolean; body: string }> {
    const url = `${BASE_URL}${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
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
        dispatcher: new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
      } as RequestInit & { dispatcher: Agent });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
      throw new CliApiError(
        'NETWORK_ERROR',
        `Could not reach ${method} ${url} — ${detail}. No HTTP response was received.`,
        0,
      );
    }
    return { status: res.status, ok: res.status < 400, body: await res.text() };
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
