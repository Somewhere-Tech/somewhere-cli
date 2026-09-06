import { ApiClient } from './client.js';

interface ProjectUrlsResponse {
  prod_fallback?: string | null;
  active_release_id?: string | null;
  prod_version?: number | null;
}

export interface ProjectServingUrlFields {
  subdomain?: string | null;
  slug?: string | null;
}

const PROJECT_SITE_DOMAIN = 'somewhere.site';

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

/** Frontend hot reload needs an existing deployed backend. The URL endpoint
 * carries canonical release identity or the legacy serving version. A reserved
 * hostname alone is not evidence of a deploy. */
export async function getDeployedProjectServingUrl(client: ApiClient, projectRef: string): Promise<string> {
  const urls = await client.call<ProjectUrlsResponse>('GET', `/projects/${encodeURIComponent(projectRef)}/urls`);
  const deployed = (typeof urls.active_release_id === 'string' && urls.active_release_id.trim().length > 0)
    || (typeof urls.prod_version === 'number' && Number.isInteger(urls.prod_version) && urls.prod_version > 0);
  if (!deployed) throw new Error('Deploy this project before starting frontend hot reload. The platform did not confirm a deployed version.');
  if (typeof urls.prod_fallback !== 'string' || !urls.prod_fallback.trim()) throw new Error('The deployed project did not return a serving URL.');
  return urls.prod_fallback.trim();
}

export function fallbackProjectServingUrl(project: ProjectServingUrlFields): string | null {
  const slug = cleanProjectSlug(project.slug) ?? cleanProjectSlug(project.subdomain);
  return slug ? `https://${slug}.${PROJECT_SITE_DOMAIN}` : null;
}

function cleanProjectSlug(value: string | null | undefined): string | null {
  const slug = value?.trim();
  return slug && /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/i.test(slug)
    ? slug.toLowerCase()
    : null;
}
