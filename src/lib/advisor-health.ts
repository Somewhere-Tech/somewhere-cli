export interface AdvisorHealth {
  status: 'healthy' | 'degraded' | 'unknown';
  checked_at: number | null;
  reason: string | null;
  alternative: string;
}

const unknown = (): AdvisorHealth => ({ status: 'unknown', checked_at: null,
  reason: 'No recent advisor health check is available.',
  alternative: 'Use somewhere docs getting-started or https://somewhere.tech/docs.txt.' });

/** This is a cached public status read: no credentials and no model request. */
export async function fetchAdvisorHealth(): Promise<AdvisorHealth> {
  try {
    const url = new URL('/health?cached=1', process.env.SOMEWHERE_MCP_URL || 'https://mcp.somewhere.tech/mcp');
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('advisor' in body)) return unknown();
    const health = body.advisor;
    if (!health || typeof health !== 'object' || !('status' in health)
      || !['healthy', 'degraded', 'unknown'].includes(String(health.status))) return unknown();
    return {
      status: health.status as AdvisorHealth['status'],
      checked_at: 'checked_at' in health && typeof health.checked_at === 'number'
        && Number.isFinite(new Date(health.checked_at).getTime()) ? health.checked_at : null,
      reason: 'reason' in health && typeof health.reason === 'string' ? health.reason : null,
      alternative: 'alternative' in health && typeof health.alternative === 'string' ? health.alternative : unknown().alternative,
    };
  } catch { return unknown(); }
}

export function advisorHealthLine(health: AdvisorHealth): string {
  return health.status === 'healthy'
    ? `Advisor: healthy${health.checked_at ? ` (checked ${new Date(health.checked_at).toISOString()})` : ''}.`
    : `Advisor: ${health.status}. ${health.reason ?? ''} ${health.alternative}`;
}
