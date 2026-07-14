import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import semver from 'semver';
import { dim, error, info, success, teal } from '../lib/output.js';

const PACKAGE = '@somewhere-tech/cli';
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org';
const OFFICIAL_REPOSITORY = 'https://github.com/Somewhere-Tech/somewhere-cli';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const PACKUMENT_URL = `${OFFICIAL_REGISTRY}/@somewhere-tech%2Fcli`;

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FetchUpdate = (url: string, init?: RequestInit) => Promise<FetchResponse>;

export interface OfficialRelease {
  version: string;
  integrity: string;
  tarballUrl: string;
  attestationUrl: string;
}

interface UpdateDependencies {
  fetch?: FetchUpdate;
  currentVersion?: () => string;
  install?: (tarballPath: string, userConfigPath: string, globalConfigPath: string) => void;
}

interface ObjectMap {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is ObjectMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const message = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/** Read the installed CLI's own version from its package.json (dist/commands/ →
 *  package root is two levels up). */
function currentVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function expectedTarballUrl(version: string): string {
  return `${OFFICIAL_REGISTRY}/@somewhere-tech/cli/-/cli-${encodeURIComponent(version)}.tgz`;
}

function expectedAttestationUrl(version: string): string {
  return `${OFFICIAL_REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${encodeURIComponent(version)}`;
}

function sha512Digest(integrity: string): Buffer {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) throw new Error('the official release is missing a valid sha512 integrity digest');
  const digest = Buffer.from(match[1], 'base64');
  if (digest.length !== 64) throw new Error('the official release has an invalid sha512 integrity digest');
  return digest;
}

/** Extract and validate the exact release coordinates from npm's official
 * packument. A registry response is not trusted merely because it names the
 * right package: the tarball, integrity, and SLSA attestation endpoints must all
 * be present and pinned to the official registry. */
export function parseOfficialRelease(body: unknown): OfficialRelease {
  if (!isObject(body)) throw new Error('the official registry returned invalid package metadata');
  const tags = isObject(body['dist-tags']) ? body['dist-tags'] : undefined;
  const latest = tags?.latest;
  if (typeof latest !== 'string' || !semver.valid(latest)) {
    throw new Error('the official registry returned an invalid latest version');
  }

  const versions = isObject(body.versions) ? body.versions : undefined;
  const manifest = versions && isObject(versions[latest]) ? versions[latest] : undefined;
  if (!manifest || manifest.name !== PACKAGE || manifest.version !== latest) {
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

function expectedPackageUrl(version: string): string {
  return `pkg:npm/%40somewhere-tech/cli@${version}`;
}

/** Validate that npm's published SLSA statement ties this exact tarball digest
 * to the official CLI repository. The response itself comes from the pinned
 * npm registry; the digest is checked again against the downloaded bytes below. */
export function verifyPublishedProvenance(body: unknown, release: OfficialRelease): void {
  if (!isObject(body) || !Array.isArray(body.attestations)) {
    throw new Error('the official release provenance could not be verified');
  }
  const attestation = body.attestations.find(
    (entry): entry is ObjectMap => isObject(entry) && entry.predicateType === SLSA_PROVENANCE,
  );
  const bundle = attestation && isObject(attestation.bundle) ? attestation.bundle : undefined;
  const envelope = bundle && isObject(bundle.dsseEnvelope) ? bundle.dsseEnvelope : undefined;
  if (typeof envelope?.payload !== 'string' || envelope.payloadType !== 'application/vnd.in-toto+json') {
    throw new Error('the official release has no usable SLSA provenance statement');
  }

  let statement: ObjectMap;
  try {
    const decoded = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as unknown;
    if (!isObject(decoded)) throw new Error('invalid statement');
    statement = decoded;
  } catch {
    throw new Error('the official release has malformed SLSA provenance');
  }
  if (statement.predicateType !== SLSA_PROVENANCE || !Array.isArray(statement.subject)) {
    throw new Error('the official release has mismatched SLSA provenance');
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
  if (!subjectMatches || workflow?.repository !== OFFICIAL_REPOSITORY) {
    throw new Error('the official release provenance does not match this package and repository');
  }
}

export function verifyTarballIntegrity(bytes: Uint8Array, integrity: string): void {
  const expected = sha512Digest(integrity);
  const actual = createHash('sha512').update(bytes).digest();
  if (!timingSafeEqual(actual, expected)) {
    throw new Error('the downloaded update does not match its published integrity digest');
  }
}

function pinnedNpmEnvironment(userConfigPath: string, globalConfigPath: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_.*registry$/i.test(key)),
  );
  return {
    ...env,
    NPM_CONFIG_REGISTRY: OFFICIAL_REGISTRY,
    NPM_CONFIG_USERCONFIG: userConfigPath,
    NPM_CONFIG_GLOBALCONFIG: globalConfigPath,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
  };
}

function installVerifiedTarball(
  tarballPath: string,
  userConfigPath: string,
  globalConfigPath: string,
): void {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(
    npmCommand,
    [
      'install',
      '--global',
      tarballPath,
      '--ignore-scripts',
      `--registry=${OFFICIAL_REGISTRY}`,
      `--@somewhere-tech:registry=${OFFICIAL_REGISTRY}`,
      `--userconfig=${userConfigPath}`,
      `--globalconfig=${globalConfigPath}`,
    ],
    {
      cwd: dirname(tarballPath),
      env: pinnedNpmEnvironment(userConfigPath, globalConfigPath),
      shell: process.platform === 'win32',
      stdio: 'inherit',
    },
  );
}

async function fetchJson(fetchImpl: FetchUpdate, url: string, label: string): Promise<unknown> {
  let response: FetchResponse;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (cause) {
    throw new Error(`${label} is unavailable: ${message(cause)}`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function downloadTarball(fetchImpl: FetchUpdate, release: OfficialRelease): Promise<Uint8Array> {
  let response: FetchResponse;
  try {
    response = await fetchImpl(release.tarballUrl, { headers: { Accept: 'application/octet-stream' } });
  } catch (cause) {
    throw new Error(`the official update tarball is unavailable: ${message(cause)}`);
  }
  if (!response.ok) throw new Error(`the official update tarball returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyTarballIntegrity(bytes, release.integrity);
  return bytes;
}

export async function runUpdate(
  opts: { check?: boolean },
  dependencies: UpdateDependencies = {},
): Promise<number> {
  const fetchImpl = dependencies.fetch ?? (fetch as FetchUpdate);
  const installedVersion = (dependencies.currentVersion ?? currentVersion)();

  let release: OfficialRelease;
  try {
    const metadata = await fetchJson(fetchImpl, PACKUMENT_URL, 'the official npm registry');
    release = parseOfficialRelease(metadata);
  } catch (cause) {
    error(`Update refused: ${message(cause)}.`);
    return 1;
  }

  if (release.version === installedVersion) {
    success(`You're on the latest version (${teal(installedVersion)}).`);
    return 0;
  }
  if (!semver.valid(installedVersion) || !semver.gt(release.version, installedVersion)) {
    error(`Update refused: the official latest version (${release.version}) is not newer than ${installedVersion}.`);
    return 1;
  }

  info(`Update available: ${dim(installedVersion)} → ${teal(release.version)}`);
  if (opts.check) {
    info(`Run ${teal('somewhere update')} to install it.`);
    return 0;
  }

  let tempDir: string | undefined;
  try {
    const provenance = await fetchJson(fetchImpl, release.attestationUrl, 'the official npm provenance endpoint');
    verifyPublishedProvenance(provenance, release);
    const tarball = await downloadTarball(fetchImpl, release);

    tempDir = mkdtempSync(join(tmpdir(), 'somewhere-update-'));
    const tarballPath = join(tempDir, `cli-${release.version}.tgz`);
    const userConfigPath = join(tempDir, 'user-npmrc');
    const globalConfigPath = join(tempDir, 'global-npmrc');
    writeFileSync(tarballPath, tarball, { mode: 0o600 });
    writeFileSync(userConfigPath, '', { mode: 0o600 });
    writeFileSync(globalConfigPath, '', { mode: 0o600 });

    info(`Verified provenance and integrity for ${PACKAGE}@${release.version}.`);
    info(`Updating ${PACKAGE} …`);
    (dependencies.install ?? installVerifiedTarball)(tarballPath, userConfigPath, globalConfigPath);
  } catch (cause) {
    error(`Update refused: ${message(cause)}.`);
    return 1;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }

  success(`Updated to ${release.version}. Run ${teal('somewhere --version')} to confirm.`);
  return 0;
}

export function registerUpdate(program: Command) {
  program
    .command('update')
    .description('Update the somewhere CLI from the verified official npm release.')
    .option('--check', 'Only report whether an update is available; do not install.')
    .action(async (opts: { check?: boolean }) => {
      process.exitCode = await runUpdate(opts);
    });
}
