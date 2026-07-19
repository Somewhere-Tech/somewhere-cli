function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredBaseReleaseId(error: unknown): string | null {
  if (
    !isRecord(error) ||
    error.statusCode !== 400 ||
    error.code !== 'BASE_RELEASE_REQUIRED' ||
    !isRecord(error.data)
  ) {
    return null;
  }

  const activeReleaseId = error.data.active_release_id;
  return typeof activeReleaseId === 'string' && activeReleaseId.trim().length > 0
    ? activeReleaseId
    : null;
}

export function pinnedReleaseRetryBody(
  error: unknown,
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const activeReleaseId = requiredBaseReleaseId(error);
  return activeReleaseId === null
    ? null
    : { ...body, base_release_id: activeReleaseId };
}

export async function callWithPinnedReleaseRetry<T>(
  request: (body: Record<string, unknown>) => Promise<T>,
  body: Record<string, unknown>,
): Promise<T> {
  try {
    return await request(body);
  } catch (error) {
    const retryBody = pinnedReleaseRetryBody(error, body);
    if (retryBody === null) throw error;

    // Safe to retry once: this is the base the worker just declared current. If
    // another publish lands first, its CAS returns STALE_RELEASE_BASE rather than
    // double-applying the edit, preserving the protection this field provides.
    return request(retryBody);
  }
}
