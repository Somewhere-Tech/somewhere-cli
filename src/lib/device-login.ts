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
import type { CliConfig } from '../types.js';
import { getDeviceKeyName } from './device.js';

const API_BASE = 'https://api.somewhere.tech';
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
  data: { status: 'approved'; token: string; email: string };
}
interface StatusExpired {
  ok: true;
  data: { status: 'expired' };
}
type StatusResponse = StatusPending | StatusApproved | StatusExpired;

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

export async function deviceLogin(callbacks: DeviceLoginCallbacks): Promise<CliConfig> {
  const code = generateCode();
  const deviceName = getDeviceKeyName();

  const startRes = await fetch(`${API_BASE}/v1/auth/device-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device_name: deviceName }),
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
    if (status.data.status === 'approved') {
      return {
        token: status.data.token,
        user: { email: status.data.email, username: '' },
      };
    }
  }
  throw new DeviceLoginTimeout();
}
