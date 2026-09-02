/**
 * An unresolvable import is a build error, not the end of the session.
 *
 * `somewhere dev` used to DIE on any import esbuild could not resolve — a
 * typo'd package, a not-yet-installed one, or our own `somewhere/db` — with a
 * `RangeError: Invalid array length` naming our bundled esbuild-wasm and
 * nothing about the developer's code. A plain syntax error, meanwhile, was
 * reported cleanly. That split is the whole tell (tsk_d63b3b6a).
 *
 * THE MECHANISM. esbuild-wasm is a child `node` process spoken to over a
 * length-prefixed stdio protocol, spawned by esbuild's own code with
 * `stdio: ['pipe', 'pipe', 'inherit']` — its stderr is OUR fd 2. The child's
 * entry shim monkey-patches `fs.writeSync` to route fd 2 through
 * `process.stderr.write`. When fd 2 is a plain FILE (`somewhere dev 2> log`,
 * any agent or CI harness capturing output, a session recorder) node backs
 * `process.stderr` with a SyncWriteStream whose `_write` calls `fs.writeSync` —
 * straight back into the stream it is servicing. The pending-write array grows
 * until `Array.push` throws, the child dies on an unhandled 'error' event, and
 * every later rebuild fails with "The service is no longer running".
 *
 * Which builds write to stderr is exactly which builds crashed: the core parses
 * sources with `logLevel: 'silent'`, so syntax errors never reach stderr, while
 * the bundle step's default log level prints "Could not resolve" there.
 *
 * So the integration fixture below runs the compiler in a child process whose
 * fd 2 IS A FILE — reproducing the crash condition rather than assuming it —
 * and asserts the process survives, the file stays empty, every failure is
 * located in the developer's source, and a later clean build still succeeds.
 *
 * Needs the CLI's build-toolchain cache, which `somewhere dev` populates on
 * first run; a cold machine installs the three pinned packages once.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  isServiceDeath,
  resolutionHint,
  silenceEsbuild,
  toCompileFailure,
} from '../dist/local/compiler.js';
import { readPlatformModules } from '../dist/local/compiler-core.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireVendored = createRequire(join(root, 'runtime', 'compiler', 'compile-core.cjs'));
const PLATFORM_MODULES = requireVendored('./typed-functions.cjs').PLATFORM_MODULES;

// ─── The advice attached to an unresolved import ────────────────────────────

test('the CLI reads the platform module list from the vendored compiler', () => {
  assert.deepEqual([...readPlatformModules()], [...PLATFORM_MODULES]);
  assert.ok(PLATFORM_MODULES.length > 0, 'the vendored compiler must enumerate its platform modules');
});

test('a missing npm package is told to install it', () => {
  const hint = resolutionHint('Could not resolve "totally-not-a-real-pkg"');
  assert.match(hint, /totally-not-a-real-pkg/);
  assert.match(hint, /package\.json/);
  assert.match(hint, /npm install/);
});

test('a subpath import names the ROOT package to install, not the subpath', () => {
  assert.match(resolutionHint('Could not resolve "date-fns/locale"'), /`date-fns`/);
  assert.match(resolutionHint('Could not resolve "@scope/pkg/deep/thing"'), /`@scope\/pkg`/);
});

test('every platform-provided specifier is never told to npm install', () => {
  // Both the listed entries and any future subpath of the namespace.
  for (const spec of [...PLATFORM_MODULES, 'somewhere/something-we-add-later']) {
    const hint = resolutionHint(`Could not resolve "${spec}"`);
    assert.ok(hint, `${spec} must carry a hint`);
    assert.match(hint, /provided by the platform/, spec);
    assert.doesNotMatch(hint, /npm install/, `${spec} must never advise an install`);
  }
});

test('a package that merely starts with the platform namespace still gets install advice', () => {
  assert.match(resolutionHint('Could not resolve "somewhereelse"'), /npm install/);
});

test('errors that are not resolution failures carry no hint', () => {
  assert.equal(resolutionHint('Expected ";" but found "}"'), undefined);
  assert.equal(resolutionHint('Unexpected end of file'), undefined);
});

test('an esbuild resolve error becomes a located failure with its hint', () => {
  const failure = toCompileFailure({
    errors: [{
      text: 'Could not resolve "totally-not-a-real-pkg"',
      location: { file: 'src/App.tsx', line: 3, column: 21 },
    }],
  });
  assert.equal(failure.locations.length, 1);
  const [loc] = failure.locations;
  assert.equal(loc.file, 'src/App.tsx');
  assert.equal(loc.line, 3);
  assert.equal(loc.column, 22); // esbuild columns are 0-based
  assert.match(loc.text, /totally-not-a-real-pkg/);
  assert.match(loc.hint, /npm install/);
});

// ─── The bridge itself ──────────────────────────────────────────────────────

test('the esbuild bridge is never allowed to write to its own stderr', () => {
  const calls = [];
  const fake = {
    version: '0.24.0',
    build: (o) => (calls.push(['build', o]), Promise.resolve('b')),
    context: (o) => (calls.push(['context', o]), Promise.resolve('c')),
    transform: (input, o) => (calls.push(['transform', o]), Promise.resolve('t')),
    somethingElse: 42,
  };
  const silent = silenceEsbuild(fake);
  assert.equal(silent.version, '0.24.0', 'unrelated properties survive');
  assert.equal(silent.somethingElse, 42);
  silent.build({ bundle: true });
  silent.context({ bundle: true, logLevel: 'warning' });
  silent.transform('x', { loader: 'ts' });
  silent.transform('x');
  assert.equal(calls.length, 4);
  for (const [name, options] of calls) {
    assert.equal(options.logLevel, 'silent', `${name} must be silenced`);
  }
  assert.equal(calls[1][1].bundle, true, 'the caller\'s own options are kept');
});

test('a dead service is recognised however esbuild phrases it', () => {
  assert.equal(isServiceDeath(new Error('The service was stopped')), true);
  assert.equal(isServiceDeath(new Error('The service is no longer running: EPIPE')), true);
  assert.equal(isServiceDeath(new Error('Could not resolve "x"')), false);
  assert.equal(isServiceDeath(undefined), false);
});

// ─── End to end, under the exact condition that used to crash ───────────────

/**
 * The probe compiles a series of projects through the SAME LocalCompiler the
 * dev loop uses, in order, in one process — so a service that died on case 1
 * shows up as a failure in every case after it.
 */
const PROBE = `
import { LocalCompiler } from '${join(root, 'dist', 'local', 'compiler.js').replace(/\\/g, '/')}';
import { readCompileCore } from '${join(root, 'dist', 'local', 'compiler-core.js').replace(/\\/g, '/')}';
import { collectFiles } from '${join(root, 'dist', 'lib', 'files.js').replace(/\\/g, '/')}';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const out = [];
for (const name of readdirSync(dir).sort()) {
  const cwd = join(dir, name);
  const sources = collectFiles(cwd);
  const pkg = JSON.parse(sources.files['package.json'] ?? '{}');
  const compiler = new LocalCompiler({ cwd });
  await compiler.prepare(pkg, readCompileCore('${root.replace(/\\/g, '/')}').detectTailwind(sources.files));
  try {
    const built = await compiler.compile(sources);
    out.push({ name, ok: true, warnings: built.warnings, entryChunk: built.entryChunk });
  } catch (err) {
    out.push({ name, ok: false, message: err.message, locations: err.locations ?? null });
  }
}
process.stdout.write('---PROBE---' + JSON.stringify(out));
`;

function project(dir, files) {
  for (const [path, body] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

const HTML = '<!doctype html><html><body><div id="root"></div>'
  + '<script type="module" src="/src/main.ts"></script></body></html>';
const PKG = JSON.stringify({ name: 'probe', private: true, dependencies: {} });

test('an unresolvable import is reported, not a crash — with stderr on a FILE', { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-dev-unresolvable-'));
  // The probe script and the captured stderr live OUTSIDE the tree it walks.
  const projects = join(dir, 'projects');
  try {
    // Ordered: every failing case runs BEFORE the clean one, so the clean one
    // proves the bridge is still alive after them.
    project(join(projects, '1-missing-package'), {
      'package.json': PKG,
      'index.html': HTML,
      'src/main.ts': "import { thing } from 'totally-not-a-real-pkg';\nexport default thing;\n",
    });
    project(join(projects, '2-platform-module-in-frontend'), {
      'package.json': PKG,
      'index.html': HTML,
      'src/main.ts': "import { schema } from 'somewhere/db';\nexport default schema;\n",
    });
    project(join(projects, '3-syntax-error'), {
      'package.json': PKG,
      'index.html': HTML,
      'src/main.ts': 'const x = ;\nexport default x;\n',
    });
    // `somewhere:api` is a real virtual module: the vendored compiler's own
    // resolver claims it, here exactly as in the container.
    project(join(projects, '4-platform-virtual-module'), {
      'package.json': PKG,
      'index.html': HTML,
      'src/main.ts': "import { api } from 'somewhere:api';\nexport default api;\n",
    });
    // `somewhere/db` in the file it belongs in: db/schema.ts is data the deploy
    // reads, never bundled — so it neither resolves nor warns, locally or on
    // deploy (tsk_53badecfb7).
    project(join(projects, '5-schema-file'), {
      'package.json': PKG,
      'index.html': HTML,
      'src/main.ts': "export default 'hello';\n",
      'db/schema.ts': "import { schema, table, id, text } from 'somewhere/db';\n"
        + 'export default schema({ links: table({ id: id(), title: text() }) });\n',
    });

    const stderrPath = join(dir, 'stderr.log');
    const stderrFd = openSync(stderrPath, 'w');
    const probePath = join(dir, 'probe.mjs');
    writeFileSync(probePath, PROBE);
    let result;
    try {
      result = spawnSync(process.execPath, [probePath, projects], {
        // fd 2 is a FILE. This is the crash condition, not an incidental detail:
        // with a TTY or a pipe here the old code passed.
        stdio: ['ignore', 'pipe', stderrFd],
        encoding: 'utf8',
        timeout: 280_000,
      });
    } finally {
      closeSync(stderrFd);
    }

    const stderr = readFileSync(stderrPath, 'utf8');
    assert.equal(
      result.status,
      0,
      `the compiler process must survive every case.\nstderr:\n${stderr}\nstdout:\n${result.stdout}`,
    );
    assert.equal(
      stderr.trim(),
      '',
      `nothing may reach the inherited stderr — that write is what killed the bridge:\n${stderr}`,
    );

    const marker = result.stdout.indexOf('---PROBE---');
    assert.ok(marker >= 0, `probe produced no result:\n${result.stdout}\n${stderr}`);
    const cases = Object.fromEntries(
      JSON.parse(result.stdout.slice(marker + '---PROBE---'.length)).map((c) => [c.name, c]),
    );

    // 1. A missing npm package: located, named, and told what to do.
    const missing = cases['1-missing-package'];
    assert.equal(missing.ok, false);
    assert.equal(missing.locations.length, 1);
    assert.equal(missing.locations[0].file, 'src/main.ts');
    assert.equal(missing.locations[0].line, 1);
    assert.ok(missing.locations[0].column > 0, 'a column, like a syntax error gets');
    assert.match(missing.locations[0].text, /totally-not-a-real-pkg/);
    assert.match(missing.locations[0].hint, /npm install/);

    // 2. A platform module in a frontend file: same clean report, opposite advice.
    const platform = cases['2-platform-module-in-frontend'];
    assert.equal(platform.ok, false);
    assert.equal(platform.locations[0].file, 'src/main.ts');
    assert.match(platform.locations[0].text, /somewhere\/db/);
    assert.match(platform.locations[0].hint, /provided by the platform/);
    assert.doesNotMatch(platform.locations[0].hint, /npm install/);

    // 3. The control: a syntax error was always clean, and still is.
    const syntax = cases['3-syntax-error'];
    assert.equal(syntax.ok, false);
    assert.equal(syntax.locations[0].file, 'src/main.ts');
    assert.ok(syntax.locations[0].line >= 1);

    // 4 & 5. The platform's own modules, each where the platform provides it.
    assert.equal(
      cases['4-platform-virtual-module'].ok,
      true,
      `somewhere:api must resolve under dev: ${cases['4-platform-virtual-module'].message}`,
    );
    const schemaCase = cases['5-schema-file'];
    assert.equal(schemaCase.ok, true, `the documented schema file must build: ${schemaCase.message}`);
    assert.deepEqual(
      schemaCase.warnings.filter((w) => /somewhere/.test(w)),
      [],
      'the platform module must never be reported as a missing dependency',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
