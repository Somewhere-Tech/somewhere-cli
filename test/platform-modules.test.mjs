/**
 * The CLI never calls the platform's own modules a missing npm package.
 *
 * `somewhere dev --check` / `somewhere deploy` run the vendored compiler, and
 * its phantom-import scanner asks one question of every bare import: can this
 * be resolved? `somewhere/db` — the managed-schema helper surface our own
 * documentation tells a developer to import in db/schema.ts — can never answer
 * yes. That file is data the deploy reads, never executed and never bundled,
 * so nothing resolves the specifier.
 *
 * The result was that the very first file a managed-schema user writes came
 * back with "`somewhere` is imported in db/schema.ts but is not in your
 * package.json ... your app will fail to load it", advising an `npm install`
 * that fetches an unrelated package. A blind tester called it "genuinely
 * alarming" and could not rule it out until a clean server-side deploy check.
 *
 * This asserts the behavior at the CLI's own copy of the compiler, not just in
 * the monorepo: the docs' schema file is silent, and a genuinely missing
 * package in the same file still warns and still names the file.
 *
 * tsk_53badecfb7154ce1917293c0be0d3302
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const compilerDir = join(root, 'runtime', 'compiler');
const requireVendored = createRequire(join(compilerDir, 'compile-core.cjs'));
const requireCli = createRequire(join(root, 'package.json'));

const { createCompileCore } = requireVendored('./compile-core.cjs');
const typedFunctions = requireVendored('./typed-functions.cjs');

/**
 * The scanner only needs a resolution search path and a place to look; it never
 * installs, bundles, or touches the toolchain. esbuild-wasm is passed so the
 * core does not reach for native esbuild, which the CLI deliberately does not
 * ship.
 */
function scanner() {
  return createCompileCore({
    imageNodeModules: [join(root, 'node_modules')],
    react19NodeModules: null,
    tw4TailwindDir: null,
    esbuild: requireCli('esbuild-wasm'),
    requireImage: (spec) => requireCli(spec),
    requireTw4: (spec) => requireCli(spec),
    installPackages: async () => {},
    requiresPackageProxy: false,
    stamp: { source: 'test', toolchain: 'test' },
  });
}

/** The managed-schema example exactly as `docs sw.db` hands it over. */
const DOCS_SCHEMA = [
  "import { schema, table, id, text, timestamp, owner } from 'somewhere/db';",
  '',
  'export default schema({',
  '  links: table({',
  '    id: id(),',
  '    title: text(),',
  '    url: text(),',
  "    created_at: timestamp({ default: 'now' }),",
  '  }, {',
  '    scope: owner(),',
  '  }),',
  '});',
].join('\n');

test('the documented `somewhere/db` schema file raises no dependency warning', () => {
  const core = scanner();
  const dir = mkdtempSync(join(tmpdir(), 'sw-platform-modules-'));
  try {
    const found = core.detectPhantomImports({ 'db/schema.ts': DOCS_SCHEMA }, dir);
    assert.equal(
      found.size,
      0,
      `the docs' own schema file must not warn (got: ${JSON.stringify([...found.keys()])})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every platform-provided specifier is treated as provided', () => {
  const core = scanner();
  const dir = mkdtempSync(join(tmpdir(), 'sw-platform-modules-'));
  try {
    const source = typedFunctions.PLATFORM_MODULES
      .map((spec, i) => `import m${i} from '${spec}';`)
      .concat('export default 1;')
      .join('\n');
    const found = core.detectPhantomImports({ 'src/uses-platform.ts': source }, dir);
    assert.equal(found.size, 0, JSON.stringify([...found.keys()]));
    // Present and future subpaths of the namespace, not just the ones listed.
    const later = core.detectPhantomImports(
      { 'src/later.ts': "import x from 'somewhere/something-we-add-later';\nexport default x;" },
      dir,
    );
    assert.equal(later.size, 0, JSON.stringify([...later.keys()]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely missing package still warns, and names the file importing it', () => {
  const core = scanner();
  const dir = mkdtempSync(join(tmpdir(), 'sw-platform-modules-'));
  try {
    const found = core.detectPhantomImports(
      {
        'db/schema.ts': `${DOCS_SCHEMA}\nimport { helper } from 'no-such-package-swcli';\n`,
        'src/App.tsx': "import { other } from 'no-such-package-swcli';\nexport default other;",
      },
      dir,
    );
    assert.equal(found.has('somewhere'), false, 'the platform import stays silent');
    assert.deepEqual(
      (found.get('no-such-package-swcli') ?? []).sort(),
      ['db/schema.ts', 'src/App.tsx'],
      'the finding names every file that imports the missing package',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package whose name merely starts with the platform namespace is still checked', () => {
  const core = scanner();
  const dir = mkdtempSync(join(tmpdir(), 'sw-platform-modules-'));
  try {
    const found = core.detectPhantomImports(
      { 'src/App.tsx': "import x from 'somewhereelse-swcli';\nexport default x;" },
      dir,
    );
    assert.ok(found.has('somewhereelse-swcli'), JSON.stringify([...found.keys()]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
