import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countFromResponse,
  countPublishSurface,
  formatPublishSurface,
} from '../dist/lib/surface-counts.js';
import { formatDeploySuccess } from '../dist/commands/deploy.js';

// Parity finding #12 — one project, one number. `somewhere deploy`,
// `somewhere preview` and `somewhere promote` used to describe the same tree
// three different ways, one of them hiding the functions inside a boolean.

test('the shape is `N static files + M functions`, singular where it should be', () => {
  assert.equal(formatPublishSurface({ staticFiles: 3, functions: 1 }), '3 static files + 1 function');
  assert.equal(formatPublishSurface({ staticFiles: 1, functions: 2 }), '1 static file + 2 functions');
  // The old spellings must not be reachable.
  for (const counts of [
    { staticFiles: 3, functions: 1 },
    { staticFiles: 1, functions: 1 },
    { staticFiles: 0, functions: 0 },
  ]) {
    assert.doesNotMatch(formatPublishSurface(counts), /file\(s\)|function\(s\)/);
  }
});

test('a static site does not announce its missing backend on every line', () => {
  assert.equal(formatPublishSurface({ staticFiles: 3, functions: 0 }), '3 static files');
  // …but a functions-only report with nothing else to say still says it.
  assert.equal(formatPublishSurface({ staticFiles: null, functions: 0 }), '0 functions');
  assert.equal(formatPublishSurface({ staticFiles: null, functions: 2 }), '2 functions');
});

test('an unknown count renders as an absence, never as a zero it did not measure', () => {
  assert.equal(formatPublishSurface({ staticFiles: null, functions: null }), 'Files');
  assert.equal(formatPublishSurface({ staticFiles: 4, functions: null }), '4 static files');
  // A platform that can only answer yes/no gets the word, not an invented count.
  assert.equal(formatPublishSurface({ staticFiles: 4, functions: 'some' }), '4 static files + functions');
});

test('binary assets are static files — an image is part of the site', () => {
  assert.deepEqual(
    countPublishSurface({
      files: { 'index.html': '', 'src/main.js': '', 'package.json': '' },
      binaryFiles: { 'logo.png': '' },
      functions: { 'api/ping.ts': '' },
    }),
    { staticFiles: 4, functions: 1 },
  );
});

test('countFromResponse tells "not sent" apart from "zero"', () => {
  assert.equal(countFromResponse(3), 3);
  assert.equal(countFromResponse(0), 0);
  assert.equal(countFromResponse(['a', 'b']), 2);
  assert.equal(countFromResponse(undefined), null);
  assert.equal(countFromResponse(null), null);
  assert.equal(countFromResponse('3'), null);
  assert.equal(countFromResponse(Number.NaN), null);
});

// ── The finding itself: one file set, three commands, one sentence ──────────

test('deploy, preview and promote describe the same project identically', () => {
  // The tree the CLI collected: 3 static files + 1 function.
  const collected = {
    files: { 'index.html': 'x', 'src/main.js': 'x', 'package.json': '{}' },
    binaryFiles: {},
    functions: { 'api/ping.ts': 'x' },
  };
  const counts = countPublishSurface(collected);
  const expected = '3 static files + 1 function';

  // deploy — the headline is built by the real formatter.
  const deployed = formatDeploySuccess(
    { files_deployed: 2, has_functions: true, project_id: 'proj_x' },
    { functionCount: counts.functions, staticFileCount: counts.staticFiles, totalBytes: 383 },
  );
  assert.equal(deployed.headline, `${expected} deployed (383 B)`);
  // Deploy must prefer what it actually uploaded over the platform's own tally:
  // the response said 2 for a tree the project then listed as 3.
  assert.equal(deployed.staticFileCount, 3);

  // preview — the sync line.
  assert.equal(`Synced ${formatPublishSurface(counts)} to preview`, `Synced ${expected} to preview`);

  // promote — the platform sends its own counts back.
  assert.equal(
    formatPublishSurface({
      staticFiles: countFromResponse(3),
      functions: countFromResponse(1) ?? (true ? 'some' : 0),
    }),
    expected,
  );
});

test('promote still names the functions when the platform only sends a boolean', () => {
  const older = { files_promoted: 3, has_functions: true };
  assert.equal(
    formatPublishSurface({
      staticFiles: countFromResponse(older.files_promoted),
      functions: countFromResponse(undefined) ?? (older.has_functions ? 'some' : 0),
    }),
    '3 static files + functions',
  );
  const noBackend = { files_promoted: 3, has_functions: false };
  assert.equal(
    formatPublishSurface({
      staticFiles: countFromResponse(noBackend.files_promoted),
      functions: countFromResponse(undefined) ?? (noBackend.has_functions ? 'some' : 0),
    }),
    '3 static files',
  );
});

test('deploy still reports honestly when it has no local tree to count', () => {
  const formatted = formatDeploySuccess({ has_functions: false }, { functionCount: 0, totalBytes: 1024 });
  assert.equal(formatted.staticFileCount, null);
  assert.equal(formatted.headline, 'Static files deployed (1 KB)');
  assert.doesNotMatch(JSON.stringify(formatted), /undefined/);
});
