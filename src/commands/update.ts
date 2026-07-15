import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import semver from 'semver';
import { dim, error, info, success, teal } from '../lib/output.js';
import {
  assertUpdateVerificationRuntime,
  CLI_PACKAGE,
  OFFICIAL_NPM_REGISTRY,
  parseOfficialRelease,
  verifyLockedArtifact,
  verifyPublishedProvenance,
  verifyTarballIntegrity,
  type OfficialRelease,
} from '../lib/update-security.js';

const PACKUMENT_URL = `${OFFICIAL_NPM_REGISTRY}/@somewhere-tech%2Fcli`;

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FetchUpdate = (url: string, init?: RequestInit) => Promise<FetchResponse>;

interface UpdateDependencies {
  fetch?: FetchUpdate;
  currentVersion?: () => string;
  verifyProvenance?: (body: unknown, release: OfficialRelease) => Promise<void>;
  install?: (tarballPath: string, tempDir: string, release: OfficialRelease) => Promise<void>;
}

const message = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/** Read the installed CLI's own version from its package.json (dist/commands/ →
 * package root is two levels up). */
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

function pinnedNpmEnvironment(userConfigPath: string, globalConfigPath: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !/^npm_config_/i.test(key) || /^npm_config_prefix$/i.test(key)),
  );
  return {
    ...env,
    NPM_CONFIG_REGISTRY: OFFICIAL_NPM_REGISTRY,
    NPM_CONFIG_USERCONFIG: userConfigPath,
    NPM_CONFIG_GLOBALCONFIG: globalConfigPath,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
  };
}

function runPinnedNpm(
  args: string[],
  cwd: string,
  userConfigPath: string,
  globalConfigPath: string,
): void {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const pinnedArgs = [
    ...args,
    '--ignore-scripts',
    '--audit=false',
    '--fund=false',
    '--package-lock=true',
    '--legacy-peer-deps=false',
    `--registry=${OFFICIAL_NPM_REGISTRY}`,
    `--@somewhere-tech:registry=${OFFICIAL_NPM_REGISTRY}`,
    `--userconfig=${userConfigPath}`,
    `--globalconfig=${globalConfigPath}`,
  ];
  execFileSync(npmCommand, pinnedArgs, {
    cwd,
    env: pinnedNpmEnvironment(userConfigPath, globalConfigPath),
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
}

/** Real installer used by production and the isolated positive test. The
 * authenticated tarball contains its entire locked production closure, so the
 * final install can consume those same bytes with networking disabled. */
export async function installVerifiedTarball(
  tarballPath: string,
  tempDir: string,
  release: OfficialRelease,
): Promise<void> {
  const packageDir = join(tempDir, 'authenticated-package');
  const cacheDir = join(tempDir, 'empty-cache');
  const userConfigPath = join(tempDir, 'user-npmrc');
  const globalConfigPath = join(tempDir, 'global-npmrc');
  writeFileSync(userConfigPath, '', { mode: 0o600 });
  writeFileSync(globalConfigPath, '', { mode: 0o600 });

  await verifyLockedArtifact(tarballPath, packageDir, release);
  // Do not trust a path merely because it was verified earlier. Re-hash the
  // private on-disk artifact immediately before handing that same path to npm.
  verifyTarballIntegrity(readFileSync(tarballPath), release.integrity);
  runPinnedNpm(
    ['install', '--global', '--offline', `--cache=${cacheDir}`, tarballPath],
    tempDir,
    userConfigPath,
    globalConfigPath,
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
    assertUpdateVerificationRuntime();
    const provenance = await fetchJson(fetchImpl, release.attestationUrl, 'the official npm provenance endpoint');
    await (dependencies.verifyProvenance ?? verifyPublishedProvenance)(provenance, release);
    const tarball = await downloadTarball(fetchImpl, release);

    tempDir = mkdtempSync(join(tmpdir(), 'somewhere-update-'));
    const tarballPath = join(tempDir, `cli-${release.version}.tgz`);
    writeFileSync(tarballPath, tarball, { mode: 0o600 });

    info(`Cryptographically verified provenance and integrity for ${CLI_PACKAGE}@${release.version}.`);
    info(`Updating ${CLI_PACKAGE} from its authenticated dependency lock …`);
    await (dependencies.install ?? installVerifiedTarball)(tarballPath, tempDir, release);
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
    .description('Update the somewhere CLI from a cryptographically verified official release.')
    .option('--check', 'Only report whether an update is available; do not install.')
    .action(async (opts: { check?: boolean }) => {
      process.exitCode = await runUpdate(opts);
    });
}
