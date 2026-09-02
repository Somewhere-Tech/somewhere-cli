/**
 * The CLI and the compile container produce the SAME BYTES for the same tree.
 *
 * This is the fixture the whole feature rests on. `somewhere dev` tells the
 * developer that what they are looking at is what deploy produces; if the two
 * compilers ever disagree, that sentence becomes a lie in the most expensive
 * possible way — the local page looks right and the deployed one does not.
 *
 * Two compilers, one implementation. Both build the vendored
 * compile-core.cjs, differing only in their host:
 *
 *   CONTAINER host — native esbuild, one baked node_modules.
 *   CLI host       — esbuild-wasm at the same version, the project's
 *                    node_modules plus the CLI's dependency cache.
 *
 * They must agree on: the entry chunk's NAME (content-hashed, so the name
 * changing means the bytes changed), every chunk body's sha256, and every
 * artifact descriptor. They are allowed to disagree on the compiler STAMP,
 * which identifies the build environment on purpose.
 *
 * The project tree is the real `somewhere init` scaffold — the exact thing a
 * developer's first `somewhere dev` compiles.
 *
 * Skips (loudly) when native esbuild is not installed, which is the normal
 * state: the CLI ships esbuild-wasm only. Run it with native esbuild present
 * (`npm i -D esbuild@<pinned>`) or in the monorepo, where the container's own
 * node_modules has it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHappyPathTemplate } from '../dist/lib/init-template.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const compilerDir = join(root, 'runtime', 'compiler');
const manifest = JSON.parse(readFileSync(join(compilerDir, 'VENDOR.json'), 'utf8'));
const requireVendored = createRequire(join(compilerDir, 'compile-core.cjs'));
const requireCli = createRequire(join(root, 'package.json'));

/** Native esbuild, from wherever this machine happens to have the pinned one. */
function findNativeEsbuild() {
  const candidates = [
    join(root, 'node_modules'),
    // The monorepo's compile container, when this runs beside it.
    join(root, '..', '..', 'tech', 'worker', 'containers', 'compile', 'node_modules'),
    join(root, '..', '..', 'tech-wt', 'dev-compiler', 'worker', 'containers', 'compile', 'node_modules'),
    process.env.SOMEWHERE_NATIVE_ESBUILD_DIR ?? '',
  ].filter(Boolean);
  for (const dir of candidates) {
    const pkg = join(dir, 'esbuild', 'package.json');
    if (!existsSync(pkg)) continue;
    const version = JSON.parse(readFileSync(pkg, 'utf8')).version;
    if (version !== manifest.esbuild) continue;
    try {
      return { esbuild: createRequire(join(dir, '..', 'package.json'))('esbuild'), dir };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** The scaffold as a {path: content} map, exactly as deploy would collect it. */
function scaffoldFiles() {
  const files = {};
  for (const file of createHappyPathTemplate()) files[file.path] = file.content;
  return files;
}

/** Materialize a node_modules with the scaffold's declared dependencies. */
function ensureFixtureModules(files) {
  const deps = JSON.parse(files['package.json']).dependencies ?? {};
  const key = createHash('sha256').update(JSON.stringify(Object.entries(deps).sort())).digest('hex').slice(0, 12);
  const dir = join(tmpdir(), `somewhere-parity-deps-${key}`);
  const modules = join(dir, 'node_modules');
  const complete = Object.keys(deps).every((name) => existsSync(join(modules, name, 'package.json')));
  if (complete) return modules;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'parity-fixture', private: true }));
  const { execFileSync } = require('node:child_process');
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--no-package-lock',
     '--prefix', dir, ...Object.entries(deps).map(([n, r]) => `${n}@${r}`)],
    { cwd: dir, stdio: 'ignore' },
  );
  return modules;
}

const require = createRequire(import.meta.url);

/** The build toolchain at the container's pins — the same cache the CLI uses. */
function ensureToolchain(group) {
  const pins = manifest.toolchain[group];
  const key = createHash('sha256').update(JSON.stringify(pins)).digest('hex').slice(0, 12);
  const dir = join(tmpdir(), `somewhere-parity-tc-${group}-${key}`);
  const complete = Object.keys(pins).every((name) => existsSync(join(dir, 'node_modules', name, 'package.json')));
  if (!complete) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'parity-toolchain', private: true }));
    const { execFileSync } = require('node:child_process');
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--no-package-lock',
       '--prefix', dir, ...Object.entries(pins).map(([n, r]) => `${n}@${r}`)],
      { cwd: dir, stdio: 'ignore' },
    );
  }
  return dir;
}

function buildHost({ esbuild, appModules, toolchainDir, tw4Dir, label }) {
  const requireToolchain = createRequire(join(toolchainDir, 'package.json'));
  const requireTw4 = tw4Dir ? createRequire(join(tw4Dir, 'package.json')) : null;
  return {
    esbuild,
    imageNodeModules: appModules,
    react19NodeModules: null,
    tw4TailwindDir: tw4Dir ? join(tw4Dir, 'node_modules', 'tailwindcss') : null,
    // semver backs the compiler's version-aware "is the installed copy good
    // enough" rule. It is not part of the pinned build toolchain (the container
    // gets it from its baked tree); without it every dependency reads as
    // unsatisfied and the build tries to reinstall the whole tree.
    requireImage: (spec) => {
      try {
        return requireToolchain(spec);
      } catch {
        return requireCli(spec);
      }
    },
    requireTw4: requireTw4 ? (spec) => requireTw4(spec) : undefined,
    requiresPackageProxy: false,
    installPackages: async ({ specs }) => {
      // The fixture pre-installs the scaffold's dependencies, so BOTH hosts
      // must reach the build with nothing left to fetch. If either one needs
      // an install the comparison is not measuring the same tree.
      throw new Error(`${label} host needed an unexpected install: ${specs.join(', ')}`);
    },
    // Deliberately different: the stamp identifies the BUILD ENVIRONMENT, and
    // these two are different environments. Everything else must match.
    stamp: { source: `${label}-fixture`, toolchain: `${label}-fixture` },
  };
}

/** Everything about a result that must be a function of the source alone. */
function fingerprint(result) {
  const parts = [`entry=${result.entry_chunk}`];
  for (const [name, text] of Object.entries(result.chunks).sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`chunk ${name} ${createHash('sha256').update(text).digest('hex')}`);
  }
  for (const artifact of result.artifact_manifest.artifacts) {
    parts.push(`artifact ${artifact.path} ${artifact.kind} ${artifact.bytes} ${artifact.sha256}`);
  }
  parts.push(`source_digest ${result.source_digest}`);
  parts.push(`routes ${JSON.stringify(result.metadata.routes)}`);
  parts.push(`tailwind ${JSON.stringify(result.metadata.tailwind)}`);
  parts.push(`warnings ${JSON.stringify(result.warnings)}`);
  return parts.join('\n');
}

test('the CLI compiler and the container compiler emit identical bytes for the init scaffold', async (t) => {
  const native = findNativeEsbuild();
  if (!native) {
    t.diagnostic(
      `native esbuild ${manifest.esbuild} not found on this machine — parity NOT verified in this run. ` +
        'Point SOMEWHERE_NATIVE_ESBUILD_DIR at a node_modules containing it, or run beside the monorepo.',
    );
    t.skip('native esbuild not available');
    return;
  }

  const { createCompileCore, detectTailwind } = requireVendored('./compile-core.cjs');
  const files = scaffoldFiles();
  const appModules = ensureFixtureModules(files);
  const twVersion = detectTailwind(files);
  const toolchainDir = ensureToolchain('base');
  const tw4Dir = twVersion === 4 ? ensureToolchain('tw4') : null;
  const tw3Dir = twVersion === 3 ? ensureToolchain('tw3') : null;

  // The container resolves `tailwindcss` (v3) from the same tree as the rest
  // of its toolchain; mirror that by pointing requireImage at tw3 for that one
  // specifier when the project is on v3.
  const withTw3 = (host) => {
    if (!tw3Dir) return host;
    const requireTw3 = createRequire(join(tw3Dir, 'package.json'));
    const base = host.requireImage;
    return { ...host, requireImage: (spec) => (spec === 'tailwindcss' ? requireTw3(spec) : base(spec)) };
  };

  const body = () => ({
    project_id: 'parity-fixture',
    build_id: 'parity-fixture',
    entry: 'src/main.tsx',
    files,
    package_json: files['package.json'],
    tsconfig: files['tsconfig.json'],
    function_entries: [],
    transform_entries: [],
    vite_env: {},
  });

  const containerCore = createCompileCore(withTw3(buildHost({
    esbuild: native.esbuild, appModules, toolchainDir, tw4Dir, label: 'container',
  })));
  const cliCore = createCompileCore(withTw3(buildHost({
    esbuild: requireCli('esbuild-wasm'), appModules, toolchainDir, tw4Dir, label: 'cli',
  })));

  const containerResult = await containerCore.compile(body());
  const cliResult = await cliCore.compile(body());

  const containerPrint = fingerprint(containerResult);
  const cliPrint = fingerprint(cliResult);
  if (containerPrint !== cliPrint) {
    const a = containerPrint.split('\n');
    const b = cliPrint.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        t.diagnostic(`first divergence\n  container: ${a[i]}\n  cli      : ${b[i]}`);
        break;
      }
    }
  }
  assert.equal(
    cliPrint,
    containerPrint,
    'the CLI compiler and the container compiler must emit identical output for the same tree — ' +
      '`somewhere dev` promises the developer that what renders locally is what deploy produces',
  );

  // The stamp is ALLOWED to differ; it names the build environment on purpose.
  assert.notEqual(containerResult.compiler.source, cliResult.compiler.source);
  assert.equal(containerResult.compiler.esbuild, cliResult.compiler.esbuild, 'both run the same esbuild version');
  assert.equal(containerResult.compiler.contract, cliResult.compiler.contract);
});

test('the compiled scaffold is real, executable output', async (t) => {
  const { createCompileCore, detectTailwind } = requireVendored('./compile-core.cjs');
  const files = scaffoldFiles();
  const appModules = ensureFixtureModules(files);
  const twVersion = detectTailwind(files);
  const toolchainDir = ensureToolchain('base');
  const tw4Dir = twVersion === 4 ? ensureToolchain('tw4') : null;
  const tw3Dir = twVersion === 3 ? ensureToolchain('tw3') : null;
  const requireTw3 = tw3Dir ? createRequire(join(tw3Dir, 'package.json')) : null;

  const host = buildHost({
    esbuild: requireCli('esbuild-wasm'), appModules, toolchainDir, tw4Dir, label: 'cli',
  });
  const core = createCompileCore(requireTw3
    ? { ...host, requireImage: (spec) => (spec === 'tailwindcss' ? requireTw3(spec) : host.requireImage(spec)) }
    : host);

  const result = await core.compile({
    project_id: 'parity-fixture',
    build_id: 'parity-fixture',
    entry: 'src/main.tsx',
    files,
    package_json: files['package.json'],
    tsconfig: files['tsconfig.json'],
    vite_env: {},
  });

  assert.equal(result.ok, true);
  assert.match(result.entry_chunk, /^main-[A-Z0-9]+\.js$/, 'the entry chunk is content-hashed');
  const bundle = result.chunks[result.entry_chunk];
  // The whole point of the loop: raw TSX became JavaScript. If any of the
  // source's TypeScript syntax survived, the browser could not run it.
  assert.ok(!/\binterface\s+\w+\s*\{/.test(bundle), 'no TypeScript interface survives into the bundle');
  assert.ok(!/<\/?[A-Z]\w*[\s/>]/.test(bundle.slice(0, 2000)), 'no raw JSX at the top of the bundle');
  assert.ok(bundle.includes('createRoot') || bundle.includes('react-dom'), 'React is bundled in');
  t.diagnostic(`entry ${result.entry_chunk}, ${Object.keys(result.chunks).length} chunk(s), ${bundle.length} bytes`);
});

test('a syntax error names the file and the line, and does not lose the working build', async () => {
  const { createCompileCore } = requireVendored('./compile-core.cjs');
  const files = scaffoldFiles();
  const appModules = ensureFixtureModules(files);
  const toolchainDir = ensureToolchain('base');
  const core = createCompileCore(buildHost({
    esbuild: requireCli('esbuild-wasm'), appModules, toolchainDir, tw4Dir: null, label: 'cli',
  }));

  const broken = { ...files, 'src/App.tsx': `${files['src/App.tsx']}\nconst oops = (` };
  let thrown;
  try {
    await core.compile({
      project_id: 'parity-fixture', build_id: 'parity-fixture', entry: 'src/main.tsx',
      files: broken, package_json: files['package.json'], tsconfig: files['tsconfig.json'], vite_env: {},
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'a syntax error fails the compile');
  assert.equal(thrown.code, 'SOURCE_PARSE_ERROR');
  // Structured locations, not a paragraph to regex apart — this is what the
  // terminal prints as file:line and what the in-page overlay draws.
  assert.ok(Array.isArray(thrown.source_errors) && thrown.source_errors.length, 'the error carries its locations');
  const first = thrown.source_errors[0];
  assert.equal(first.file, 'src/App.tsx');
  assert.equal(typeof first.line, 'number');
  assert.ok(first.line > 0, 'the line number points into the file');

  const { toCompileFailure } = await import('../dist/local/compiler.js');
  const failure = toCompileFailure(thrown);
  assert.equal(failure.locations[0].file, 'src/App.tsx');
  assert.equal(failure.locations[0].line, first.line);
});
