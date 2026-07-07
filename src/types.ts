export interface CliConfig {
  token: string;
  /** Long-lived (30-day) cli-pair refresh token (smtr_…). When present, the
   *  API client swaps the access key on a 401 API_KEY_EXPIRED via
   *  POST /v1/keys/cli-pair/refresh instead of forcing a manual re-login
   *  (tsk_3642f3c4). Absent for login flows that don't yet return one. */
  refresh_token?: string;
  user: {
    email: string;
    username: string;
  };
  /** When true, swpx/swpm fail CLOSED — refuse to run/install if the verdict
   *  can't be obtained, instead of falling back to the real tool. Overridable
   *  per-invocation by --enforce / --no-enforce / SWPX_ENFORCE. */
  enforce?: boolean;
  /** True when `token` is a `--temporary` no-login credential (tsk_35674c33)
   *  rather than a real account login. Distinguishes the two so getToken()
   *  can give temp-aware expiry messaging and deploy can reuse/re-mint
   *  instead of ever prompting `somewhere login`. */
  temporary?: boolean;
  /** ISO expiry for a temporary credential (3h TTL from the server). Unused
   *  when `temporary` is not set. */
  temp_expires_at?: string;
  /** Where claiming a temporary workspace happens — printed on every temp
   *  deploy so the dev can convert it into a real account. */
  claim_url?: string;
}

export interface ProjectConfig {
  project_id: string;
  name: string;
  subdomain: string;
  last_deploy?: ProjectDeployState;
}

export interface ProjectDeployState {
  project_id: string;
  last_deployed_version: number;
  at: string;
}

export interface ApiError {
  ok: false;
  error: string;
  message: string;
  retry?: boolean;
  retry_after_ms?: number;
}

export interface ApiSuccess<T = unknown> {
  ok: true;
  data: T;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;
