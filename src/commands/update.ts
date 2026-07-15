import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

function pinnedNpmEnvironment(
  ambientEnvironment: NodeJS.ProcessEnv,
  userConfigPath: string,
  globalConfigPath: string,
  registry: string,
  proxy: string,
): NodeJS.ProcessEnv {
  const prefix = ambientEnvironment.NPM_CONFIG_PREFIX ?? Object.entries(ambientEnvironment)
    .find(([key]) => key.toLowerCase() === 'npm_config_prefix')?.[1];
  const env = Object.fromEntries(
    Object.entries(ambientEnvironment).filter(([key]) => !/^npm_config_/i.test(key)),
  );
  return {
    ...env,
    ...(prefix ? { NPM_CONFIG_PREFIX: prefix } : {}),
    NPM_CONFIG_REGISTRY: registry,
    NPM_CONFIG_USERCONFIG: userConfigPath,
    NPM_CONFIG_GLOBALCONFIG: globalConfigPath,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_PROXY: proxy,
    NPM_CONFIG_HTTPS_PROXY: proxy,
    NPM_CONFIG_NOPROXY: '127.0.0.1,localhost',
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

async function runPinnedNpm(
  args: string[],
  cwd: string,
  ambientEnvironment: NodeJS.ProcessEnv,
  userConfigPath: string,
  globalConfigPath: string,
  registry: string,
  proxy: string,
): Promise<void> {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const pinnedArgs = [
    ...args,
    '--ignore-scripts',
    '--audit=false',
    '--fund=false',
    '--update-notifier=false',
    '--package-lock=true',
    '--legacy-peer-deps=false',
    `--registry=${registry}`,
    `--@somewhere-tech:registry=${registry}`,
    `--userconfig=${userConfigPath}`,
    `--globalconfig=${globalConfigPath}`,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, pinnedArgs, {
      cwd,
      env: pinnedNpmEnvironment(ambientEnvironment, userConfigPath, globalConfigPath, registry, proxy),
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? 'unknown'}`}`));
    });
  });
}

const MAX_UPDATE_BYTES = 128 * 1024 * 1024;

function snapshotAuthenticatedArtifact(tarballPath: string): Buffer {
  const fd = openSync(tarballPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_UPDATE_BYTES) {
      throw new Error('the downloaded update artifact is not a usable regular file');
    }
    // Take one private snapshot and never consult disk again. Unlinking first
    // also ensures a later pathname replacement cannot affect this read.
    unlinkSync(tarballPath);
    return readOpenArtifact(fd, stat.size);
  } finally {
    closeSync(fd);
  }
}

function readOpenArtifact(fd: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) throw new Error('the downloaded update artifact ended while being verified');
    offset += count;
  }
  return bytes;
}

interface ArtifactServer {
  artifactUrl: string;
  registryUrl: string;
  proxyUrl: string;
  assertNoUnexpectedRequests(): void;
  close(): Promise<void>;
}

async function serveArtifactSnapshot(artifact: Buffer): Promise<ArtifactServer> {
  const token = randomBytes(32).toString('hex');
  const artifactPath = `/${token}.tgz`;
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    if ((request.method === 'GET' || request.method === 'HEAD') && request.url === artifactPath) {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(artifact.byteLength),
        'Cache-Control': 'no-store',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      response.end(artifact);
      return;
    }
    unexpected.push(`${request.method ?? 'UNKNOWN'} ${request.url ?? ''}`);
    response.writeHead(403, { Connection: 'close' });
    response.end('network access denied during authenticated update install');
  });
  server.on('connect', (request, socket) => {
    unexpected.push(`CONNECT ${request.url ?? ''}`);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    artifactUrl: `${origin}${artifactPath}`,
    registryUrl: `${origin}/registry/`,
    proxyUrl: `${origin}/denied-proxy`,
    assertNoUnexpectedRequests: () => {
      if (unexpected.length > 0) {
        throw new Error(`npm attempted network access outside the authenticated artifact: ${unexpected[0]}`);
      }
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((cause) => cause ? reject(cause) : resolve());
    }),
  };
}

/** Real installer used by production and the isolated positive test. It reads
 * and unlinks the downloaded tarball once, then uses only that immutable Buffer
 * snapshot for integrity, closure inspection, and the loopback response npm
 * consumes. Registry/proxy traffic is denied and treated as a failed update. */
export async function installVerifiedTarball(
  tarballPath: string,
  tempDir: string,
  release: OfficialRelease,
): Promise<void> {
  const ambientEnvironment = { ...process.env };
  const packageDir = join(tempDir, 'authenticated-package');
  const cacheDir = join(tempDir, 'empty-cache');
  const userConfigPath = join(tempDir, 'user-npmrc');
  const globalConfigPath = join(tempDir, 'global-npmrc');
  writeFileSync(userConfigPath, '', { mode: 0o600 });
  writeFileSync(globalConfigPath, '', { mode: 0o600 });

  const artifact = snapshotAuthenticatedArtifact(tarballPath);
  let artifactServer: ArtifactServer | undefined;
  try {
    verifyTarballIntegrity(artifact, release.integrity);
    await verifyLockedArtifact(artifact, packageDir, release);
    artifactServer = await serveArtifactSnapshot(artifact);
    await runPinnedNpm(
      ['install', '--global', `--cache=${cacheDir}`, artifactServer.artifactUrl],
      tempDir,
      ambientEnvironment,
      userConfigPath,
      globalConfigPath,
      artifactServer.registryUrl,
      artifactServer.proxyUrl,
    );
    artifactServer.assertNoUnexpectedRequests();
  } finally {
    if (artifactServer) await artifactServer.close();
  }
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
