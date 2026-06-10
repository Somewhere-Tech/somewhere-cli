import type { ApiResponse } from '../types.js';

const BASE_URL = 'https://api.somewhere.tech/v1';

export class ApiClient {
  constructor(private readonly token: string) {}

  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
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

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: reqBody });
    } catch (err) {
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

    throw new CliApiError(
      (parsed as { error?: string }).error ?? 'UNKNOWN',
      (parsed as { message?: string }).message ?? 'Unknown error',
      res.status,
    );
  }
}

export class CliApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CliApiError';
  }
}
