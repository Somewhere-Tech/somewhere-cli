export interface CliConfig {
  token: string;
  user: {
    email: string;
    username: string;
  };
}

export interface ProjectConfig {
  project_id: string;
  name: string;
  subdomain: string;
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
