/**
 * The vendored FUNCTION RUNTIME is the platform's runtime, unmodified.
 *
 * `runtime/platform-context.mjs` and `runtime/sw-init.mjs` are the exact `sw.*`
 * bindings deployed functions run against, and the local dev loop executes a
 * customer's `api/` functions against them — against their REAL project. A copy
 * that has quietly diverged from the platform is therefore the worst kind of
 * bug: the loop keeps working, and binds differently from production.
 *
 * That is not hypothetical. The compiler blobs have been hash-guarded since
 * they were vendored; these two were not, and they drifted ~7,200 lines behind
 * the monorepo without one red build (tsk_0100d8e5). This closes that gap, and
 * the last test closes the CLASS rather than the instance: any file added under
 * runtime/ must be covered by a manifest, so the next vendored blob cannot
 * arrive unguarded the way these did.
 *
 * Honest scope: this catches a hand-edit and names the commit to re-vendor
 * from. It cannot tell you the monorepo has moved on — CI has no monorepo to
 * compare against, so re-vendoring stays a deliberate act.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeDir = join(root, 'runtime');
const compilerDir = join(runtimeDir, 'compiler');
const runtimeManifest = JSON.parse(readFileSync(join(runtimeDir, 'VENDOR.json'), 'utf8'));
const compilerManifest = JSON.parse(readFileSync(join(compilerDir, 'VENDOR.json'), 'utf8'));

test('every vendored runtime file matches the hash the vendor step recorded', () => {
  assert.deepEqual(
    Object.keys(runtimeManifest.files).sort(),
    ['platform-context.mjs', 'sw-init.mjs'],
    'the manifest lists both runtime blobs',
  );
  for (const [name, expected] of Object.entries(runtimeManifest.files)) {
    const path = join(runtimeDir, name);
    assert.ok(existsSync(path), `${name} is present in runtime/`);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(
      actual,
      expected,
      `runtime/${name} was modified after vendoring from monorepo commit ${runtimeManifest.commit}. `
        + 'The local dev loop must run the platform\'s runtime unchanged — re-sync with '
        + '`node scripts/extract-runtime.mjs <monorepo>` instead of editing it.',
    );
  }
});

test('the runtime manifest names the monorepo commit to re-vendor from', () => {
  assert.equal(typeof runtimeManifest.commit, 'string');
  assert.match(
    runtimeManifest.commit,
    /^[0-9a-f]{7,40}$/,
    'a real commit, so a failing hash tells you exactly what to re-vendor against',
  );
});

test('the vendored runtime can carry an execution slot and a draft identity', () => {
  // The two things the local loop cannot work without. `extract-runtime.mjs`
  // refuses to vendor a runtime missing them; this asserts the SHIPPED copy
  // still has them, which is the half a vendor-time guard cannot cover.
  const context = readFileSync(join(runtimeDir, 'platform-context.mjs'), 'utf8');
  for (const marker of [
    "'X-Sw-Env-Slot': projectEnv",
    "request.headers.get('X-Sw-Draft-Id')",
    "'X-Sw-Draft-Id': draftId",
    "'X-Sw-Draft-Candidate': draftCandidateReleaseId",
  ]) {
    assert.ok(
      context.includes(marker),
      `the vendored runtime no longer stamps ${marker}; local sw.* would bind the wrong workspace`,
    );
  }
});

test('no file ships in runtime/ without a manifest covering it', () => {
  // The guard that closes the class. runtime/ is published to npm in its
  // entirety (package.json "files"), so anything sitting here is code customers
  // execute. The compiler blobs were guarded and the runtime blobs were not;
  // the only durable fix is that being unguarded is itself a failing test.
  const covered = new Set([
    ...Object.keys(runtimeManifest.files),
    'VENDOR.json',
    ...Object.keys(compilerManifest.files).map((f) => join('compiler', f)),
    join('compiler', 'VENDOR.json'),
  ]);

  const shipped = [];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else shipped.push(rel);
    }
  };
  walk(runtimeDir);

  const unguarded = shipped.filter((f) => !covered.has(f));
  assert.deepEqual(
    unguarded,
    [],
    `these vendored files ship to customers with no hash guard: ${unguarded.join(', ')}. `
      + 'Record them in a VENDOR.json from scripts/extract-runtime.mjs — an unguarded blob is how '
      + 'the runtime drifted 7,200 lines behind the platform unnoticed.',
  );
});

test('the compile image\'s isolated React 19 pins are recorded for the local loop', () => {
  // Without these the local loop floor-pins the app's declared range while the
  // image serves its own baked set — the same tree compiled against two
  // different Reacts (tsk_0312cf17).
  const pins = compilerManifest.toolchain.react19;
  assert.ok(pins, 'the compiler manifest records the image\'s React 19 set');
  for (const name of ['react', 'react-dom']) {
    assert.match(
      pins[name] ?? '',
      /^\d+\.\d+\.\d+$/,
      `${name} is pinned to an exact version, not a range — the image installs from a lockfile`,
    );
  }
  assert.equal(pins.react, pins['react-dom'], 'react and react-dom come from one lockfile resolution');
});
