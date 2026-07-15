import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import semver from 'semver';
import { installVerifiedTarball, runUpdate } from '../dist/commands/update.js';
import {
  validateLockedClosure,
  verifyLockedArtifact,
  verifyPublishedProvenance,
} from '../dist/lib/update-security.js';

const PACKAGE = '@somewhere-tech/cli';
const REGISTRY = 'https://registry.npmjs.org';
const PACKUMENT_URL = `${REGISTRY}/@somewhere-tech%2Fcli`;
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';

function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function metadata(version, bytes) {
  return {
    name: PACKAGE,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name: PACKAGE,
        version,
        dist: {
          integrity: integrity(bytes),
          tarball: `${REGISTRY}/@somewhere-tech/cli/-/cli-${version}.tgz`,
          attestations: {
            url: `${REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${version}`,
            provenance: { predicateType: SLSA_PROVENANCE },
          },
        },
      },
    },
  };
}

function unsignedProvenance(version, bytes) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: `pkg:npm/%40somewhere-tech/cli@${version}`,
      digest: { sha512: createHash('sha512').update(bytes).digest('hex') },
    }],
    predicateType: SLSA_PROVENANCE,
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: 'https://github.com/Somewhere-Tech/somewhere-cli' },
        },
      },
    },
  };
  return {
    attestations: [{
      predicateType: SLSA_PROVENANCE,
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.2',
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          signatures: [{ sig: Buffer.from('forged').toString('base64') }],
        },
      },
    }],
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => { throw new Error('not a tarball response'); },
  };
}

function tarballResponse(bytes) {
  return {
    ok: true,
    status: 200,
    json: async () => { throw new Error('not a JSON response'); },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function restoreEnvironment(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('update refuses an ambient forged release with no provenance or integrity', async () => {
  const previousRegistry = process.env.NPM_CONFIG_REGISTRY;
  process.env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:48731/';
  let installed = false;
  const requested = [];
  try {
    const code = await runUpdate({}, {
      currentVersion: () => '1.0.0',
      fetch: async (url) => {
        requested.push(url);
        return jsonResponse({
          'dist-tags': { latest: '9.9.9' },
          versions: {
            '9.9.9': {
              name: PACKAGE,
              version: '9.9.9',
              dist: { tarball: 'http://127.0.0.1:48731/forged.tgz' },
            },
          },
        });
      },
      install: async () => { installed = true; },
    });

    assert.equal(code, 1);
    assert.equal(installed, false);
    assert.deepEqual(requested, [PACKUMENT_URL], 'ambient npm registry must never be consulted');
  } finally {
    restoreEnvironment('NPM_CONFIG_REGISTRY', previousRegistry);
  }
});

test('update refuses unsigned provenance before downloading or installing', async () => {
  const version = '1.1.0';
  const published = Buffer.from('published package');
  let installed = false;
  const requested = [];

  const code = await runUpdate({}, {
    currentVersion: () => '1.0.0',
    fetch: async (url) => {
      requested.push(url);
      if (url === PACKUMENT_URL) return jsonResponse(metadata(version, published));
      if (url.includes('/attestations/')) return jsonResponse(unsignedProvenance(version, published));
      return tarballResponse(published);
    },
    install: async () => { installed = true; },
  });

  assert.equal(code, 1);
  assert.equal(installed, false);
  assert.deepEqual(requested, [PACKUMENT_URL, metadata(version, published).versions[version].dist.attestations.url]);
});

test('unsupported Node refuses clearly before tarball download or install', async () => {
  const version = '1.1.0';
  const published = Buffer.from('published package');
  const releaseMetadata = metadata(version, published);
  const attestationUrl = releaseMetadata.versions[version].dist.attestations.url;
  let installed = false;
  const requested = [];
  const nodeVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
  Object.defineProperty(process.versions, 'node', { ...nodeVersionDescriptor, value: '18.20.8' });

  try {
    await assert.rejects(
      verifyPublishedProvenance({}, {
        version,
        integrity: integrity(published),
        tarballUrl: releaseMetadata.versions[version].dist.tarball,
        attestationUrl,
      }),
      /Update verification needs Node 22\.19\+.*Please upgrade Node, then re-run `somewhere update`/,
    );

    const code = await runUpdate({}, {
      currentVersion: () => '1.0.0',
      fetch: async (url) => {
        requested.push(url);
        if (url === PACKUMENT_URL) return jsonResponse(releaseMetadata);
        if (url === attestationUrl) return jsonResponse({});
        return tarballResponse(published);
      },
      install: async () => { installed = true; },
    });

    assert.equal(code, 1);
    assert.equal(installed, false);
    assert.deepEqual(requested, [PACKUMENT_URL]);
  } finally {
    Object.defineProperty(process.versions, 'node', nodeVersionDescriptor);
  }
});

test('update refuses a forged tarball whose bytes fail the published integrity', async () => {
  const version = '1.1.0';
  const published = Buffer.from('published package');
  const forged = Buffer.from('forged package');
  let installed = false;

  const code = await runUpdate({}, {
    currentVersion: () => '1.0.0',
    fetch: async (url) => {
      if (url === PACKUMENT_URL) return jsonResponse(metadata(version, published));
      if (url.includes('/attestations/')) return jsonResponse(unsignedProvenance(version, published));
      return tarballResponse(forged);
    },
    verifyProvenance: async () => {},
    install: async () => { installed = true; },
  });

  assert.equal(code, 1);
  assert.equal(installed, false);
});

test('update refuses a downgrade before downloading or installing it', async () => {
  const release = Buffer.from('older official package');
  let installed = false;
  const requested = [];

  const code = await runUpdate({}, {
    currentVersion: () => '2.0.0',
    fetch: async (url) => {
      requested.push(url);
      return jsonResponse(metadata('1.9.0', release));
    },
    install: async () => { installed = true; },
  });

  assert.equal(code, 1);
  assert.equal(installed, false);
  assert.deepEqual(requested, [PACKUMENT_URL]);
});

test('authenticated dependency closure rejects unpinned and non-official packages', () => {
  const version = '1.1.0';
  const release = {
    version,
    integrity: integrity(Buffer.from('release')),
    tarballUrl: `${REGISTRY}/@somewhere-tech/cli/-/cli-${version}.tgz`,
    attestationUrl: `${REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${version}`,
  };
  const manifest = {
    name: PACKAGE,
    version,
    dependencies: { kleur: '4.1.5' },
    bundledDependencies: ['kleur'],
  };
  const lock = {
    name: PACKAGE,
    version,
    lockfileVersion: 3,
    packages: {
      '': {
        name: PACKAGE,
        version,
        dependencies: { kleur: '4.1.5' },
        bundleDependencies: ['kleur'],
      },
      'node_modules/kleur': {
        version: '4.1.5',
        resolved: `${REGISTRY}/kleur/-/kleur-4.1.5.tgz`,
        integrity: integrity(Buffer.from('kleur fixture')),
        inBundle: true,
      },
    },
  };

  const unpinned = structuredClone(lock);
  delete unpinned.packages['node_modules/kleur'].integrity;
  assert.throws(
    () => validateLockedClosure(manifest, unpinned, release),
    /leaves node_modules\/kleur unpinned/,
  );

  const poisoned = structuredClone(lock);
  poisoned.packages['node_modules/kleur'].resolved = 'https://evil.example/kleur-4.1.5.tgz';
  assert.throws(
    () => validateLockedClosure(manifest, poisoned, release),
    /non-official source/,
  );
});

test('the release artifact bundles its complete authenticated dependency lock', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
  assert.equal(manifest.files.includes('npm-shrinkwrap.json'), true);
  const root = mkdtempSync(join(tmpdir(), 'somewhere-packaging-test-'));
  const prefix = join(root, 'prefix');
  const operationDir = join(root, 'operation');
  const previousPrefix = process.env.NPM_CONFIG_PREFIX;
  const previousRegistry = process.env.NPM_CONFIG_REGISTRY;
  try {
    const packed = JSON.parse(execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', `--pack-destination=${root}`],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    ));
    const tarballPath = join(root, packed[0].filename);
    const productionNames = new Set(Object.entries(lock.packages)
      .filter(([path, entry]) => path !== '' && entry.dev !== true)
      .map(([path]) => path.match(/node_modules\/(?:@[^/]+\/[^/]+|[^/]+)$/)?.[0].slice('node_modules/'.length)));
    productionNames.delete(undefined);
    assert.deepEqual(new Set(packed[0].bundled), productionNames);
    mkdirSync(operationDir);
    process.env.NPM_CONFIG_PREFIX = prefix;
    process.env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:48731/';
    await installVerifiedTarball(tarballPath, operationDir, {
      version: manifest.version,
      integrity: integrity(readFileSync(tarballPath)),
      tarballUrl: `${REGISTRY}/@somewhere-tech/cli/-/cli-${manifest.version}.tgz`,
      attestationUrl: `${REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${manifest.version}`,
    });
    const installedManifest = JSON.parse(readFileSync(
      join(prefix, 'lib', 'node_modules', PACKAGE, 'package.json'),
      'utf8',
    ));
    assert.equal(installedManifest.version, manifest.version);
    assert.match(
      execFileSync(join(prefix, 'bin', 'somewhere'), ['--version'], { encoding: 'utf8' }),
      new RegExp(manifest.version.replaceAll('.', '\\.')),
    );
  } finally {
    restoreEnvironment('NPM_CONFIG_PREFIX', previousPrefix);
    restoreEnvironment('NPM_CONFIG_REGISTRY', previousRegistry);
    rmSync(root, { recursive: true, force: true });
  }
});

test('real isolated install survives post-verification path and writable-fd swaps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'somewhere-update-test-'));
  const fixtureDir = join(root, 'fixture');
  const binDir = join(fixtureDir, 'bin');
  const prefix = join(root, 'prefix');
  const operationDir = join(root, 'operation');
  const version = '9.9.9';
  const previousPrefix = process.env.NPM_CONFIG_PREFIX;
  const previousRegistry = process.env.NPM_CONFIG_REGISTRY;
  const previousPackageLock = process.env.NPM_CONFIG_PACKAGE_LOCK;
  const previousLegacyPeers = process.env.NPM_CONFIG_LEGACY_PEER_DEPS;
  const previousPath = process.env.PATH;
  const previousSwapSource = process.env.SOMEWHERE_SWAP_SOURCE;
  const previousSwapTarget = process.env.SOMEWHERE_SWAP_TARGET;
  const previousRealNpm = process.env.SOMEWHERE_REAL_NPM;
  const previousSwapTrigger = process.env.SOMEWHERE_SWAP_TRIGGER;
  const previousSwapDone = process.env.SOMEWHERE_SWAP_DONE;
  const repositoryLock = JSON.parse(readFileSync(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
  const closurePaths = ['node_modules/prompts', 'node_modules/kleur', 'node_modules/sisteransi'];
  const lockedClosure = Object.fromEntries(closurePaths.map((path) => {
    const entry = repositoryLock.packages[path];
    assert.equal(typeof entry?.integrity, 'string');
    return [path, entry];
  }));
  const promptsVersion = lockedClosure['node_modules/prompts'].version;
  const pinnedSemver = {
    version: '7.6.3',
    resolved: `${REGISTRY}/semver/-/semver-7.6.3.tgz`,
    integrity: 'sha512-oVekP1cKtI+CTDvHWYFUcMtsK/00wmAEfyqKfNdARm8u1wNVhSgaX7A8d4UuIlUI5e84iEwOhs7ZPYRmzU9U6A==',
    inBundle: true,
    license: 'ISC',
    bin: { semver: 'bin/semver.js' },
    engines: { node: '>=10' },
  };
  const newerSemver = repositoryLock.packages['node_modules/semver'].version;
  assert.equal(semver.gt(newerSemver, pinnedSemver.version), true);
  assert.equal(semver.satisfies(newerSemver, '^7.6.0'), true);

  mkdirSync(binDir, { recursive: true });
  mkdirSync(operationDir, { recursive: true });
  const manifest = {
    name: PACKAGE,
    version,
    type: 'module',
    bin: { somewhere: 'bin/somewhere.js' },
    files: ['bin', 'npm-shrinkwrap.json'],
    dependencies: { prompts: promptsVersion, semver: '^7.6.0' },
    bundledDependencies: ['prompts', 'semver'],
    scripts: {
      preinstall: 'node -e "process.exit(93)"',
      postinstall: 'node -e "process.exit(94)"',
    },
  };
  const shrinkwrap = {
    name: PACKAGE,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: PACKAGE,
        version,
        bin: { somewhere: 'bin/somewhere.js' },
        dependencies: { prompts: promptsVersion, semver: '^7.6.0' },
        bundleDependencies: ['prompts', 'semver'],
      },
      ...lockedClosure,
      'node_modules/semver': pinnedSemver,
    },
  };
  writeFileSync(join(fixtureDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(fixtureDir, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  const binPath = join(binDir, 'somewhere.js');
  writeFileSync(
    binPath,
    '#!/usr/bin/env node\nimport prompts from "prompts";\n' +
      'import { createRequire } from "node:module";\n' +
      'if (typeof prompts !== "function") process.exit(95);\n' +
      'const require = createRequire(import.meta.url);\n' +
      'if (require("semver/package.json").version !== "7.6.3") process.exit(96);\n' +
      'console.log("fixture dependency closure executed");\n',
  );
  chmodSync(binPath, 0o755);

  try {
    execFileSync('npm', ['ci', '--ignore-scripts', '--audit=false', '--fund=false'], {
      cwd: fixtureDir,
      stdio: 'inherit',
    });
    const packFixture = () => JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], {
      cwd: fixtureDir,
      encoding: 'utf8',
    }));
    const packed = packFixture();
    const packedPath = join(fixtureDir, packed[0].filename);
    const tarballPath = join(root, 'authenticated-cli.tgz');
    copyFileSync(packedPath, tarballPath);
    const release = {
      version,
      integrity: integrity(readFileSync(tarballPath)),
      tarballUrl: `${REGISTRY}/@somewhere-tech/cli/-/cli-${version}.tgz`,
      attestationUrl: `${REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${version}`,
    };

    writeFileSync(binPath, '#!/usr/bin/env node\nconsole.log("malicious swapped artifact executed");\n');
    const swappedPack = packFixture();
    const swappedPath = join(fixtureDir, swappedPack[0].filename);
    mkdirSync(join(root, 'swapped-operation'));
    await assert.rejects(
      installVerifiedTarball(swappedPath, join(root, 'swapped-operation'), release),
      /downloaded update does not match its published integrity digest/,
    );

    const poisonDir = join(root, 'poisoned-transitive');
    mkdirSync(poisonDir);
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--audit=false', '--fund=false', '--no-save', 'kleur@4.1.5'],
      { cwd: poisonDir, stdio: 'inherit' },
    );
    rmSync(join(fixtureDir, 'node_modules', 'kleur'), { recursive: true, force: true });
    cpSync(join(poisonDir, 'node_modules', 'kleur'), join(fixtureDir, 'node_modules', 'kleur'), {
      recursive: true,
    });
    const substitutedPack = packFixture();
    const substitutedPath = join(fixtureDir, substitutedPack[0].filename);
    await assert.rejects(
      verifyLockedArtifact(readFileSync(substitutedPath), join(root, 'substituted-operation'), release),
      /does not match the authenticated lock/,
    );

    const wrapperDir = join(root, 'npm-wrapper');
    const wrapperPath = join(wrapperDir, 'npm');
    const swapTrigger = join(root, 'swap-trigger');
    const swapDone = join(root, 'swap-done');
    const realNpm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
    mkdirSync(wrapperDir);
    writeFileSync(
      wrapperPath,
      '#!/bin/sh\n/bin/cp "$SOMEWHERE_SWAP_SOURCE" "$SOMEWHERE_SWAP_TARGET"\n' +
        ': > "$SOMEWHERE_SWAP_TRIGGER"\n' +
        'while [ ! -f "$SOMEWHERE_SWAP_DONE" ]; do /bin/sleep 0.01; done\n' +
        'exec "$SOMEWHERE_REAL_NPM" "$@"\n',
    );
    chmodSync(wrapperPath, 0o755);

    process.env.NPM_CONFIG_PREFIX = prefix;
    process.env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:48731/';
    process.env.NPM_CONFIG_PACKAGE_LOCK = 'false';
    process.env.NPM_CONFIG_LEGACY_PEER_DEPS = 'true';
    process.env.PATH = `${wrapperDir}:${previousPath}`;
    process.env.SOMEWHERE_SWAP_SOURCE = substitutedPath;
    process.env.SOMEWHERE_SWAP_TARGET = tarballPath;
    process.env.SOMEWHERE_REAL_NPM = realNpm;
    process.env.SOMEWHERE_SWAP_TRIGGER = swapTrigger;
    process.env.SOMEWHERE_SWAP_DONE = swapDone;

    const attackerFd = openSync(tarballPath, 'r+');
    try {
      const mutatePreopenedFd = (async () => {
        await waitForFile(swapTrigger);
        const maliciousBytes = readFileSync(substitutedPath);
        ftruncateSync(attackerFd, 0);
        let offset = 0;
        while (offset < maliciousBytes.byteLength) {
          offset += writeSync(
            attackerFd,
            maliciousBytes,
            offset,
            maliciousBytes.byteLength - offset,
            offset,
          );
        }
        fsyncSync(attackerFd);
        writeFileSync(swapDone, '');
      })();
      const results = await Promise.allSettled([
        installVerifiedTarball(tarballPath, operationDir, release),
        mutatePreopenedFd,
      ]);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }

      const rewritten = Buffer.alloc(fstatSync(attackerFd).size);
      assert.equal(readSync(attackerFd, rewritten, 0, rewritten.byteLength, 0), rewritten.byteLength);
      assert.deepEqual(rewritten, readFileSync(substitutedPath));
    } finally {
      closeSync(attackerFd);
    }

    assert.deepEqual(readFileSync(tarballPath), readFileSync(substitutedPath));

    const installedManifest = JSON.parse(readFileSync(
      join(prefix, 'lib', 'node_modules', '@somewhere-tech', 'cli', 'package.json'),
      'utf8',
    ));
    assert.equal(installedManifest.version, version);
    for (const dependency of ['prompts', 'kleur', 'sisteransi', 'semver']) {
      const installedDependency = JSON.parse(readFileSync(
        join(prefix, 'lib', 'node_modules', PACKAGE, 'node_modules', dependency, 'package.json'),
        'utf8',
      ));
      assert.equal(typeof installedDependency.version, 'string');
      if (dependency === 'semver') assert.equal(installedDependency.version, pinnedSemver.version);
    }
    const output = execFileSync(join(prefix, 'bin', 'somewhere'), [], { encoding: 'utf8' });
    assert.match(output, /fixture dependency closure executed/);
    assert.doesNotMatch(output, /malicious swapped artifact executed/);
  } finally {
    restoreEnvironment('NPM_CONFIG_PREFIX', previousPrefix);
    restoreEnvironment('NPM_CONFIG_REGISTRY', previousRegistry);
    restoreEnvironment('NPM_CONFIG_PACKAGE_LOCK', previousPackageLock);
    restoreEnvironment('NPM_CONFIG_LEGACY_PEER_DEPS', previousLegacyPeers);
    restoreEnvironment('PATH', previousPath);
    restoreEnvironment('SOMEWHERE_SWAP_SOURCE', previousSwapSource);
    restoreEnvironment('SOMEWHERE_SWAP_TARGET', previousSwapTarget);
    restoreEnvironment('SOMEWHERE_REAL_NPM', previousRealNpm);
    restoreEnvironment('SOMEWHERE_SWAP_TRIGGER', previousSwapTrigger);
    restoreEnvironment('SOMEWHERE_SWAP_DONE', previousSwapDone);
    rmSync(root, { recursive: true, force: true });
  }
});

test('live official release satisfies the pinned Sigstore identity policy', {
  skip: process.env.SOMEWHERE_LIVE_UPDATE_TEST !== '1',
}, async () => {
  const version = '0.24.0';
  const release = {
    version,
    integrity: 'sha512-Nh2K94A9Q3K+6zVygtQD/EVCC71i7EGvDzw0Kaq/6xP5Tq/aQREdl4gVkN1P6LUdPjZHywbqFJRdUFC1+ICk/A==',
    tarballUrl: `${REGISTRY}/@somewhere-tech/cli/-/cli-${version}.tgz`,
    attestationUrl: `${REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${version}`,
  };
  const response = await fetch(release.attestationUrl);
  assert.equal(response.ok, true);
  const provenance = await response.json();
  await verifyPublishedProvenance(provenance, release);

  const forged = structuredClone(provenance);
  const attestation = forged.attestations.find((entry) => entry.predicateType === SLSA_PROVENANCE);
  attestation.bundle.dsseEnvelope.signatures[0].sig = Buffer.from('forged signature').toString('base64');
  await assert.rejects(
    verifyPublishedProvenance(forged, release),
    /cryptographic npm provenance verification failed/,
  );

  await assert.rejects(
    verifyPublishedProvenance(provenance, {
      ...release,
      integrity: integrity(Buffer.from('mismatched registry digest')),
    }),
    /signed provenance does not match/,
  );
});
