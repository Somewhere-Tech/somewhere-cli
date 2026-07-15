import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installVerifiedTarball, runUpdate } from '../dist/commands/update.js';
import { validateLockedClosure, verifyPublishedProvenance } from '../dist/lib/update-security.js';

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
  const manifest = { name: PACKAGE, version, dependencies: { kleur: '4.1.5' } };
  const lock = {
    name: PACKAGE,
    version,
    lockfileVersion: 3,
    packages: {
      '': { name: PACKAGE, version, dependencies: { kleur: '4.1.5' } },
      'node_modules/kleur': {
        version: '4.1.5',
        resolved: `${REGISTRY}/kleur/-/kleur-4.1.5.tgz`,
        integrity: integrity(Buffer.from('kleur fixture')),
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

test('the release artifact declares and validates its authenticated dependency lock', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
  assert.equal(manifest.files.includes('npm-shrinkwrap.json'), true);
  validateLockedClosure(manifest, lock, {
    version: manifest.version,
    integrity: integrity(Buffer.from('packaging gate')),
    tarballUrl: `${REGISTRY}/@somewhere-tech/cli/-/cli-${manifest.version}.tgz`,
    attestationUrl: `${REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${manifest.version}`,
  });
});

test('real isolated installer honors authenticated shrinkwrap and safe npm settings', async () => {
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

  mkdirSync(binDir, { recursive: true });
  mkdirSync(operationDir, { recursive: true });
  const manifest = {
    name: PACKAGE,
    version,
    type: 'module',
    bin: { somewhere: 'bin/somewhere.js' },
    files: ['bin', 'npm-shrinkwrap.json'],
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
      },
    },
  };
  writeFileSync(join(fixtureDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(fixtureDir, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  const binPath = join(binDir, 'somewhere.js');
  writeFileSync(binPath, '#!/usr/bin/env node\nconsole.log("fixture cli");\n');
  chmodSync(binPath, 0o755);

  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], {
      cwd: fixtureDir,
      encoding: 'utf8',
    }));
    const tarballPath = join(fixtureDir, packed[0].filename);
    const release = {
      version,
      integrity: integrity(readFileSync(tarballPath)),
      tarballUrl: `${REGISTRY}/@somewhere-tech/cli/-/cli-${version}.tgz`,
      attestationUrl: `${REGISTRY}/-/npm/v1/attestations/@somewhere-tech%2fcli@${version}`,
    };

    process.env.NPM_CONFIG_PREFIX = prefix;
    process.env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:48731/';
    process.env.NPM_CONFIG_PACKAGE_LOCK = 'false';
    process.env.NPM_CONFIG_LEGACY_PEER_DEPS = 'true';
    await installVerifiedTarball(tarballPath, operationDir, release);

    const installedManifest = JSON.parse(readFileSync(
      join(prefix, 'lib', 'node_modules', '@somewhere-tech', 'cli', 'package.json'),
      'utf8',
    ));
    assert.equal(installedManifest.version, version);
    assert.equal(readFileSync(join(prefix, 'bin', 'somewhere'), 'utf8').includes('fixture cli'), true);
  } finally {
    restoreEnvironment('NPM_CONFIG_PREFIX', previousPrefix);
    restoreEnvironment('NPM_CONFIG_REGISTRY', previousRegistry);
    restoreEnvironment('NPM_CONFIG_PACKAGE_LOCK', previousPackageLock);
    restoreEnvironment('NPM_CONFIG_LEGACY_PEER_DEPS', previousLegacyPeers);
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
