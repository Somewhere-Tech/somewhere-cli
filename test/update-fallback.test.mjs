// tsk_f681c871: every `somewhere update` refusal names the npm command that
// still works, and agents on a CLI a minor release or more behind are told so
// once a day, even with piped (non-TTY) output.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runUpdate } from '../dist/commands/update.js';
import { getOutdatedWarning, isMinorBehind } from '../dist/lib/notify/providers/update.js';
import { collectNotices } from '../dist/lib/notify/index.js';

const PACKAGE = '@somewhere-tech/cli';
const REGISTRY = 'https://registry.npmjs.org';
const PACKUMENT_URL = `${REGISTRY}/@somewhere-tech%2Fcli`;
const FALLBACK = /To install the latest release with npm instead, run: npm i -g @somewhere-tech\/cli@latest/;

const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
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
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
          },
        },
      },
    },
  };
}
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
const tarballResponse = (bytes) => ({
  ok: true, status: 200, json: async () => { throw new Error('not JSON'); },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

async function captured(fn) {
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), output: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test('a refused update exits 1 and prints the npm fallback (the 0.37.0-and-older provenance case)', async () => {
  const published = Buffer.from('published package');
  const { result, output } = await captured(() => runUpdate({}, {
    currentVersion: () => '0.33.10',
    fetch: async (url) => (url === PACKUMENT_URL ? jsonResponse(metadata('0.37.6', published)) : jsonResponse({ attestations: [] })),
    install: async () => { throw new Error('must not install'); },
  }));
  assert.equal(result, 1);
  assert.match(output, /Update refused: the official release (has no signed Sigstore provenance bundle|provenance could not be verified)/);
  assert.match(output, FALLBACK);
});

test('an unreachable registry also names the fallback', async () => {
  const { result, output } = await captured(() => runUpdate({}, {
    currentVersion: () => '0.33.10',
    fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  }));
  assert.equal(result, 1);
  assert.match(output, FALLBACK);
});

test('a verified update succeeds without suggesting npm', async () => {
  const published = Buffer.from('published package');
  const { result, output } = await captured(() => runUpdate({}, {
    currentVersion: () => '0.37.5',
    fetch: async (url) => (url === PACKUMENT_URL ? jsonResponse(metadata('0.37.6', published))
      : url.includes('/attestations/') ? jsonResponse({}) : tarballResponse(published)),
    verifyProvenance: async () => {},
    install: async () => {},
  }));
  assert.equal(result, 0);
  assert.match(output, /Updated to 0\.37\.6/);
  assert.doesNotMatch(output, FALLBACK);
});

test('outdated warning: minor gap warns once a day; patch gap and current stay quiet', async () => {
  assert.equal(isMinorBehind('0.33.10', '0.37.6'), true);
  assert.equal(isMinorBehind('0.37.6', '1.0.0'), true);
  assert.equal(isMinorBehind('0.37.5', '0.37.6'), false);
  assert.equal(isMinorBehind('0.37.6', '0.37.6'), false);
  assert.equal(isMinorBehind('0.38.0', '0.37.6'), false);

  const dir = mkdtempSync(join(tmpdir(), 'sw-outdated-'));
  const cachePath = join(dir, 'update-check.json');
  const warnedPath = join(dir, 'outdated-warning.json');
  const now = 1_800_000_000_000;
  writeFileSync(cachePath, JSON.stringify({ checkedAt: now, latest: '0.37.6' }));
  const options = (at) => ({ cachePath, warnedPath, now: () => at, fetchLatest: async () => { throw new Error('cache is fresh'); } });

  const first = await getOutdatedWarning('0.33.10', options(now));
  assert.match(first, /somewhere CLI 0\.33\.10 is behind the latest release 0\.37\.6/);
  assert.match(first, /npm i -g @somewhere-tech\/cli@latest/);
  assert.doesNotMatch(first, /\n/);
  assert.equal(await getOutdatedWarning('0.33.10', options(now + 60_000)), null, 'once a day');
  assert.deepEqual(JSON.parse(readFileSync(warnedPath, 'utf8')), { warnedAt: now });

  writeFileSync(cachePath, JSON.stringify({ checkedAt: now + 86_400_001, latest: '0.37.6' }));
  assert.match(await getOutdatedWarning('0.33.10', options(now + 86_400_001)), /behind the latest/, 'again the next day');

  const quietDir = mkdtempSync(join(tmpdir(), 'sw-outdated-quiet-'));
  writeFileSync(join(quietDir, 'update-check.json'), JSON.stringify({ checkedAt: now, latest: '0.37.6' }));
  const quiet = { cachePath: join(quietDir, 'update-check.json'), warnedPath: join(quietDir, 'w.json'), now: () => now };
  assert.equal(await getOutdatedWarning('0.37.5', quiet), null, 'a patch gap stays quiet');
  assert.equal(await getOutdatedWarning('0.37.6', quiet), null);
});

test('non-interactive commands get only the outdated warning; update, CI and opt-out stay silent', async () => {
  const warning = async () => '! behind';
  const ci = process.env.CI;
  delete process.env.CI;
  try {
  assert.deepEqual(await collectNotices(['node', 'sw', 'deploy'], { isTTY: false, outdatedWarning: warning }), ['! behind']);
  assert.deepEqual(await collectNotices(['node', 'sw', 'deploy'], { isTTY: false, outdatedWarning: async () => null }), []);
  assert.deepEqual(await collectNotices(['node', 'sw', 'update'], { isTTY: false, outdatedWarning: warning }), []);
  const previous = process.env.SOMEWHERE_NO_NOTIFICATIONS;
  process.env.SOMEWHERE_NO_NOTIFICATIONS = '1';
  try {
    assert.deepEqual(await collectNotices(['node', 'sw', 'deploy'], { isTTY: false, outdatedWarning: warning }), []);
  } finally {
    if (previous === undefined) delete process.env.SOMEWHERE_NO_NOTIFICATIONS;
    else process.env.SOMEWHERE_NO_NOTIFICATIONS = previous;
  }
  process.env.CI = '1';
  assert.deepEqual(await collectNotices(['node', 'sw', 'deploy'], { isTTY: false, outdatedWarning: warning }), []);
  } finally {
    if (ci === undefined) delete process.env.CI;
    else process.env.CI = ci;
  }
});
