import { ApiClient } from './client.js';

interface ProjectUrlsResponse {
  prod_fallback?: string | null;
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
