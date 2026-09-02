/**
 * The platform's compiler, running on your machine.
 *
 * `somewhere dev` does not build your app with a second toolchain that
 * resembles the platform's. It runs the SAME compiler the compile container
 * runs on deploy — `runtime/compiler/compile-core.cjs`, vendored verbatim out
 * of the monorepo with a drift guard (scripts/extract-runtime.mjs,
 * test/compiler-vendor.test.mjs) — so what renders on localhost is the deploy
 * artifact, not an approximation of it. The parity fixture
 * (test/compiler-parity.test.mjs) asserts that byte for byte.
 *
 * The compiler is host-parameterized: everything that differs between the
 * container and this machine goes in one `host` object. Concretely, three
 * things differ.
 *
 *   esbuild.  The container runs native esbuild; the CLI runs esbuild-wasm at
 *   the SAME pinned version. Not a preference — the published CLI's
 *   supply-chain rule is that every production dependency sits inside the
 *   signed artifact, and native esbuild ships 24 optional platform packages of
 *   which only the build machine's own can ever be installed. esbuild-wasm is
 *   one platform-independent package. Same version in, same bytes out; the
 *   parity fixture proves it every run.
 *
 *   Where the app's dependencies come from.  The container has a baked
 *   node_modules; you have YOUR node_modules, which is better — it is the
 *   exact tree you installed. When it is absent or does not satisfy a pin, the
 *   CLI resolves the way the container does, into a cache under
 *   ~/.somewhere/dev-deps, silently. See resolveAppDependencies below.
 *
 *   Where the BUILD toolchain comes from.  Never your project. The compiler
 *   treats typescript / postcss / autoprefixer / tailwind as its own
 *   machinery, not your app's (it deliberately refuses to install them from
 *   your package.json), so the CLI runs the container's EXACT pins from
 *   runtime/compiler/VENDOR.json into ~/.somewhere/dev-toolchain. Borrowing
 *   your tailwind 3.3 or typescript 5.2 would compile different CSS and
 *   resolve aliases differently — the precise local-vs-deploy divergence this
 *   whole loop exists to remove.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── The vendored compiler ──────────────────────────────────────────────────

/** One compiled project, in the shape the deploy pipeline produces. */
export interface CompileOutput {
  /** Content-hashed name of the entry chunk, e.g. `main-6UTUU73R.js`. */
  entryChunk: string;
  /** Every emitted chunk, keyed by name. Served under `/_compiled/<name>`. */
  chunks: Record<string, string>;
  /** The project's index.html with its entry script + CSS links rewritten. */
  html: string | null;
  /** Source path of the entry the HTML pointed at, e.g. `src/main.tsx`. */
  entry: string;
  warnings: string[];
  /** sha256 over the exact compile input — the deploy pipeline's source_digest. */
  sourceDigest: string;
  /** Per-artifact digests, for the parity fixture. */
  artifacts: Array<{ path: string; kind: string; bytes: number; sha256: string }>;
}

/** A compile that failed, located in the developer's own source. */
export class CompileFailure extends Error {
  constructor(
    message: string,
    readonly locations: Array<{ file: string; line?: number; column?: number; text: string }>,
  ) {
    super(message);
    this.name = 'CompileFailure';
  }
}

interface CompileCoreModule {
  createCompileCore: (host: unknown) => {
    compile: (body: Record<string, unknown>) => Promise<CompileResultShape>;
  };
}

interface CompileResultShape {
  ok: boolean;
  entry_chunk: string | null;
  chunks: Record<string, string>;
  warnings: string[];
  source_digest: string;
  artifact_manifest: { artifacts: Array<{ path: string; kind: string; bytes: number; sha256: string }> };
}

function packageRoot(): string {
  // dist/local/compiler.js → package root is two levels up.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export interface VendorManifest {
  commit: string;
  esbuild: string;
  toolchain: Record<string, Record<string, string>>;
  files: Record<string, string>;
}

export function readVendorManifest(root = packageRoot()): VendorManifest {
  return JSON.parse(readFileSync(join(root, 'runtime', 'compiler', 'VENDOR.json'), 'utf8')) as VendorManifest;
}

// ─── Dependency resolution, with zero steps for the developer ───────────────

function cacheHome(): string {
  return join(process.env.SOMEWHERE_DEV_CACHE ?? join(homedir(), '.somewhere'), '');
}

/**
 * Install `specs` into `dir` as a bare node_modules tree.
 *
 * `--ignore-scripts` is the same supply-chain guard the container uses, and it
 * matters MORE here: this runs on your machine, not in a throwaway container.
 * A dependency's postinstall never executes. esbuild bundles a package's files
 * without running them, so frontend dependencies do not need install scripts.
 */
async function installInto(dir: string, specs: string[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({ name: 'somewhere-dev-cache', private: true }, null, 2));
  }
  try {
    await execFileAsync(
      'npm',
      ['install', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund',
       '--no-package-lock', '--prefix', dir, ...specs],
      { cwd: dir, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, npm_config_ignore_scripts: 'true' } },
    );
  } catch (err) {
    const detail = err instanceof Error
      ? ((err as { stderr?: string }).stderr ?? err.message).toString().slice(-600)
      : String(err);
    throw new Error(`Could not resolve ${specs.join(', ')}: ${detail}`);
  }
}

/** True when `dir/node_modules/<name>` is a package esbuild would resolve. */
function installed(dir: string, name: string): boolean {
  return existsSync(join(dir, 'node_modules', name, 'package.json'));
}

/**
 * The build toolchain, at the container's exact pins, in the CLI's cache.
 *
 * One directory per group because tailwind v3 and v4 are the same package NAME
 * at incompatible majors — the container isolates them for that reason and so
 * does this. Groups are prepared only when the project needs them: a project
 * with no Tailwind never installs a Tailwind engine.
 *
 * Returns the group directories, already populated.
 */
async function prepareToolchain(
  manifest: VendorManifest,
  groups: string[],
  onFirstInstall?: (what: string) => void,
): Promise<Record<string, string>> {
  const dirs: Record<string, string> = {};
  for (const group of groups) {
    const pins = manifest.toolchain[group];
    if (!pins) throw new Error(`the vendored compiler declares no "${group}" toolchain group`);
    const dir = join(cacheHome(), 'dev-toolchain', `${group}-${digestOf(pins)}`);
    dirs[group] = dir;
    const missing = Object.entries(pins)
      .filter(([name]) => !installed(dir, name))
      .map(([name, range]) => `${name}@${range}`);
    if (!missing.length) continue;
    onFirstInstall?.(`build toolchain (${missing.map((s) => s.split('@')[0] || s).join(', ')})`);
    await installInto(dir, missing);
  }
  return dirs;
}

/**
 * Install React at the version the compile image bakes, not the floor of the
 * declared range (tsk_0312cf17).
 *
 * The image keeps React 19 in a tree of its own and prefers it over installing
 * the app's range; locally that set does not exist, so the compiler took its
 * other branch and floor-pinned instead — `react: ^19.2.0` became exactly
 * 19.2.0 while the image served 19.2.7. The same tree, compiled by the same
 * compiler, against two different Reacts.
 *
 * The fix is to rewrite the spec, NOT to add a second node_modules tree. That
 * was tried and is actively worse: a package that physically lives inside the
 * dependency cache resolves `react` to its own sibling before any search path
 * is consulted, so a separate pinned tree gets bundled ALONGSIDE the cache's
 * copy — two Reacts in one bundle, which renders a blank page. The image has no
 * such problem because it ends up with one flat tree, and this keeps one too.
 *
 * Pinning the spec also stops npm resolving React on its own as a peer of
 * something else (react-router-dom pulls one in), which is how a warm cache
 * ended up serving a third version again.
 */
export function applyImagePins(specs: string[], pins: Record<string, string>): string[] {
  if (!Object.keys(pins).length) return specs;
  return specs.map((spec) => {
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    return pins[name] ? `${name}@${pins[name]}` : spec;
  });
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

/**
 * Where the APP's own dependencies come from, in resolution order.
 *
 * 1. The project's own node_modules, when it exists. This is the whole reason
 *    a local loop can beat a cloud one: the tree is already on disk and it is
 *    the exact tree the developer installed.
 * 2. A CLI-managed cache keyed by the project's dependency map, for the case
 *    where node_modules is absent (a fresh `somewhere init`, a clone with no
 *    install) or a declared pin is not satisfied by what is installed.
 *
 * Keying the cache on the dependency map rather than sharing one flat tree
 * means two projects on incompatible majors of the same package never
 * overwrite each other, and two projects with identical dependencies share the
 * install for free.
 */
function resolveAppDependencies(
  cwd: string,
  pkg: { dependencies?: Record<string, string> },
  pins: Record<string, string>,
): string[] {
  const search: string[] = [];
  const projectModules = join(cwd, 'node_modules');
  if (existsSync(projectModules)) search.push(projectModules);

  const deps = pkg.dependencies ?? {};
  // The pins are part of the cache identity (tsk_0312cf17): when the image
  // bumps its React and the CLI re-vendors, the old cache is simply not reused,
  // so a warm cache can never keep serving the version we just moved off.
  const cacheDir = join(cacheHome(), 'dev-deps', digestOf([Object.entries(deps).sort(), pins]));
  // The core decides what is actually missing (its baked-satisfies rules run
  // against this exact search path) and calls host.installPackages for the
  // rest. All we do here is make the cache dir part of the search path.
  search.push(join(cacheDir, 'node_modules'));
  return search;
}

// ─── Entry detection — the same rule the deploy pipeline uses ───────────────
//
// The HTML's `<script type="module" src>` tags are the single source of truth
// for what the compiler is allowed to touch. Mirrors
// worker/src/utils/module-entry.ts; a divergence here would compile a
// different entry locally than on deploy, which is the one thing this loop
// must never do.

export function isCompilableEntry(path: string): boolean {
  return /\.(?:tsx?|jsx|mts|cts)$/i.test(path);
}

export function collectModuleEntryScripts(files: Record<string, string>): Set<string> {
  const entries = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    if (!path.toLowerCase().endsWith('.html')) continue;
    const tagRe = /<script\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(content)) !== null) {
      const tag = m[0];
      if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
      const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!srcMatch) continue;
      let src = srcMatch[1];
      if (src.startsWith('/')) src = src.slice(1);
      if (isCompilableEntry(src) && files[src] !== undefined) entries.add(src);
    }
  }
  return entries;
}

export function detectBundleEntry(files: Record<string, string>): string | null {
  const entries = collectModuleEntryScripts(files);
  const indexHtml = files['index.html'];
  if (typeof indexHtml === 'string') {
    const tagRe = /<script\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(indexHtml)) !== null) {
      const tag = m[0];
      if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
      const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!srcMatch) continue;
      let src = srcMatch[1];
      if (src.startsWith('/')) src = src.slice(1);
      if (entries.has(src)) return src;
    }
  }
  for (const e of entries) return e;
  return null;
}

/**
 * Point index.html at the compiled bundle instead of the raw entry, and add a
 * <link> for each CSS chunk esbuild split out. The deploy pipeline does exactly
 * this rewrite before serving (jsx-compile.ts) — the browser must receive the
 * same HTML locally or the page it renders is not the page deploy renders.
 */
export function rewriteIndexHtml(html: string, entry: string, entryChunk: string, chunkNames: string[]): string {
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reSourceEntry = new RegExp(`(<script\\b[^>]*\\bsrc\\s*=\\s*)(["'])/?${escaped}\\2`, 'i');
  const reCompiledEntry = /(<script\b[^>]*\bsrc\s*=\s*)(["'])\/_compiled\/[^"']+\.js\2/i;
  const newUrl = `/_compiled/${entryChunk}`;
  let next = html.replace(reSourceEntry, `$1$2${newUrl}$2`);
  if (next === html) next = html.replace(reCompiledEntry, `$1$2${newUrl}$2`);

  const cssChunks = chunkNames.filter((name) => name.endsWith('.css'));
  const reCompiledCssLink = /<link\b[^>]*\brel\s*=\s*(["'])stylesheet\1[^>]*\bhref\s*=\s*(["'])\/_compiled\/[^"']+\.css\2[^>]*>/gi;
  next = next.replace(reCompiledCssLink, '');
  if (cssChunks.length) {
    const linkTags = cssChunks.map((name) => `<link rel="stylesheet" href="/_compiled/${name}">`).join('\n');
    const headClose = /<\/head\s*>/i;
    const bodyOpen = /<body\b/i;
    if (headClose.test(next)) next = next.replace(headClose, `${linkTags}\n</head>`);
    else if (bodyOpen.test(next)) next = next.replace(bodyOpen, `${linkTags}\n<body`);
    else next = `${linkTags}\n${next}`;
  }
  return next;
}

// ─── The compiler, bound to one project ─────────────────────────────────────

export interface LocalCompilerOptions {
  cwd: string;
  /** Called once per cache miss, so a first run can say what it is preparing. */
  onPrepare?: (what: string) => void;
  /** `VITE_*` / `REACT_APP_*` values, the same map the deploy pipeline passes. */
  viteEnv?: Record<string, string>;
}

export interface ProjectSources {
  files: Record<string, string>;
  binaryFiles: Record<string, string>;
}

export class LocalCompiler {
  private core: { compile: (body: Record<string, unknown>) => Promise<CompileResultShape> } | null = null;
  private searchPath: string[] = [];
  private depCacheDir = '';

  constructor(private readonly opts: LocalCompilerOptions) {}

  /**
   * Resolve everything the compiler needs before the first build, so every
   * rebuild afterwards is pure compile time. Idempotent.
   */
  /**
   * The node_modules dirs the compiler resolves the app's dependencies from,
   * in order. The local FUNCTION runtime resolves against the same list, so a
   * function and a component import the same copy of a package (tsk_3269026d).
   * Empty until prepare() has run.
   */
  get moduleSearchPath(): string[] {
    return this.searchPath;
  }

  async prepare(pkg: { dependencies?: Record<string, string> }, tailwindVersion: number): Promise<void> {
    if (this.core) return;
    const root = packageRoot();
    const manifest = readVendorManifest(root);
    const requireVendored = createRequire(join(root, 'runtime', 'compiler', 'compile-core.cjs'));
    const requireCli = createRequire(join(root, 'package.json'));

    const groups = ['base', ...(tailwindVersion === 4 ? ['tw4'] : tailwindVersion === 3 ? ['tw3'] : [])];
    const toolchainDirs = await prepareToolchain(manifest, groups, this.opts.onPrepare);
    const react19Pins = manifest.toolchain.react19 ?? {};
    this.searchPath = resolveAppDependencies(this.opts.cwd, pkg, react19Pins);
    this.depCacheDir = resolve(this.searchPath[this.searchPath.length - 1], '..');

    const requireToolchain = (group: string) => createRequire(join(toolchainDirs[group], 'package.json'));
    const requireBase = requireToolchain('base');
    const requireTw3 = toolchainDirs.tw3 ? requireToolchain('tw3') : null;
    const requireTw4 = toolchainDirs.tw4 ? requireToolchain('tw4') : null;

    const { createCompileCore } = requireVendored('./compile-core.cjs') as CompileCoreModule;
    this.core = createCompileCore({
      // esbuild-wasm at the container's exact version. Loaded through the CLI's
      // own require so it comes from the CLI's bundled tree, never the project's.
      esbuild: requireCli('esbuild-wasm'),
      imageNodeModules: this.searchPath,
      // No isolated React-19 set locally: it exists in the image to skip a cold
      // install of react/react-dom, and here those either sit in the project's
      // node_modules already or land in the dependency cache once and stay.
      react19NodeModules: null,
      tw4TailwindDir: toolchainDirs.tw4 ? join(toolchainDirs.tw4, 'node_modules', 'tailwindcss') : null,
      requireImage: (spec: string) => {
        // tailwindcss means v3 here, exactly as it does in the image; the v4
        // engine is reached only through requireTw4.
        if (spec === 'tailwindcss' && requireTw3) return requireTw3(spec);
        // semver rides along in the CLI's own dependencies already.
        if (spec === 'semver') return requireCli(spec);
        return requireBase(spec);
      },
      requireTw4: requireTw4 ? (spec: string) => requireTw4(spec) : undefined,
      // The container refuses to install without its per-build scoped proxy
      // because it is egress-locked. This is the developer's own machine
      // running their own npm; the proxy does not exist here and its absence
      // is not a safety signal.
      requiresPackageProxy: false,
      installPackages: async ({ specs }: { specs: string[] }) => {
        const pinned = applyImagePins(specs, react19Pins);
        this.opts.onPrepare?.(`${pinned.length} ${pinned.length === 1 ? 'dependency' : 'dependencies'} (${pinned.join(', ')})`);
        await installInto(this.depCacheDir, pinned);
      },
      // The local loop is not a publication: no artifact upload capability, and
      // an identity that says plainly where this build came from.
      stamp: { source: `cli-vendored-${manifest.commit}`, toolchain: digestOf(manifest.files) },
    });
  }

  /** Compile the project. Throws CompileFailure for an error in the developer's source. */
  async compile(sources: ProjectSources): Promise<CompileOutput> {
    const { files, binaryFiles } = sources;
    const entry = detectBundleEntry(files);
    if (!entry) {
      throw new CompileFailure(
        'No app entry found. index.html needs a <script type="module" src="/src/main.tsx"> pointing at your app entry — that tag is what the platform compiles, locally and on deploy.',
        [],
      );
    }
    const transformEntries = [...collectModuleEntryScripts(files)].filter((path) => path !== entry);
    if (!this.core) throw new Error('LocalCompiler.prepare() must run before compile()');

    let result: CompileResultShape;
    try {
      result = await this.core.compile({
        project_id: 'somewhere-dev-local',
        build_id: 'somewhere-dev-local',
        entry,
        files,
        binary_files: binaryFiles,
        function_entries: [],
        transform_entries: transformEntries,
        package_json: files['package.json'],
        tsconfig: files['tsconfig.json'],
        vite_env: this.opts.viteEnv ?? {},
      });
    } catch (err) {
      throw toCompileFailure(err);
    }
    if (!result.entry_chunk) throw new CompileFailure('The compiler produced no entry chunk.', []);

    const html = typeof files['index.html'] === 'string'
      ? rewriteIndexHtml(files['index.html'], entry, result.entry_chunk, Object.keys(result.chunks))
      : null;

    return {
      entryChunk: result.entry_chunk,
      chunks: result.chunks,
      html,
      entry,
      warnings: result.warnings ?? [],
      sourceDigest: result.source_digest,
      artifacts: result.artifact_manifest.artifacts,
    };
  }
}

/**
 * Turn a compiler error into something with a file and a line.
 *
 * The compiler reports a syntax error as SOURCE_PARSE_ERROR with every bad
 * file joined into one message (`src/App.tsx: Expected ";" ...`). esbuild's own
 * errors carry a structured location. Both become a list of
 * {file, line, column, text} so the terminal and the browser overlay can point
 * at the exact line instead of printing a paragraph.
 */
export function toCompileFailure(err: unknown): CompileFailure {
  const locations: Array<{ file: string; line?: number; column?: number; text: string }> = [];
  // The compiler's own parse phase hands back {file, line, column, message}
  // per bad file (source_errors). Use it verbatim — it is the most precise
  // location available, and it is what a syntax error produces.
  const sourceErrors = (err as { source_errors?: Array<{ file: string; line?: number; column?: number; message: string }> })?.source_errors;
  if (Array.isArray(sourceErrors) && sourceErrors.length) {
    for (const e of sourceErrors) {
      locations.push({ file: e.file, line: e.line, column: e.column, text: e.message });
    }
    return new CompileFailure(sourceErrors[0].message, locations);
  }
  const esbuildErrors = (err as { errors?: Array<{ text: string; location?: { file: string; line: number; column: number } }> })?.errors;
  if (Array.isArray(esbuildErrors) && esbuildErrors.length) {
    for (const e of esbuildErrors) {
      locations.push({
        file: e.location?.file ?? '',
        line: e.location?.line,
        column: e.location ? e.location.column + 1 : undefined,
        text: e.text,
      });
    }
    return new CompileFailure(esbuildErrors[0].text, locations);
  }
  const message = err instanceof Error ? err.message : String(err);
  for (const part of message.split('; ')) {
    // `src/App.tsx:12:4: Expected ";" but found "}"` and the shorter
    // `src/App.tsx: Expected ...` the parse phase produces.
    const withPos = /^([^\s:]+\.[a-z]+):(\d+):(\d+):\s*(.+)$/i.exec(part);
    if (withPos) {
      locations.push({ file: withPos[1], line: Number(withPos[2]), column: Number(withPos[3]), text: withPos[4] });
      continue;
    }
    const fileOnly = /^([^\s:]+\.[a-z]+):\s*(.+)$/i.exec(part);
    if (fileOnly) locations.push({ file: fileOnly[1], text: fileOnly[2] });
  }
  return new CompileFailure(message, locations);
}
