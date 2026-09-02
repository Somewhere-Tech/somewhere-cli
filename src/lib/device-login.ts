/**
 * Device-code login. Same pattern as `npm login` and `gh auth login`.
 *
 *   1. Generate a human-readable XXXX-XXXX code
 *   2. POST it to the platform — server stores it pending
 *   3. Print the URL + code, poll status
 *   4. When the user approves in a browser, the next poll returns the token
 *
 * Why over the localhost-callback flow:
 *   - works over SSH / cloud dev environments
 *   - no port binding, no firewall holes
 *   - browser and terminal can be on different machines
 */
import { randomInt } from 'node:crypto';
import { arch, hostname, platform, release } from 'node:os';
import type { CliConfig } from '../types.js';
import { getDeviceKeyName } from './device.js';
import { CLI_VERSION } from './version.js';
import { API_BASE_URL } from './client.js';

// Same host the rest of the CLI talks to (SOMEWHERE_API_URL overrides it for
// staging / a local platform); this flow addresses /v1/auth/* itself.
const API_BASE = API_BASE_URL.replace(/\/v1$/, '');
const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 5 * 60 * 1000;

// Skip ambiguous chars (no I, O, 0, 1) — same alphabet the worker validates.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < 8; i++) {
    chars.push(ALPHABET[randomInt(0, ALPHABET.length)]);
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

interface StartResponse {
  ok: true;
  data: { code: string; expires_in: number; approval_url: string };
}

interface StatusPending {
  ok: true;
  data: { status: 'pending' };
}
interface StatusApproved {
  ok: true;
  // refresh_token is optional: the device-code approve flow returns it only
  // once the server mints a cli-pair (refreshable) key for device login.
  // When present, the CLI persists it so it can refresh on a 401 instead of
  // forcing a manual re-login (tsk_3642f3c4).
  data: {
    status: 'approved';
    token: string;
    email: string;
    refresh_token?: string;
    expires_at?: string;
    /** Present once the platform reports the approved scope (tsk_d560943d). */
    scope?: DeviceSessionScope | null;
    session_id?: string;
  };
}
interface StatusExpired {
  ok: true;
  data: { status: 'expired' };
}
/** The account owner clicked Deny in the browser. Distinct from a timeout so
 *  the terminal says what actually happened. */
interface StatusDenied {
  ok: true;
  data: { status: 'denied' };
}
type StatusResponse = StatusPending | StatusApproved | StatusExpired | StatusDenied;

/** What this session may touch, as approved in the browser. null = all projects. */
export interface DeviceSessionScope {
  projects: string[];
}

export interface DeviceLoginCallbacks {
  onPrompt: (info: { code: string; approvalUrl: string }) => void;
  onWaiting?: () => void;
}

export class DeviceLoginTimeout extends Error {
  constructor() {
    super('Login timed out. Run `somewhere login` to try again.');
    this.name = 'DeviceLoginTimeout';
  }
}

export class DeviceCodeUnsupported extends Error {
  constructor() {
    super('Device-code endpoint not available on this platform.');
    this.name = 'DeviceCodeUnsupported';
  }
}

export class DeviceLoginDenied extends Error {
  constructor() {
    super('Sign-in was denied in the browser. Nothing was granted. Run `somewhere login` again if that was a mistake.');
    this.name = 'DeviceLoginDenied';
  }
}

/**
 * What the approval page shows the account owner about THIS machine, so they
 * can tell their own VM from someone else's before allowing access. Only
 * facts the CLI can read locally; the platform adds the request's IP and
 * approximate location itself and never trusts these for anything but
 * display.
 */
export interface DeviceClientMeta {
  hostname: string;
  cli_version: string;
  runtime_version: string;
  platform: string;
  arch: string;
}

export function describeThisDevice(): DeviceClientMeta {
  const host = (hostname() || 'unknown').replace(/\.local$/i, '').slice(0, 64);
  return {
    hostname: host,
    cli_version: CLI_VERSION,
    runtime_version: `node ${process.versions.node}`,
    platform: `${platform()} ${release()}`.trim().slice(0, 64),
    arch: arch(),
  };
}

export interface DeviceLoginResult {
  config: CliConfig;
  scope: DeviceSessionScope | null;
}

export async function deviceLogin(callbacks: DeviceLoginCallbacks): Promise<DeviceLoginResult> {
  const code = generateCode();
  const deviceName = getDeviceKeyName();

  const startRes = await fetch(`${API_BASE}/v1/auth/device-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device_name: deviceName, client: describeThisDevice() }),
  });

  if (startRes.status === 404) {
    // Endpoint not deployed yet → caller can fall back to legacy flow
    throw new DeviceCodeUnsupported();
  }
  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error(`Failed to start login: HTTP ${startRes.status} ${text.slice(0, 200)}`);
  }
  const start = (await startRes.json()) as StartResponse;
  callbacks.onPrompt({ code, approvalUrl: start.data.approval_url });
  callbacks.onWaiting?.();

  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(
      `${API_BASE}/v1/auth/device-code/status?code=${encodeURIComponent(code)}`
    );
    if (!pollRes.ok) {
      // Transient errors are non-fatal — keep polling until timeout.
      continue;
    }
    const status = (await pollRes.json()) as StatusResponse;
    if (status.data.status === 'expired') {
      throw new DeviceLoginTimeout();
    }
    if (status.data.status === 'denied') {
      throw new DeviceLoginDenied();
    }
    if (status.data.status === 'approved') {
      const config: CliConfig = {
        token: status.data.token,
        user: { email: status.data.email, username: '' },
      };
      if (status.data.refresh_token) config.refresh_token = status.data.refresh_token;
      if (status.data.expires_at) config.access_expires_at = status.data.expires_at;
      return { config, scope: status.data.scope ?? null };
    }
  }
  throw new DeviceLoginTimeout();
}
