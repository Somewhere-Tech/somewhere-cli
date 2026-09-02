import { extname } from 'node:path';

/**
 * Root-level publish surface (tsk_c166924f).
 *
 * A deploy publishes the APP, not the folder the app was built in. Coding
 * agents keep their working notes next to the code — NOTES.md, TODO.md,
 * transcripts, *.log, *.jsonl, design docs — and a blind test run shipped a
 * tester's private NOTES.md to the live site (GET /NOTES.md -> 200, whole
 * evaluation log, including the account address).
 *
 * The rule is scoped to the PROJECT ROOT only, and is "not referenced and not
 * app surface":
 *
 *   publish a root file when it is
 *     1. a known app-surface name (index.html, robots.txt, vite.config.ts, …), or
 *     2. a known app-surface extension (.html/.css/.tsx/images/fonts/…), or
 *     3. REFERENCED — its filename appears anywhere in the published source
 *        (so `fetch('/data.json')`, a <link> href, an import specifier all
 *        keep working), or
 *     4. explicitly opted in (`--include`, or a `!<name>` line in
 *        .somewhereignore / .gitignore).
 *   otherwise exclude it and NAME it in the output.
 *
 * Everything BELOW the root keeps today's behavior byte for byte: src/,
 * public/, api/, functions/, db/, assets/, and any directory an app invented
 * are untouched by this rule. That is deliberate — an allowlist of directories
 * would silently drop `images/`, `fonts/`, `vendor/` and every other folder an
 * app made up, which is exactly the class of breakage rule 9 forbids. The root
 * is where agent scratch actually lands, and the reference check is the escape
 * hatch for anything at the root we did not think of.
 */

/** Exact root filenames that are app surface even when nothing references them. */
const APP_ROOT_FILES = new Set([
  // The app itself / platform inputs
  'index.html', '404.html', '200.html', 'package.json', 'package-lock.json',
  'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  // Compile inputs the platform's compiler reads
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'jsconfig.json',
  'components.json', 'import-map.json', 'importmap.json', 'deno.json', 'deno.jsonc',
  // Conventional static roots served at the top level
  'robots.txt', 'humans.txt', 'ads.txt', 'app-ads.txt', 'security.txt',
  'sitemap.xml', 'sitemap-index.xml', 'rss.xml', 'atom.xml', 'feed.xml',
  'browserconfig.xml', 'favicon.ico', 'manifest.json', 'manifest.webmanifest',
  'site.webmanifest', '_redirects', '_headers',
]);

/** Root filename patterns that are app surface (config files, mostly). */
const APP_ROOT_PATTERNS: readonly RegExp[] = [
  /^tsconfig\..+\.json$/i,
  /^(vite|rollup|webpack|esbuild|astro|svelte|nuxt|remix|rsbuild|rspack|parcel)\.config\.[cm]?[jt]s$/i,
  /^(tailwind|postcss|uno|windi|panda)\.config\.[cm]?[jt]s$/i,
  /^(babel|eslint|prettier|vitest|jest|playwright)\.config\.[cm]?[jt]s$/i,
];

/**
 * Extensions that are app surface at the root. Deliberately excludes the
 * note/record shapes an agent produces: .md, .log, .jsonl, .csv, .yaml, .txt
 * (robots/humans/ads/security are named above), and extensionless files
 * (LICENSE, Dockerfile, Procfile, Makefile).
 */
const APP_ROOT_EXTS = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.svg', '.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.m4a',
  '.pdf', '.wasm', '.webmanifest', '.map', '.sql',
]);

/** Text file kinds worth scanning for a reference to a root filename. */
const REFERENCE_CORPUS_EXTS = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.svg', '.xml', '.webmanifest',
]);

export function isReferenceCorpusPath(relPath: string): boolean {
  return REFERENCE_CORPUS_EXTS.has(extname(relPath).toLowerCase());
}

/** True when `name` is app surface at the project root on shape alone. */
export function isAppSurfaceRootFile(name: string): boolean {
  if (APP_ROOT_FILES.has(name)) return true;
  if (APP_ROOT_PATTERNS.some((re) => re.test(name))) return true;
  const ext = extname(name).toLowerCase();
  if (!ext) return false;
  return APP_ROOT_EXTS.has(ext);
}

/**
 * The customer-facing reason a root file was held back. Rule 8: say what was
 * excluded and how to publish it on purpose — no internals, no ticket ids.
 */
export function excludedRootFileReason(name: string): string {
  return `not part of the app (nothing references ${name}) — publish it with \`somewhere deploy --include ${name}\``;
}
