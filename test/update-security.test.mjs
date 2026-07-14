import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runUpdate } from '../dist/commands/update.js';

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

function provenance(version, bytes) {
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
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
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
      install: () => { installed = true; },
    });

    assert.equal(code, 1);
    assert.equal(installed, false);
    assert.deepEqual(requested, [PACKUMENT_URL], 'ambient npm registry must never be consulted');
  } finally {
    if (previousRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
    else process.env.NPM_CONFIG_REGISTRY = previousRegistry;
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
      if (url.includes('/attestations/')) return jsonResponse(provenance(version, published));
      return tarballResponse(forged);
    },
    install: () => { installed = true; },
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
    install: () => { installed = true; },
  });

  assert.equal(code, 1);
  assert.equal(installed, false);
  assert.deepEqual(requested, [PACKUMENT_URL]);
});

test('update installs only after official provenance and tarball integrity pass', async () => {
  const version = '1.1.0';
  const tarball = Buffer.from('verified package');
  const events = [];

  const code = await runUpdate({}, {
    currentVersion: () => '1.0.0',
    fetch: async (url) => {
      if (url === PACKUMENT_URL) {
        events.push('metadata');
        return jsonResponse(metadata(version, tarball));
      }
      if (url.includes('/attestations/')) {
        events.push('provenance');
        return jsonResponse(provenance(version, tarball));
      }
      events.push('tarball');
      return tarballResponse(tarball);
    },
    install: (tarballPath, userConfigPath, globalConfigPath) => {
      events.push('install');
      assert.match(tarballPath, /cli-1\.1\.0\.tgz$/);
      assert.match(userConfigPath, /user-npmrc$/);
      assert.match(globalConfigPath, /global-npmrc$/);
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(events, ['metadata', 'provenance', 'tarball', 'install']);
});
