/** npm registry resolution for swpx / swpm.
 *
 *  We never download tarballs — npm's CDN does that (the whole point of the
 *  notary architecture). We only resolve a user-typed spec (`foo`, `foo@1.2.3`,
 *  `foo@^1`, `@scope/name@next`) to ONE concrete version so we can ask the
 *  verdict API about it. Resolution uses the abbreviated packument
 *  (application/vnd.npm.install-v1+json) and semver — npm's own resolver — so a
 *  range picks the same version npm would install.
 *
 *  All network goes through an injectable `FetchLike` so the pure parsing and
 *  version-selection logic is unit-tested without hitting the registry. */

import semver from 'semver';

const REGISTRY = process.env.SWPX_REGISTRY?.replace(/\/$/, '') || 'https://registry.npmjs.org';

export interface PkgSpec {
  name: string;
  /** The version, range, or dist-tag the user typed — undefined = none given. */
  version?: string;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<FetchResponse>;

interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, unknown>;
}

/** Split a CLI spec into name + optional version/range/tag, handling scoped
 *  packages. `@scope/name@1.2.3` → { name: '@scope/name', version: '1.2.3' }. */
export function parseSpec(arg: string): PkgSpec {
  const split = (at: number): PkgSpec => {
    const version = arg.slice(at + 1);
    return version ? { name: arg.slice(0, at), version } : { name: arg.slice(0, at) };
  };
  if (arg.startsWith('@')) {
    const slash = arg.indexOf('/');
    if (slash === -1) return { name: arg }; // malformed scope — pass through
    const at = arg.indexOf('@', slash + 1);
    return at === -1 ? { name: arg } : split(at);
  }
  const at = arg.indexOf('@');
  return at <= 0 ? { name: arg } : split(at);
}

/** Registry path segment for a package name (scoped slash → %2f, @ kept). */
function registryName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2f') : name;
}

export async function fetchPackument(name: string, fetchImpl: FetchLike = defaultFetch): Promise<Packument> {
  const res = await fetchImpl(`${REGISTRY}/${registryName(name)}`, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!res.ok) throw new Error(`npm registry returned ${res.status} for ${name}`);
  return (await res.json()) as Packument;
}

/** Resolve a spec's version field to a single concrete version.
 *  - exact valid version → returned as-is (no network).
 *  - undefined → the `latest` dist-tag.
 *  - a dist-tag (next, beta…) → that tag's version.
 *  - a range (^1, ~2.3, >=1 <2) → the greatest published version that satisfies. */
export async function resolveVersion(
  name: string,
  version: string | undefined,
  fetchImpl: FetchLike = defaultFetch,
): Promise<string> {
  if (version && semver.valid(version)) return version;

  const pack = await fetchPackument(name, fetchImpl);
  const tags = pack['dist-tags'] ?? {};
  const versions = Object.keys(pack.versions ?? {});

  if (!version) {
    const latest = tags.latest ?? semver.maxSatisfying(versions, '*', { includePrerelease: false });
    if (!latest) throw new Error(`no published versions for ${name}`);
    return latest;
  }
  if (tags[version]) return tags[version];

  const match = semver.maxSatisfying(versions, version, { includePrerelease: false });
  if (match) return match;

  throw new Error(`no version of ${name} satisfies "${version}"`);
}
