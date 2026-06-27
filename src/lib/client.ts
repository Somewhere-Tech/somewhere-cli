import type { ApiResponse } from '../types.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { loadConfig, updateTokens } from './config.js';

/** The /v1 API host. Override for staging/tests via SOMEWHERE_API_URL
 *  (mirrors SOMEWHERE_RUNNER_URL below); the value should include the /v1
 *  suffix or a host the route paths can hang off of. */
const BASE_URL = process.env.SOMEWHERE_API_URL?.replace(/\/$/, '') || 'https://api.somewhere.tech/v1';

/** The dedicated run_code runner worker (somewhere-tech-runner). `somewhere run`
 *  MUST hit this host, NOT the /v1 API: the runner is the request ROOT — it
 *  invokes the sandbox, the sandbox fetches the API worker as a LEAF, so there's
 *  no self-loop (CF returns 522 when a worker re-enters itself). There is
 *  deliberately no /v1/code/run proxy. The runner accepts the SAME `smt_`
 *  developer key the rest of the CLI uses. Override for staging via
 *  SOMEWHERE_RUNNER_URL. */
const RUNNER_BASE_URL =
  process.env.SOMEWHERE_RUNNER_URL?.replace(/\/$/, '') || 'https://runner.somewhere.tech';

/** Default request timeout. Long-running calls (deploy compiles, pulls)
 *  pass an explicit budget via opts.timeoutMs instead. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Budget for calls that run a real build server-side (npm install alone
 *  can take minutes): /deploy, /deploy/patch, pull/export. */
export const LONG_CALL_TIMEOUT_MS = 10 * 60_000;

export class ApiClient {
  /** Mutable: the refresh-on-401 path swaps in a fresh access key in place so
   *  the retry (and every later call on this instance) uses the new token. */
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /** Run a one-off script against the project's live DEV bindings via the
   *  dedicated runner worker. Same auth + `{ ok, data }` envelope as call(), but
   *  rooted at RUNNER_BASE_URL instead of the /v1 API (see that constant for the
   *  loop-protection reason). Body: { project_id, code, timeout_ms?, include_env? };
   *  resolves to { result, logs, duration_ms, error? }. */
  async callRunner<T = unknown>(
    body: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.call<T>('POST', '/run', body, undefined, { ...opts, baseUrl: RUNNER_BASE_URL });
  }

  /** Authenticated API call. On a 401 API_KEY_EXPIRED — the short-lived
   *  cli-pair access key timed out — and with a stored refresh token, this
   *  swaps in a fresh access key via POST /v1/keys/cli-pair/refresh and
   *  retries ONCE, so a long-lived agent session never logs itself out
   *  (tsk_3642f3c4). Without a refresh token (older login flows) refreshAccessKey
   *  throws a clear SESSION_EXPIRED "run `somewhere login`" error rather than
   *  letting the opaque 401 propagate (tsk_8ba2113d). */
  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    opts?: { timeoutMs?: number; baseUrl?: string },
  ): Promise<T> {
    try {
      return await this.request<T>(method, path, body, query, opts);
    } catch (err) {
      if (!(err instanceof CliApiError) || err.code !== 'API_KEY_EXPIRED') throw err;
      const refreshed = await this.refreshAccessKey();
      // refreshAccessKey now THROWS a clear re-login error when it can't refresh
      // (no refresh token, or a dead one); a false return is only the rare
      // malformed-refresh-response case, where the original expired-key error is
      // the most honest thing to surface.
      if (!refreshed) throw err;
      // Retry exactly once with the new key. A second API_KEY_EXPIRED here is
      // genuine — let it propagate rather than loop.
      return await this.request<T>(method, path, body, query, opts);
    }
  }

  /** Exchange the stored cli-pair refresh token for a fresh access key and
   *  persist both. Returns true if the access key was swapped in. Throws a
   *  clear SESSION_EXPIRED CliApiError ("run `somewhere login`") when it can't
   *  refresh — either there's no refresh token (old-format config) or the
   *  refresh token itself is expired/revoked — so the user is told the cause +
   *  the fix instead of seeing a bare expired-key 401. Returns false only for a
   *  malformed refresh response, where the caller surfaces the original
   *  API_KEY_EXPIRED. */
  private async refreshAccessKey(): Promise<boolean> {
    const config = loadConfig();
    const refreshToken = config?.refresh_token;
    if (!refreshToken) {
      // We only get here AFTER an API_KEY_EXPIRED — so the access key is dead and
      // there's no refresh token to renew it (an old-format config written before
      // the refresh flow: { token, user }, no refresh_token). Returning false here
      // used to let the bare API_KEY_EXPIRED 401 propagate, which down the
      // stdio-MCP path reached the agent as an opaque "(HTTP 401)" with no hint
      // that `somewhere login` fixes it for good — so the user re-paired every
      // ~24h without knowing why. Surface the cause + the one-line fix instead
      // (tsk_8ba2113d). Same SESSION_EXPIRED contract as the dead-refresh-token
      // case below: both mean "re-login required".
      throw new CliApiError(
        'SESSION_EXPIRED',
        'Your somewhere session expired and there is no refresh token saved ' +
          '(old login format). Run `somewhere login` to sign in again — that ' +
          'upgrades your config so sessions refresh automatically from now on.',
        401,
      );
    }

    let pair: { key?: string; refresh_token?: string };
    try {
      pair = await this.request<{ key?: string; refresh_token?: string }>(
        'POST',
        '/keys/cli-pair/refresh',
        { refresh_token: refreshToken },
      );
    } catch (err) {
      if (err instanceof CliApiError && err.code === 'INVALID_REFRESH_TOKEN') {
        throw new CliApiError(
          'SESSION_EXPIRED',
          'Your CLI session has expired (refresh token is no longer valid). Run `somewhere login` to sign in again.',
          401,
        );
      }
      throw err;
    }

    if (!pair.key || !pair.refresh_token) {
      // Malformed refresh response — don't half-update the stored creds.
      return false;
    }
    updateTokens(pair.key, pair.refresh_token);
    this.token = pair.key;
    return true;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    opts?: { timeoutMs?: number; baseUrl?: string },
  ): Promise<T> {
    let url = `${opts?.baseUrl ?? BASE_URL}${path}`;
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
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      // Use undici's OWN fetch (not Node's global fetch) so the Agent dispatcher
      // is from the SAME undici instance — a standalone-undici Agent on the
      // global fetch throws UND_ERR_INVALID_ARG on newer Node (dual-undici;
      // tsk_0a3f106d). The Agent also pins undici's header/body timeouts to OUR
      // budget so a cold first deploy isn't mislabeled as a network failure
      // (tsk_896f9c7b) — our AbortSignal stays the only real deadline.
      res = await undiciFetch(url, {
        method,
        headers,
        body: reqBody,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
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
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      // undici's own fetch — see call() for why (dual-undici, tsk_0a3f106d).
      res = await undiciFetch(url, {
        method,
        headers,
        body: reqBody,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
      });
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
