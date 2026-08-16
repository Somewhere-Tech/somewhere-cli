import { ApiClient } from './client.js';

interface ProjectUrlsResponse {
  prod_fallback?: string | null;
}

export async function getProjectServingUrl(
  client: ApiClient,
  projectRef: string,
): Promise<string | null> {
  const urls = await client.call<ProjectUrlsResponse>(
    'GET',
    `/projects/${encodeURIComponent(projectRef)}/urls`,
  );
  return typeof urls.prod_fallback === 'string' && urls.prod_fallback.trim()
    ? urls.prod_fallback.trim()
    : null;
}
