import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

// CLI processes inherit their network configuration at startup. Reuse pools
// within each timeout budget; EnvHttpProxyAgent handles HTTP(S)_PROXY and
// NO_PROXY (including lowercase variants), and connects directly without a
// proxy. Keep fetch and dispatcher from the same bundled undici instance.
const dispatchers = new Map<number, EnvHttpProxyAgent>();

export function fetchWithProxy(
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
  timeoutMs = 60_000,
): ReturnType<typeof undiciFetch> {
  let dispatcher = dispatchers.get(timeoutMs);
  if (!dispatcher) {
    dispatcher = new EnvHttpProxyAgent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    dispatchers.set(timeoutMs, dispatcher);
  }
  return undiciFetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    dispatcher,
  });
}
