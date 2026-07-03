/** No-login deploy path (tsk_35674c33): mint a short-lived, unauthenticated
 *  developer credential gated by client-side proof-of-work instead of a
 *  signup. This is the whole "auth" for `somewhere deploy --temporary` — see
 *  src/commands/deploy.ts for how the minted credential is cached/reused and
 *  wired into the normal deploy flow. */

import { createHash } from 'node:crypto';
import { API_BASE_URL } from './client.js';

/** GET /v1/auth/pow/challenge response payload (unauthenticated). */
export interface PowChallenge {
  nonce: string;
  difficulty: number;
  algorithm: string;
  /** The exact string the client hashes: `${nonce}:${suffix}`. Sent by the
   *  server so the client never has to guess the hash-input format. */
  input: string;
  expires_at: string;
  ttl_seconds: number;
}

/** POST /v1/auth/temp-create response payload (unauthenticated — the solved
 *  PoW is the auth). `key`/`access_token` are the same bearer credential;
 *  the server contract names both, see mintTempAccount(). */
export interface TempAccount {
  key: string;
  key_prefix?: string;
  key_id?: string;
  scopes: string[];
  expires_at: string;
  ttl_seconds: number;
  claim_token: string;
  claim_url: string;
}

/** Count LEADING ZERO BITS (not hex chars — the server's difficulty unit is
 *  bits) in a digest. Walks bytes most-significant-first and stops counting
 *  at the first 1 bit, whether that's mid-byte or in a later byte. */
export function leadingZeroBits(buf: Uint8Array): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while (mask > 0 && (byte & mask) === 0) {
      bits++;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

/** Sync brute-force PoW solve: try counter suffixes `0`, `1`, `2`, … (base36)
 *  until sha256(`${nonce}:${suffix}`) has at least `difficulty` leading zero
 *  bits. This is the entire cost the server imposes in place of a signup, so
 *  it must stay cheap for a real client (sub-second at difficulty ~20) — a
 *  synchronous loop is fine at that scale; no worker threads needed. */
export function solvePow(nonce: string, difficulty: number): { suffix: string; hash: string } {
  let i = 0;
  for (;;) {
    const suffix = (i++).toString(36);
    const hash = createHash('sha256').update(`${nonce}:${suffix}`, 'utf8').digest();
    if (leadingZeroBits(hash) >= difficulty) {
      return { suffix, hash: hash.toString('hex') };
    }
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/** Mint a temporary, no-login developer credential: GET the PoW challenge,
 *  solve it locally, POST the solution for a bearer key. `fetchImpl` is
 *  injectable (same DI seam as src/swpx/run-common.ts) so tests never touch
 *  the network. Throws a clear Error — including the server's own message
 *  where available — on any failure at either step. */
export async function mintTempAccount(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TempAccount> {
  const challengeRes = await fetchImpl(`${API_BASE_URL}/auth/pow/challenge`);
  const challengeBody = (await challengeRes.json()) as Envelope<PowChallenge>;
  if (!challengeRes.ok || challengeBody.ok !== true || !challengeBody.data) {
    throw new Error(
      `Could not fetch a proof-of-work challenge: ${challengeBody.message ?? challengeBody.error ?? challengeRes.statusText}`,
    );
  }
  const challenge = challengeBody.data;
  const { suffix } = solvePow(challenge.nonce, challenge.difficulty);

  const createRes = await fetchImpl(`${API_BASE_URL}/auth/temp-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: challenge.nonce, suffix }),
  });
  const createBody = (await createRes.json()) as Envelope<Record<string, unknown>>;
  if (!createRes.ok || createBody.ok !== true || !createBody.data) {
    throw new Error(
      `Could not create a temporary session: ${createBody.message ?? createBody.error ?? createRes.statusText}`,
    );
  }

  const data = createBody.data;
  // Prefer `key` (the field name every other stored CLI credential uses);
  // fall back to `access_token` — the contract names both.
  const key = (data.key as string | undefined) ?? (data.access_token as string | undefined);
  if (!key) {
    throw new Error('Temp-create response had neither `key` nor `access_token`.');
  }
  return {
    key,
    key_prefix: data.key_prefix as string | undefined,
    key_id: data.key_id as string | undefined,
    scopes: (data.scopes as string[] | undefined) ?? [],
    expires_at: data.expires_at as string,
    ttl_seconds: data.ttl_seconds as number,
    claim_token: data.claim_token as string,
    claim_url: data.claim_url as string,
  };
}
