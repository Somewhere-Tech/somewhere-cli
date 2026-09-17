import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { ClaimCliHandoff, CliConfig } from '../types.js';
import { loadConfig, saveConfig } from './config.js';
import { getDeviceKeyName } from './device.js';
import { describeThisDevice } from './device-login.js';
import { API_BASE_URL } from './client.js';
import { fetchWithProxy as fetch } from './http.js';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface RegisterResult { handoff_id: string; expires_at: string }
interface ExchangeResult { status: 'ready'; project_id: string; ciphertext: string; iv: string }
interface DeliveredCredentials {
  token: string;
  refresh_token: string;
  expires_at: string;
  email: string;
  project_id: string;
  scope: { projects: string[] };
  session_id: string;
}
type HttpResponse = Awaited<ReturnType<typeof fetch>>;

export interface ClaimHandoffRecovery {
  kind: 'none' | 'recovered' | 'manual';
  message?: string;
}

function verifierHash(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('hex');
}

function newVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function decodeCredentials(state: ClaimCliHandoff, response: ExchangeResult): DeliveredCredentials {
  if (!state.handoff_id || response.project_id !== state.project_id) {
    throw new Error('Claim continuation returned a different project. No credential was installed.');
  }
  const key = createHash('sha256').update(`claim-cli-handoff:v1:${state.verifier}`, 'utf8').digest();
  const combined = Buffer.from(response.ciphertext, 'base64');
  if (combined.length <= 16) throw new Error('Claim continuation returned an invalid credential payload.');
  const encrypted = combined.subarray(0, -16);
  const tag = combined.subarray(-16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(response.iv, 'base64'));
  decipher.setAAD(Buffer.from(`${state.handoff_id}:${state.project_id}`, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext) as Partial<DeliveredCredentials>;
  if (
    typeof parsed.token !== 'string'
    || typeof parsed.refresh_token !== 'string'
    || typeof parsed.expires_at !== 'string'
    || typeof parsed.email !== 'string'
    || parsed.project_id !== state.project_id
    || parsed.scope?.projects?.length !== 1
    || parsed.scope.projects[0] !== state.project_id
  ) {
    throw new Error('Claim continuation credential did not match the approved project. Nothing was installed.');
  }
  return parsed as DeliveredCredentials;
}

async function post<T>(path: string, body: unknown, token?: string): Promise<{ response: HttpResponse; envelope: Envelope<T> }> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }, 15_000);
  const envelope = await response.json() as Envelope<T>;
  return { response, envelope };
}

/** Persist the verifier before registration so a lost response retries with
 * the same proof instead of creating an irrecoverable second request. */
export async function ensureClaimHandoff(projectId: string): Promise<ClaimCliHandoff | null> {
  const config = loadConfig();
  if (!config?.temporary || !config.token) return null;
  let state = config.claim_handoff;
  if (!state || state.project_id !== projectId) {
    state = { project_id: projectId, verifier: newVerifier() };
    saveConfig({ ...config, claim_handoff: state });
  }
  if (state.handoff_id) return state;

  const { response, envelope } = await post<RegisterResult>('/auth/temp-handoff/register', {
    project_id: projectId,
    verifier_hash: verifierHash(state.verifier),
    device_name: getDeviceKeyName(),
    client: describeThisDevice(),
  }, config.token);
  if (!response.ok || !envelope.ok || !envelope.data) {
    throw new Error(envelope.message || envelope.error || `CLI continuation registration failed (HTTP ${response.status}).`);
  }
  const registered = { ...state, handoff_id: envelope.data.handoff_id, expires_at: envelope.data.expires_at };
  const current = loadConfig();
  if (!current?.temporary || current.claim_handoff?.verifier !== state.verifier) return null;
  saveConfig({ ...current, claim_handoff: registered });
  return registered;
}

async function acknowledge(handoffId: string, verifier: string): Promise<boolean> {
  try {
    const { response, envelope } = await post<{ acknowledged: boolean }>('/auth/temp-handoff/ack', {
      handoff_id: handoffId,
      verifier,
    });
    return response.ok && envelope.ok && envelope.data?.acknowledged === true;
  } catch {
    return false;
  }
}

export async function recoverClaimHandoff(): Promise<ClaimHandoffRecovery> {
  let config = loadConfig();
  if (!config) return { kind: 'none' };

  if (config.claim_handoff_ack) {
    const ack = config.claim_handoff_ack;
    if (await acknowledge(ack.handoff_id, ack.verifier)) {
      const { claim_handoff_ack: _removed, ...clean } = config;
      saveConfig(clean as CliConfig);
      config = clean as CliConfig;
    }
  }

  const state = config.temporary ? config.claim_handoff : undefined;
  if (!state?.handoff_id) return { kind: 'none' };
  let response: HttpResponse;
  let envelope: Envelope<ExchangeResult>;
  try {
    ({ response, envelope } = await post<ExchangeResult>('/auth/temp-handoff/exchange', {
      handoff_id: state.handoff_id,
      verifier: state.verifier,
    }));
  } catch {
    return { kind: 'none' }; // Network trouble must not block a still-live temp session.
  }

  if (!response.ok || !envelope.ok || !envelope.data) {
    if (['CLAIM_CLI_HANDOFF_PENDING', 'CLAIM_CLI_HANDOFF_IN_PROGRESS'].includes(envelope.error || '')) {
      return { kind: 'none' };
    }
    if (['CLAIM_CLI_HANDOFF_DENIED', 'CLAIM_CLI_HANDOFF_EXPIRED', 'CLAIM_CLI_HANDOFF_CONSUMED', 'CLAIM_CLI_HANDOFF_OWNERSHIP_MISMATCH'].includes(envelope.error || '')) {
      return {
        kind: 'manual',
        message: envelope.message || 'Run `somewhere login` in this directory. Keep the existing project link; do not unlink or redeploy.',
      };
    }
    return { kind: 'none' };
  }

  const delivered = decodeCredentials(state, envelope.data);
  const next: CliConfig = {
    token: delivered.token,
    refresh_token: delivered.refresh_token,
    access_expires_at: delivered.expires_at,
    user: { email: delivered.email, username: '' },
    claim_handoff_ack: { handoff_id: state.handoff_id, verifier: state.verifier },
  };
  // Save before acknowledging. If the process or response is lost, the server
  // keeps the same encrypted delivery retrievable and never mints a second key.
  saveConfig(next);
  if (await acknowledge(state.handoff_id, state.verifier)) {
    const { claim_handoff_ack: _removed, ...clean } = next;
    saveConfig(clean as CliConfig);
  }
  return {
    kind: 'recovered',
    message: `Claimed project ${state.project_id} is connected to ${delivered.email}. The existing project link was kept.`,
  };
}
