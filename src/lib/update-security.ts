import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import semver from 'semver';
import { x as extractTar } from 'tar';
import type { Bundle as SigstoreBundle } from 'sigstore';

export const CLI_PACKAGE = '@somewhere-tech/cli';
export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
export const OFFICIAL_REPOSITORY = 'https://github.com/Somewhere-Tech/somewhere-cli';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const IN_TOTO_STATEMENT = 'https://in-toto.io/Statement/v1';
const GITHUB_WORKFLOW_BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const GITHUB_HOSTED_BUILDER = 'https://github.com/actions/runner/github-hosted';
const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const SIGSTORE_NODE_RANGE = '>=22.19.0';
const MAX_LOCKFILE_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const GITHUB_REPOSITORY_ID = '1209689641';
const GITHUB_OWNER_ID = '275776787';

// Immutable GitHub identity values from the Fulcio certificate, not the
// falsifiable SLSA payload. Pinning numeric IDs prevents repository-name reuse.
const GITHUB_CERTIFICATE_OIDS = {
  '1.3.6.1.4.1.57264.1.5': 'Somewhere-Tech/somewhere-cli',
  '1.3.6.1.4.1.57264.1.15': `\x0c\x0a${GITHUB_REPOSITORY_ID}`,
  '1.3.6.1.4.1.57264.1.17': `\x0c\x09${GITHUB_OWNER_ID}`,
  '1.3.6.1.4.1.57264.1.22': '\x0c\x06public',
} as const;

interface ObjectMap {
  [key: string]: unknown;
}

export interface OfficialRelease {
  version: string;
  integrity: string;
  tarballUrl: string;
  attestationUrl: string;
}

const isObject = (value: unknown): value is ObjectMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const message = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

function expectedTarballUrl(version: string): string {
  return `${OFFICIAL_NPM_REGISTRY}/@somewhere-tech/cli/-/cli-${encodeURIComponent(version)}.tgz`;
}

function expectedAttestationUrl(version: string): string {
  return `${OFFICIAL_NPM_REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${encodeURIComponent(version)}`;
}

function expectedPackageUrl(version: string): string {
  return `pkg:npm/%40somewhere-tech/cli@${version}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trustedWorkflowIdentity(version: string): string {
  const releaseTag = `v${escapeRegex(version)}`;
  return '^https://github\\.com/Somewhere-Tech/somewhere-cli/\\.github/workflows/' +
    `(?:version-guard\\.yml@refs/heads/master|publish\\.yml@(?:refs/heads/master|refs/tags/${releaseTag}))$`;
}

function trustedWorkflowCoordinates(path: unknown, ref: unknown, version: string): boolean {
  if (path === '.github/workflows/version-guard.yml') return ref === 'refs/heads/master';
  if (path !== '.github/workflows/publish.yml') return false;
  return ref === 'refs/heads/master' || ref === `refs/tags/v${version}`;
}

function certificateOidText(signer: unknown, expectedOid: string): string | undefined {
  if (!isObject(signer) || !isObject(signer.identity) || !Array.isArray(signer.identity.oids)) return undefined;
  for (const extension of signer.identity.oids) {
    if (!isObject(extension) || !isObject(extension.oid) || !Array.isArray(extension.oid.id)) continue;
    if (extension.oid.id.join('.') !== expectedOid || !Buffer.isBuffer(extension.value)) continue;
    return extension.value.toString('utf8');
  }
  return undefined;
}

function sha512Digest(integrity: string): Buffer {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) throw new Error('missing a valid sha512 integrity digest');
  const digest = Buffer.from(match[1], 'base64');
  if (digest.length !== 64) throw new Error('invalid sha512 integrity digest');
  return digest;
}

/** Validate the exact release coordinates from npm's pinned official
 * packument before any artifact or attestation URL is followed. */
export function parseOfficialRelease(body: unknown): OfficialRelease {
  if (!isObject(body)) throw new Error('the official registry returned invalid package metadata');
  const tags = isObject(body['dist-tags']) ? body['dist-tags'] : undefined;
  const latest = tags?.latest;
  if (typeof latest !== 'string' || !semver.valid(latest)) {
    throw new Error('the official registry returned an invalid latest version');
  }

  const versions = isObject(body.versions) ? body.versions : undefined;
  const manifest = versions && isObject(versions[latest]) ? versions[latest] : undefined;
  if (!manifest || manifest.name !== CLI_PACKAGE || manifest.version !== latest) {
    throw new Error('the official registry did not return matching release metadata');
  }

  const dist = isObject(manifest.dist) ? manifest.dist : undefined;
  const integrity = dist?.integrity;
  const tarballUrl = dist?.tarball;
  const attestations = isObject(dist?.attestations) ? dist.attestations : undefined;
  const provenance = isObject(attestations?.provenance) ? attestations.provenance : undefined;
  const attestationUrl = attestations?.url;

  if (typeof integrity !== 'string') {
    throw new Error('the official release has no published integrity digest');
  }
  sha512Digest(integrity);
  if (tarballUrl !== expectedTarballUrl(latest)) {
    throw new Error('the official release points to an unexpected tarball source');
  }
  if (provenance?.predicateType !== SLSA_PROVENANCE || attestationUrl !== expectedAttestationUrl(latest)) {
    throw new Error('the official release has no published SLSA provenance');
  }

  return { version: latest, integrity, tarballUrl, attestationUrl };
}

function findSlsaBundle(body: unknown): { bundle: SigstoreBundle; envelope: ObjectMap } {
  if (!isObject(body) || !Array.isArray(body.attestations)) {
    throw new Error('the official release provenance could not be verified');
  }
  const attestation = body.attestations.find(
    (entry): entry is ObjectMap => isObject(entry) && entry.predicateType === SLSA_PROVENANCE,
  );
  const bundle = attestation && isObject(attestation.bundle) ? attestation.bundle : undefined;
  const envelope = bundle && isObject(bundle.dsseEnvelope) ? bundle.dsseEnvelope : undefined;
  const material = bundle && isObject(bundle.verificationMaterial) ? bundle.verificationMaterial : undefined;
  const chain = material && isObject(material.x509CertificateChain) ? material.x509CertificateChain : undefined;

  if (
    bundle?.mediaType !== 'application/vnd.dev.sigstore.bundle+json;version=0.2' ||
    !envelope ||
    typeof envelope.payload !== 'string' ||
    envelope.payloadType !== 'application/vnd.in-toto+json' ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length === 0 ||
    !Array.isArray(chain?.certificates) ||
    chain.certificates.length === 0 ||
    !Array.isArray(material?.tlogEntries) ||
    material.tlogEntries.length === 0
  ) {
    throw new Error('the official release has no signed Sigstore provenance bundle');
  }

  return { bundle: bundle as unknown as SigstoreBundle, envelope };
}

/** Cryptographically verify the SLSA bundle against Sigstore's TUF trust root.
 * This checks the Fulcio certificate chain and SCT, Rekor inclusion proof, DSSE
 * signature, GitHub OIDC issuer, exact workflow identity, immutable repository
 * and owner IDs, and public-repository claim. Any verifier/network/policy error
 * is a hard refusal. */
export function assertUpdateVerificationRuntime(nodeVersion = process.versions.node): void {
  if (!semver.satisfies(nodeVersion, SIGSTORE_NODE_RANGE)) {
    throw new Error(
      `Update verification needs Node 22.19+; current runtime is Node ${nodeVersion}. ` +
      'Please upgrade Node, then re-run `somewhere update`',
    );
  }
}

export async function verifyPublishedProvenance(body: unknown, release: OfficialRelease): Promise<void> {
  assertUpdateVerificationRuntime();
  const { bundle, envelope } = findSlsaBundle(body);

  let certificateSourceDigest: string | undefined;
  try {
    const { verify } = await import('sigstore');
    const signer = await verify(bundle, {
      certificateIssuer: GITHUB_ACTIONS_ISSUER,
      certificateIdentityURI: trustedWorkflowIdentity(release.version),
      certificateOIDs: GITHUB_CERTIFICATE_OIDS,
      ctLogThreshold: 1,
      tlogThreshold: 1,
      timeout: 10_000,
    });
    certificateSourceDigest = certificateOidText(signer, '1.3.6.1.4.1.57264.1.3');
  } catch (cause) {
    throw new Error(`cryptographic npm provenance verification failed: ${message(cause)}`);
  }

  let statement: ObjectMap;
  try {
    const decoded = JSON.parse(Buffer.from(envelope.payload as string, 'base64').toString('utf8')) as unknown;
    if (!isObject(decoded)) throw new Error('invalid statement');
    statement = decoded;
  } catch {
    throw new Error('the signed SLSA provenance statement is malformed');
  }
  if (
    statement._type !== IN_TOTO_STATEMENT ||
    statement.predicateType !== SLSA_PROVENANCE ||
    !Array.isArray(statement.subject)
  ) {
    throw new Error('the signed SLSA provenance statement has an unexpected type');
  }

  const expectedDigest = sha512Digest(release.integrity).toString('hex');
  const subjectMatches = statement.subject.some((subject) => {
    if (!isObject(subject) || subject.name !== expectedPackageUrl(release.version)) return false;
    const digest = isObject(subject.digest) ? subject.digest : undefined;
    return typeof digest?.sha512 === 'string' && digest.sha512.toLowerCase() === expectedDigest;
  });

  const predicate = isObject(statement.predicate) ? statement.predicate : undefined;
  const buildDefinition = predicate && isObject(predicate.buildDefinition) ? predicate.buildDefinition : undefined;
  const external = buildDefinition && isObject(buildDefinition.externalParameters)
    ? buildDefinition.externalParameters
    : undefined;
  const workflow = external && isObject(external.workflow) ? external.workflow : undefined;
  const internal = buildDefinition && isObject(buildDefinition.internalParameters)
    ? buildDefinition.internalParameters
    : undefined;
  const github = internal && isObject(internal.github) ? internal.github : undefined;
  const runDetails = predicate && isObject(predicate.runDetails) ? predicate.runDetails : undefined;
  const builder = runDetails && isObject(runDetails.builder) ? runDetails.builder : undefined;
  const resolvedDependencies = buildDefinition && Array.isArray(buildDefinition.resolvedDependencies)
    ? buildDefinition.resolvedDependencies
    : [];
  const sourceMatches = typeof certificateSourceDigest === 'string' &&
    /^[0-9a-f]{40}$/.test(certificateSourceDigest) &&
    resolvedDependencies.some((dependency) => {
      if (!isObject(dependency) || !isObject(dependency.digest)) return false;
      return dependency.uri === `git+${OFFICIAL_REPOSITORY}@${String(workflow?.ref)}` &&
        dependency.digest.gitCommit === certificateSourceDigest;
    });

  if (
    !subjectMatches ||
    buildDefinition?.buildType !== GITHUB_WORKFLOW_BUILD_TYPE ||
    workflow?.repository !== OFFICIAL_REPOSITORY ||
    !trustedWorkflowCoordinates(workflow?.path, workflow?.ref, release.version) ||
    github?.repository_id !== GITHUB_REPOSITORY_ID ||
    github?.repository_owner_id !== GITHUB_OWNER_ID ||
    builder?.id !== GITHUB_HOSTED_BUILDER ||
    !sourceMatches
  ) {
    throw new Error('the signed provenance does not match this package, digest, repository, workflow, and source commit');
  }
}

export function verifyTarballIntegrity(bytes: Uint8Array, integrity: string): void {
  const expected = sha512Digest(integrity);
  const actual = createHash('sha512').update(bytes).digest();
  if (!timingSafeEqual(actual, expected)) {
    throw new Error('the downloaded update does not match its published integrity digest');
  }
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`the verified artifact has an invalid ${label}`);
  }
  return value as Record<string, string>;
}

function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const normalize = (value: Record<string, string>) =>
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`the verified artifact has an invalid ${label}`);
  }
  return value;
}

function sameStringSet(left: string[], right: string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function verifyOfficialDependencySource(resolved: string, integrity: string): void {
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error('the authenticated dependency lock contains an invalid source URL');
  }
  if (
    url.origin !== OFFICIAL_NPM_REGISTRY ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.endsWith('.tgz')
  ) {
    throw new Error(`the authenticated dependency lock contains a non-official source: ${resolved}`);
  }
  sha512Digest(integrity);
}

function expectedPackageName(lockPath: string): string {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  const name = index === -1 ? '' : lockPath.slice(index + marker.length);
  if (!/^(?:@[^/]+\/[^/]+|[^/]+)$/.test(name)) {
    throw new Error(`the authenticated dependency lock has an invalid package path: ${lockPath}`);
  }
  return name;
}

function resolveLockedDependency(
  packages: ObjectMap,
  parentPath: string,
  dependency: string,
): { path: string; entry: ObjectMap } | undefined {
  let base = parentPath;
  while (true) {
    const candidate = base ? `${base}/node_modules/${dependency}` : `node_modules/${dependency}`;
    const entry = packages[candidate];
    if (isObject(entry) && entry.dev !== true) return { path: candidate, entry };
    const parentMarker = base.lastIndexOf('/node_modules/');
    if (parentMarker === -1) {
      if (base === '') return undefined;
      base = '';
    } else {
      base = base.slice(0, parentMarker);
    }
  }
}

function installedDependencyMap(entry: ObjectMap): Record<string, string> {
  const dependencies = stringMap(entry.dependencies, 'dependency map');
  const optional = stringMap(entry.optionalDependencies, 'optional dependency map');
  const peers = stringMap(entry.peerDependencies, 'peer dependency map');
  const peerMeta = isObject(entry.peerDependenciesMeta) ? entry.peerDependenciesMeta : {};
  for (const peer of Object.keys(peers)) {
    const meta = peerMeta[peer];
    if (isObject(meta) && meta.optional === true) delete peers[peer];
  }
  return { ...dependencies, ...optional, ...peers };
}

function verifyReachableClosure(packages: ObjectMap, root: ObjectMap): void {
  const productionPaths = Object.entries(packages)
    .filter(([path, entry]) => path !== '' && isObject(entry) && entry.dev !== true)
    .map(([path]) => path);
  const queue: Array<{ path: string; entry: ObjectMap }> = [];
  const visited = new Set<string>();

  for (const dependency of Object.keys(installedDependencyMap(root))) {
    const resolved = resolveLockedDependency(packages, '', dependency);
    if (!resolved) throw new Error(`the authenticated dependency lock omits ${dependency}`);
    queue.push(resolved);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.path)) continue;
    visited.add(current.path);
    for (const [dependency, range] of Object.entries(installedDependencyMap(current.entry))) {
      const resolved = resolveLockedDependency(packages, current.path, dependency);
      if (!resolved) {
        throw new Error(`the authenticated dependency lock omits ${dependency} required by ${current.path}`);
      }
      const resolvedVersion = resolved.entry.version;
      const validRange = semver.validRange(range);
      if (
        validRange &&
        (typeof resolvedVersion !== 'string' || !semver.satisfies(resolvedVersion, validRange, { includePrerelease: true }))
      ) {
        throw new Error(`the authenticated dependency lock substitutes ${dependency} required by ${current.path}`);
      }
      queue.push(resolved);
    }
  }

  const unreachable = productionPaths.filter((path) => !visited.has(path));
  if (unreachable.length > 0) {
    throw new Error(`the authenticated dependency lock contains an unreachable package: ${unreachable[0]}`);
  }
}

/** Validate the publishable lock carried inside the authenticated tarball.
 * Every reachable production package must be integrity-pinned and marked as
 * bundled, so the final install never needs registry resolution. */
export function validateLockedClosure(
  manifestValue: unknown,
  lockValue: unknown,
  release: OfficialRelease,
): void {
  if (!isObject(manifestValue) || manifestValue.name !== CLI_PACKAGE || manifestValue.version !== release.version) {
    throw new Error('the verified artifact package identity does not match the release');
  }
  if (!isObject(lockValue) || lockValue.lockfileVersion !== 3 || !isObject(lockValue.packages)) {
    throw new Error('the verified artifact is missing a v3 npm-shrinkwrap dependency lock');
  }
  if (lockValue.name !== CLI_PACKAGE || lockValue.version !== release.version) {
    throw new Error('the authenticated dependency lock does not match the release');
  }

  const root = isObject(lockValue.packages['']) ? lockValue.packages[''] : undefined;
  if (!root || root.name !== CLI_PACKAGE || root.version !== release.version) {
    throw new Error('the authenticated dependency lock has no matching root package');
  }
  const manifestDependencies = stringMap(manifestValue.dependencies, 'package dependency map');
  const manifestOptional = stringMap(manifestValue.optionalDependencies, 'package optional dependency map');
  const lockedDependencies = stringMap(root.dependencies, 'root dependency lock');
  const lockedOptional = stringMap(root.optionalDependencies, 'root optional dependency lock');
  if (
    !sameStringMap(manifestDependencies, lockedDependencies) ||
    !sameStringMap(manifestOptional, lockedOptional)
  ) {
    throw new Error('the authenticated dependency lock does not match package.json');
  }

  const directDependencies = Object.keys({ ...manifestDependencies, ...manifestOptional });
  const manifestBundles = stringArray(manifestValue.bundledDependencies, 'bundled dependency list');
  const lockedBundles = stringArray(root.bundleDependencies, 'root bundled dependency lock');
  if (!sameStringSet(manifestBundles, directDependencies) || !sameStringSet(lockedBundles, directDependencies)) {
    throw new Error('the verified artifact does not bundle every direct production dependency');
  }

  for (const dependency of directDependencies) {
    const direct = lockValue.packages[`node_modules/${dependency}`];
    if (!isObject(direct) || direct.dev === true) {
      throw new Error(`the authenticated dependency lock omits ${dependency}`);
    }
  }

  for (const [path, entryValue] of Object.entries(lockValue.packages)) {
    if (path === '') continue;
    if (!isObject(entryValue)) throw new Error(`the authenticated dependency lock has an invalid ${path} entry`);
    if (entryValue.dev === true) continue;
    if (entryValue.link === true) {
      throw new Error(`the authenticated dependency lock contains an unpinned link: ${path}`);
    }
    if (
      typeof entryValue.version !== 'string' ||
      typeof entryValue.resolved !== 'string' ||
      typeof entryValue.integrity !== 'string'
    ) {
      throw new Error(`the authenticated dependency lock leaves ${path} unpinned`);
    }
    if (entryValue.inBundle !== true) {
      throw new Error(`the authenticated dependency lock leaves ${path} outside the signed artifact`);
    }
    verifyOfficialDependencySource(entryValue.resolved, entryValue.integrity);
  }
  verifyReachableClosure(lockValue.packages, root);
}

function bundledManifestLockPath(tarPath: string): string | undefined {
  const prefix = 'package/';
  const suffix = '/package.json';
  if (!tarPath.startsWith(prefix) || !tarPath.endsWith(suffix)) return undefined;
  const directory = tarPath.slice(prefix.length, -suffix.length);
  if (!directory.startsWith('node_modules/')) return undefined;
  const parts = directory.split('/');
  let index = 0;
  while (index < parts.length) {
    if (parts[index] !== 'node_modules') return undefined;
    index += 1;
    if (index >= parts.length) return undefined;
    if (parts[index].startsWith('@')) index += 2;
    else index += 1;
  }
  return index === parts.length ? directory : undefined;
}

/** Validate the shrinkwrap and every bundled package manifest from an already
 * hash-verified tarball. The tarball digest authenticates both the lock's
 * integrity pins and the exact bundled bytes installed later. */
async function extractArtifactSnapshot(
  artifact: Buffer,
  extractionDir: string,
  filter: NonNullable<Parameters<typeof extractTar>[0]>['filter'],
): Promise<void> {
  await pipeline(
    Readable.from([artifact]),
    extractTar({ cwd: extractionDir, strip: 1, strict: true, filter }),
  );
}

export async function verifyLockedArtifact(
  artifact: Buffer,
  extractionDir: string,
  release: OfficialRelease,
): Promise<void> {
  mkdirSync(extractionDir, { recursive: true, mode: 0o700 });
  const allowed = new Map([
    ['package/package.json', MAX_MANIFEST_BYTES],
    ['package/npm-shrinkwrap.json', MAX_LOCKFILE_BYTES],
  ]);
  const seen = new Set<string>();
  await extractArtifactSnapshot(
    artifact,
    extractionDir,
    (path, entry) => {
      const maxSize = allowed.get(path);
      if (maxSize === undefined) return false;
      const type = 'type' in entry ? entry.type : entry.isFile() ? 'File' : 'Unsupported';
      if ((type !== 'File' && type !== 'OldFile') || entry.size > maxSize || seen.has(path)) {
        throw new Error(`the verified artifact has an unsafe ${path} entry`);
      }
      seen.add(path);
      return true;
    },
  );

  const manifestPath = join(extractionDir, 'package.json');
  const lockPath = join(extractionDir, 'npm-shrinkwrap.json');
  let manifest: unknown;
  let lock: unknown;
  try {
    if (statSync(lockPath).size > MAX_LOCKFILE_BYTES) throw new Error('lockfile too large');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    lock = JSON.parse(readFileSync(lockPath, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(`the verified artifact has no readable npm-shrinkwrap dependency lock: ${message(cause)}`);
  }
  validateLockedClosure(manifest, lock, release);

  if (!isObject(lock) || !isObject(lock.packages)) {
    throw new Error('the verified artifact has no usable dependency lock');
  }
  const expectedBundles = new Map<string, ObjectMap>();
  for (const [lockPath, entry] of Object.entries(lock.packages)) {
    if (lockPath !== '' && isObject(entry) && entry.dev !== true) expectedBundles.set(lockPath, entry);
  }

  const seenBundles = new Set<string>();
  await extractArtifactSnapshot(
    artifact,
    extractionDir,
    (tarPath, entry) => {
      const lockPath = bundledManifestLockPath(tarPath);
      if (!lockPath) return false;
      const expected = expectedBundles.get(lockPath);
      if (!expected) throw new Error(`the verified artifact bundles an unexpected dependency: ${lockPath}`);
      const type = 'type' in entry ? entry.type : entry.isFile() ? 'File' : 'Unsupported';
      if (
        (type !== 'File' && type !== 'OldFile') ||
        entry.size > MAX_MANIFEST_BYTES ||
        seenBundles.has(lockPath)
      ) {
        throw new Error(`the verified artifact has an unsafe ${tarPath} entry`);
      }
      seenBundles.add(lockPath);
      return true;
    },
  );

  for (const [lockPath, entry] of expectedBundles) {
    if (!seenBundles.has(lockPath)) {
      throw new Error(`the verified artifact omits bundled dependency ${lockPath}`);
    }
    let bundledManifest: unknown;
    try {
      const bundledPath = join(extractionDir, ...lockPath.split('/'), 'package.json');
      bundledManifest = JSON.parse(readFileSync(bundledPath, 'utf8')) as unknown;
    } catch (cause) {
      throw new Error(`the verified artifact has an unreadable bundled dependency ${lockPath}: ${message(cause)}`);
    }
    if (
      !isObject(bundledManifest) ||
      bundledManifest.name !== expectedPackageName(lockPath) ||
      bundledManifest.version !== entry.version
    ) {
      throw new Error(`the bundled dependency ${lockPath} does not match the authenticated lock`);
    }
  }
}
