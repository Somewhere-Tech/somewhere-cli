/**
 * compile-core — the somewhere.tech compiler, as a host-parameterized module.
 *
 * This file IS the compiler: source validation, the esbuild project/function/
 * transform builds, the svg + url-asset plugins, Tailwind v3/v4 via real
 * PostCSS, import.meta.env VITE_* / process.env.REACT_APP_* defines, tsconfig
 * path aliases, dependency resolution semantics, phantom-import detection,
 * dependency review, and the artifact manifest. It was extracted verbatim from
 * containers/compile/server.js so that BOTH callers run one implementation:
 *
 *   - the compile container (server.js) — deploy, over HTTP;
 *   - the CLI's `somewhere dev` local loop — which vendors this file.
 *
 * server.js keeps only what is genuinely the container's: the HTTP server, the
 * build queue, the BUILD_TIMEOUT controller, direct-to-storage artifact upload,
 * and the baked-image identity (which node_modules trees exist, how an install
 * runs, what the compiler stamp is).
 *
 * ── The boundary ──────────────────────────────────────────────────────────
 * Everything at module scope below is PURE: it depends only on its arguments,
 * node builtins, and esbuild. Everything inside createCompileCore(host) is
 * ENVIRONMENT-BOUND: it needs to know where the baked dependency trees live,
 * how to require the toolchain (typescript / postcss / autoprefixer /
 * tailwindcss / semver), how to install a missing dependency, and what stamp
 * identifies this compiler build. That is the entire difference between the
 * container and the CLI, and `host` is the entire list of it.
 *
 * host = {
 *   imageNodeModules,     // string | string[] — the dependency search path, in
 *                         //   order, behind the build root; esbuild nodePaths
 *   react19NodeModules,   // string|null — isolated React 19 set, or null
 *   tw4TailwindDir,       // string|null — dir to link as node_modules/tailwindcss for v4
 *   esbuild,              // optional — the esbuild module to compile with.
 *                         //   Defaults to require('esbuild'). The CLI passes
 *                         //   esbuild-wasm: same version, byte-identical
 *                         //   output, and ONE package instead of 24
 *                         //   platform-native ones, which is what lets the
 *                         //   published CLI keep every production dependency
 *                         //   inside its signed artifact.
 *   requireImage(spec),   // (spec) => module, resolved from the toolchain tree
 *   requireTw4(spec),     // (spec) => module, resolved from the v4 engine tree
 *   installPackages({ root, specs, ctx }),  // => Promise<void>; throws on failure
 *   requiresPackageProxy, // default TRUE. The compile container is egress-
 *                         //   locked and can only reach the registry through a
 *                         //   per-build scoped proxy, so with no proxy in the
 *                         //   request it must refuse rather than build with
 *                         //   unresolved pins. A host that reaches npm
 *                         //   directly (the CLI, on the developer's own
 *                         //   machine, through their own npm config) sets
 *                         //   false. Defaulting to true keeps that refusal
 *                         //   something a host must deliberately opt out of.
 *   uploadArtifacts,      // optional (artifactUpload, chunks) => Promise<manifest[]>
 *   stamp: { source, toolchain },           // compiler identity for this build
 * }
 *
 * createCompileCore(host) => { compile, compileProject, compileTransforms,
 *   parseSources, ... } — the same function signatures server.js exported
 * before the extraction, so its consumers and contract tests are unchanged.
 */
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const graphContract = require('./graph-contract.cjs');
const typedFunctions = require('./typed-functions.cjs');
const {
  GRAPH_MAX_EDGES,
  GRAPH_MAX_BYTES,
  importGraphFromMetafile,
  graphFromMetafile,
} = graphContract;

const COMPILER_CONTRACT = 'somewhere-compiler-v2';

/* ══════════════════════════════════════════════════════════════════════════
 * PURE — no knowledge of where anything is installed.
 * ══════════════════════════════════════════════════════════════════════════ */

const MAX_TOTAL_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_COUNT = 1500;
const MAX_BINARY_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_COUNT = 3000;

// Node-builtin → browser-polyfill aliases (pre-baked in the image). esbuild for
// the browser doesn't polyfill Node builtins, so a dep that `import`s `buffer`
// (pdf-lib, docx, xlsx, …) otherwise hard-errors "Could not resolve buffer".
// Both bare + `node:`-prefixed forms are mapped here.
const NODE_POLYFILLS = {
  buffer: 'buffer', 'node:buffer': 'buffer',
  process: 'process/browser', 'node:process': 'process/browser',
  stream: 'stream-browserify', 'node:stream': 'stream-browserify',
  util: 'util', 'node:util': 'util',
  events: 'events', 'node:events': 'events',
  path: 'path-browserify', 'node:path': 'path-browserify',
  crypto: 'crypto-browserify', 'node:crypto': 'crypto-browserify',
};

// .svg is handled by svgPlugin (dual binding + ?react component), NOT a flat
// data-URL loader — so `import { ReactComponent }` / `?react` work like svgr.
const ASSET_LOADERS = {
  '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.gif': 'dataurl',
  '.webp': 'dataurl', '.avif': 'dataurl', '.ico': 'dataurl', '.bmp': 'dataurl',
  '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl',
  '.otf': 'dataurl', '.eot': 'dataurl', '.mp3': 'dataurl', '.mp4': 'dataurl',
  '.webm': 'dataurl', '.wav': 'dataurl', '.ogg': 'dataurl', '.pdf': 'dataurl',
};

function stableMapEntries(value) {
  return Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b));
}

function sourceDigest(body) {
  const canonical = {
    entry: typeof body.entry === 'string' ? body.entry : null,
    function_entries: [...(body.function_entries || [])].sort(),
    function_paths: [...(body.function_paths || [])].sort(),
    transform_entries: [...(body.transform_entries || [])].sort(),
    files: stableMapEntries(body.files),
    package_json: typeof body.package_json === 'string' ? body.package_json : null,
    tsconfig: typeof body.tsconfig === 'string' ? body.tsconfig : null,
    binary_files: stableMapEntries(body.binary_files),
    binary_paths: [...(body.binary_paths || [])].sort(),
    vite_env: stableMapEntries(body.vite_env),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/* ─── SVG → React component (Vite/svgr-compatible) ────────────────────────
 * `import Logo from './logo.svg?react'` → a component (default export).
 * `import url, { ReactComponent } from './logo.svg'` → URL default + component.
 * dangerouslySetInnerHTML so the SVG body never goes through the JSX parser
 * (real SVGs carry <style>{…}</style>, xmlns:xlink, etc. that break naive JSX). */
const SVG_ATTR_RENAMES = {
  'class': 'className', 'for': 'htmlFor', 'tabindex': 'tabIndex',
  'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray', 'stroke-dashoffset': 'strokeDashoffset', 'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity', 'fill-opacity': 'fillOpacity', 'fill-rule': 'fillRule',
  'clip-path': 'clipPath', 'clip-rule': 'clipRule', 'vector-effect': 'vectorEffect',
  'shape-rendering': 'shapeRendering', 'text-anchor': 'textAnchor', 'font-family': 'fontFamily',
  'font-size': 'fontSize', 'font-weight': 'fontWeight', 'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity',
};
function svgToReactComponent(svgText, componentName, exportDefault) {
  const cleaned = svgText
    .replace(/<\?xml[^?]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const rootMatch = cleaned.match(/^<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i);
  const reactAttrs = {};
  let inner = cleaned;
  if (rootMatch) {
    inner = rootMatch[2];
    const attrRe = /([A-Za-z][\w:-]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(rootMatch[1]))) {
      const key = SVG_ATTR_RENAMES[m[1]] || (m[1].includes(':') ? null : m[1]);
      if (key) reactAttrs[key] = m[2];
    }
  }
  const decl = `import * as React from 'react';
function ${componentName}(props) {
  return React.createElement('svg', Object.assign(
    ${JSON.stringify(reactAttrs)}, props,
    { dangerouslySetInnerHTML: { __html: ${JSON.stringify(inner)} } },
  ));
}
`;
  return exportDefault === false ? decl : decl + `export default ${componentName};\n`;
}

function svgDataUrl(svgText) {
  return `data:image/svg+xml;base64,${Buffer.from(svgText, 'utf8').toString('base64')}`;
}

/**
 * esbuild plugin for the two svg import shapes.
 *
 * `root` is the build root, and the `?react` branch keys its namespace on the
 * ROOT-RELATIVE path rather than the absolute one. esbuild stamps
 * `namespace:path` into the bundle banner and the sourcemap, and every build
 * materializes to a fresh mkdtemp dir — so the absolute form put a random tmp
 * segment in the OUTPUT BYTES, and identical source compiled to a different
 * content hash every single time (tsk_cdd7c47c). Files loaded through the
 * normal pipeline are already normalized against absWorkingDir; a custom
 * namespace is not, so it has to normalize itself.
 */
function svgPlugin(root) {
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* keep root */ }
  // esbuild reports resolveDir as a REAL path (symlinks resolved); root may
  // contain one (macOS /var → /private/var), so compare like with like.
  const toAbs = (rel) => path.resolve(realRoot, rel);
  return {
    name: 'somewhere-svg',
    setup(build) {
      // `./x.svg?react` — strip the query, resolve on disk, emit a component.
      build.onResolve({ filter: /\.svg\?react$/ }, (args) => {
        const clean = args.path.replace(/\?react$/, '');
        const abs = path.isAbsolute(clean) ? clean : path.resolve(args.resolveDir, clean);
        const rel = path.relative(realRoot, abs);
        // Outside the build root (nothing normal reaches here) — keep the
        // absolute path rather than emit a path that escapes the root.
        if (rel.startsWith('..') || path.isAbsolute(rel)) return { path: abs, namespace: 'svg-react' };
        return { path: rel, namespace: 'svg-react' };
      });
      build.onLoad({ filter: /.*/, namespace: 'svg-react' }, async (args) => {
        const abs = path.isAbsolute(args.path) ? args.path : toAbs(args.path);
        const svg = await fsp.readFile(abs, 'utf8');
        const base = (abs.split('/').pop() || 'Icon').replace(/\.svg$/i, '').replace(/[^A-Za-z0-9]/g, '_').replace(/^([0-9])/, '_$1');
        const name = (base.charAt(0).toUpperCase() + base.slice(1)) || 'SvgIcon';
        return { contents: svgToReactComponent(svg, name, true), loader: 'jsx', resolveDir: path.dirname(abs) };
      });
      // bare `./x.svg` — URL default + named ReactComponent (svgr dual binding).
      build.onLoad({ filter: /\.svg$/ }, async (args) => {
        const svg = await fsp.readFile(args.path, 'utf8');
        return {
          contents:
            svgToReactComponent(svg, '__SvgReactComponent', false) +
            `\nexport const ReactComponent = __SvgReactComponent;` +
            `\nexport default ${JSON.stringify(svgDataUrl(svg))};\n`,
          loader: 'jsx',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

/* ─── URL-export resolution for large binary assets (tsk_ad51a448) ───────────
 * The worker withholds the BYTES of large binaries (the multi-MB base64 map
 * was the memory spike that killed ~25MB deploy payloads) and sends a
 * `binary_paths` manifest instead. Imports of those paths resolve to a URL
 * export — `import img from './hero.png'` → "/hero.png" — which is what the
 * asset's canonical serving path is anyway (Vite emits URLs, not data URLs,
 * for anything past its inline threshold too). CSS url() tokens stay as
 * external absolute URLs. Small assets keep arriving with bytes and ride the
 * dataurl loaders, unchanged. */
function urlAssetPlugin(root, binaryPaths) {
  const rels = new Set(binaryPaths || []);
  // esbuild reports resolveDir as a REAL path (symlinks resolved); root may
  // contain one (macOS /var → /private/var in local dev). Compare like with
  // like or every relative() result walks out of the tree.
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* keep root */ }
  return {
    name: 'somewhere-url-asset',
    setup(build) {
      if (rels.size === 0) return;
      build.onResolve({ filter: /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|pdf)$/i }, (args) => {
        if (args.kind === 'entry-point') return null;
        const abs = path.isAbsolute(args.path) ? args.path : path.resolve(args.resolveDir, args.path);
        const rel = path.relative(realRoot, abs);
        if (!rels.has(rel)) return null; // bytes were provided → default pipeline
        const url = `/${rel}`;
        if (args.kind === 'url-token') return { path: url, external: true }; // css url(...)
        return { path: url, namespace: 'sw-url-asset' };
      });
      build.onLoad({ filter: /.*/, namespace: 'sw-url-asset' }, (args) => ({
        contents: `export default ${JSON.stringify(args.path)};`,
        loader: 'js',
      }));
    },
  };
}

/* ─── function-vs-static classification (mirror of deploy.ts:isFunctionPath) ─ */
function isFunctionPath(p) {
  if (!/\.(ts|js|mjs|tsx)$/i.test(p)) return false;
  if (p.startsWith('api/') || p.startsWith('_lib/')) return true;
  if (/^\[[^/]+\]\.(ts|js|mjs)$/.test(p)) return true;
  return false;
}

/* ─── Tailwind detection ────────────────────────────────────────────────── */
function detectTailwind(files) {
  for (const [p, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    if (!/\.(?:css|scss|sass|less)$/i.test(p)) continue;
    if (/@import\s+["']tailwindcss(?:\/[^"']*)?["']/.test(content)) return 4;
    if (/@(?:theme|utility|custom-variant|source)\b/.test(content)) return 4;
  }
  for (const p of Object.keys(files)) {
    if (/(?:^|\/)tailwind\.config\.(?:js|cjs|mjs|ts)$/.test(p)) return 3;
  }
  for (const [p, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    if (/(?:^|\/)postcss\.config\.(?:js|cjs|mjs|ts)$/.test(p) && /tailwind/i.test(content)) return 3;
    if (!/\.(?:css|scss|sass|less)$/i.test(p)) continue;
    if (/@tailwind\b/.test(content)) return 3;
    if (/@apply\b/.test(content)) return 3;
    if (/@layer\s+(?:base|components|utilities)\b/.test(content)) return 3;
  }
  return 0;
}

/* ─── import.meta.env / VITE_* defines ──────────────────────────────────── */
function buildViteEnvDefines(env, sourceFiles) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (!/^VITE_[A-Z0-9_]+$/.test(k)) continue;
    out[`import.meta.env.${k}`] = JSON.stringify(v);
  }
  // referenced-but-unset VITE_* → "" so `VITE_X || 'fallback'` survives bundling
  // instead of becoming `undefined.VITE_X` (the railtime blank-page class).
  const referenced = new Set();
  const rx = /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g;
  for (const src of Object.values(sourceFiles || {})) {
    if (typeof src !== 'string') continue;
    let m;
    while ((m = rx.exec(src)) !== null) referenced.add(m[1]);
  }
  for (const name of referenced) {
    const key = `import.meta.env.${name}`;
    if (out[key] === undefined) out[key] = '""';
  }
  return out;
}

/** CRA-style env: every referenced `process.env.REACT_APP_*` is defined from
 *  the project env map (or "" when unset) — react-scripts baked these into
 *  the build the same way. Without a define, the identifier survives into
 *  the bundle and `process` is undefined in the browser → blank page, so
 *  this can only FIX projects, never change a working one (an existing
 *  guarded `typeof process !== 'undefined'` check still short-circuits
 *  first). (tsk_4d9c865a) */
function buildReactEnvDefines(env, sourceFiles) {
  const out = {};
  const referenced = new Set();
  const rx = /process\.env\.(REACT_APP_[A-Z0-9_]+)/g;
  for (const src of Object.values(sourceFiles || {})) {
    if (typeof src !== 'string') continue;
    let m;
    while ((m = rx.exec(src)) !== null) referenced.add(m[1]);
  }
  for (const name of referenced) {
    const v = (env || {})[name];
    out[`process.env.${name}`] = v === undefined ? '""' : JSON.stringify(v);
  }
  return out;
}

/** Write the in-memory file map (+ base64 binaries) to a fresh tmp dir. */
async function materialize(files, binaryFiles) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'swc-'));
  for (const [rel, content] of Object.entries(files || {})) {
    if (typeof content !== 'string') continue;
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
  for (const [rel, b64] of Object.entries(binaryFiles || {})) {
    if (typeof b64 !== 'string') continue;
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, Buffer.from(b64, 'base64'));
  }
  return root;
}

function assertSourcePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel)) {
    throw codedError('INVALID_SOURCE_PATH', `invalid source path: ${JSON.stringify(rel)}`);
  }
  const normalized = path.posix.normalize(rel);
  if (normalized !== rel || normalized === '..' || normalized.startsWith('../')) {
    throw codedError('INVALID_SOURCE_PATH', `source path is not canonical: ${rel}`);
  }
}

function validateCompileInput(body) {
  if (!body || typeof body !== 'object') throw new Error('request body is required');
  if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) {
    throw new Error('`files` map is required');
  }
  if (body.binary_files !== undefined && (!body.binary_files || typeof body.binary_files !== 'object' || Array.isArray(body.binary_files))) {
    throw new Error('`binary_files` must be a map');
  }
  if (body.binary_paths !== undefined && !Array.isArray(body.binary_paths)) {
    throw new Error('`binary_paths` must be an array');
  }
  for (const field of ['function_entries', 'function_paths', 'transform_entries']) {
    if (body[field] !== undefined && !Array.isArray(body[field])) throw new Error(`\`${field}\` must be an array`);
    for (const rel of body[field] || []) assertSourcePath(rel);
  }
  if ((body.operation || 'project') === 'project') {
    if (typeof body.project_id !== 'string' || !body.project_id.trim()) throw new Error('`project_id` is required');
    if (typeof body.build_id !== 'string' || !body.build_id.trim()) throw new Error('`build_id` is required');
  }
  const textPaths = Object.keys(body.files);
  const binaryFilePaths = Object.keys(body.binary_files || {});
  const binaryPaths = body.binary_paths || [];
  const paths = [...new Set([...textPaths, ...binaryFilePaths, ...binaryPaths])];
  if (paths.length > MAX_FILE_COUNT) throw codedError('SOURCE_LIMIT', `too many files: ${paths.length} > ${MAX_FILE_COUNT}`);
  for (const rel of paths) assertSourcePath(rel);
  for (const rel of binaryFilePaths) {
    if (Object.prototype.hasOwnProperty.call(body.files, rel)) throw codedError('INVALID_SOURCE', `path is both text and binary: ${rel}`);
  }
  for (const rel of binaryPaths) {
    if (typeof rel !== 'string') throw codedError('INVALID_SOURCE_PATH', `invalid source path: ${JSON.stringify(rel)}`);
    if (Object.prototype.hasOwnProperty.call(body.files, rel) || Object.prototype.hasOwnProperty.call(body.binary_files || {}, rel)) {
      throw codedError('INVALID_SOURCE', `path is both inline and withheld binary: ${rel}`);
    }
  }
  let totalBytes = 0;
  for (const [rel, content] of Object.entries(body.files)) {
    if (typeof content !== 'string') throw codedError('INVALID_SOURCE', `source file must contain text: ${rel}`);
    totalBytes += Buffer.byteLength(content, 'utf8');
  }
  if (typeof body.package_json === 'string' && body.files['package.json'] !== body.package_json) totalBytes += Buffer.byteLength(body.package_json, 'utf8');
  if (typeof body.tsconfig === 'string' && body.files['tsconfig.json'] !== body.tsconfig) totalBytes += Buffer.byteLength(body.tsconfig, 'utf8');
  if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
    throw codedError('SOURCE_LIMIT', `source bytes ${totalBytes} > ${MAX_TOTAL_SOURCE_BYTES}`);
  }
  let binaryBytes = 0;
  for (const [rel, b64] of Object.entries(body.binary_files || {})) {
    if (typeof b64 !== 'string') throw codedError('INVALID_SOURCE', `binary file must contain base64 text: ${rel}`);
    binaryBytes += Buffer.from(b64, 'base64').length;
  }
  if (binaryBytes > MAX_BINARY_BYTES) {
    throw codedError('BINARY_LIMIT', `binary bytes ${binaryBytes} > ${MAX_BINARY_BYTES}`);
  }
}

function cleanRange(range) {
  // `^18.2.0` → `18.2.0`; keep it installable but pin to the declared version.
  return String(range || '').replace(/^[\^~>=<v\s]+/, '').split(/\s/)[0] || 'latest';
}

/* ─── Lockfile-derived install pins (tsk_f79d71ce) ────────────────────────────
 * THE INSTALL SPEC IS OWNED HERE, by the core, so `somewhere dev` and
 * `somewhere deploy` derive it from the same code and cannot disagree.
 *
 * The bug this closes: deploy floor-pinned the declared range (`^7.9.5` → 7.9.5)
 * while the developer's own machine had 7.18.3 installed from their lockfile, so
 * the local and deployed entry chunks were built against different library code
 * — measured on the 0.30.0 journey scaffold, where react-router was the only
 * package left in the diff. "Same app, same data, same build" was not true.
 *
 * THE RULE, both directions:
 *   - LOCKFILE PRESENT (npm-shrinkwrap.json, else package-lock.json — npm's own
 *     precedence): a dependency installs at the version the lockfile pins, which
 *     is exactly what the developer has locally. The pin is only honoured when it
 *     PROVABLY SATISFIES the range declared in package.json, so a lockfile can
 *     only ever move the build WITHIN what package.json already allows; an
 *     out-of-sync lockfile falls back to the floor-pin rather than installing
 *     something package.json contradicts.
 *   - NO LOCKFILE: unchanged, and this is the documented rule — third-party deps
 *     FLOOR-PIN the declared range (`^7.9.5` → 7.9.5), first-party
 *     `@somewhere-tech/*` pass the range through verbatim so npm resolves the
 *     latest satisfying version. A project with no lockfile resolves today
 *     exactly as it did before this change (rule 9).
 *
 * WHY `@somewhere-tech/*` IGNORES THE LOCKFILE TOO: pfb_f607d6b27453. Our own
 * scaffold + `npm install` writes a lockfile within seconds of `somewhere init`,
 * so honouring it for first-party packages would re-freeze every scaffold on the
 * SDK version it was born with and published SDK fixes would never reach new
 * deploys — the exact harm the range passthrough exists to prevent. Right after
 * an install the locked version IS the latest in range, so the two agree; they
 * only part as the lockfile ages, and that is the case where the platform's own
 * package must move.
 *
 * BOUNDARY, stated so nobody reads more into this than it does: this pins the
 * dependencies the core decides to install — the ones declared in the project's
 * package.json. Their TRANSITIVE dependencies are still resolved by npm from the
 * parents' ranges. Pinning the whole locked closure was considered and rejected
 * for now: an explicit exact spec for every transitive can trip ERESOLVE peer
 * conflicts and platform-specific optional binaries, which would turn a build
 * that works today into a refused one (rule 9 — tighten incrementally). If a
 * transitive drift is ever measured, that is the next step, not a redesign.
 *
 * Prefer-baked resolution is deliberately NOT changed: which packages come from
 * the baked image, and the React-19 symlink hot path, still key off the DECLARED
 * RANGE. Making the baked decision exact-match would cold-install React on every
 * lockfile project (tsk_2553662f's 600s timeout) and would re-open the very
 * divergence tsk_0312cf17 closed by pinning the local loop to the image's own
 * React set. Aligning the local loop with the rest of the baked set is the CLI's
 * half of this, not the compiler's.
 */

/** npm's own lockfile precedence: a shrinkwrap wins over a package-lock. */
const LOCKFILE_NAMES = ['npm-shrinkwrap.json', 'package-lock.json'];

/**
 * Versions an npm lockfile pins for the project's TOP-LEVEL packages.
 *
 * Only `node_modules/<name>` entries count: a nested `node_modules/a/node_modules/b`
 * path is a transitive's private copy, not the version the project itself
 * resolves. Link entries (workspaces, `file:` deps) carry no registry version and
 * are skipped. Handles lockfileVersion 2/3 (`packages`) and 1 (`dependencies`).
 * Malformed input yields an empty map — never a throw; a lockfile we cannot read
 * degrades to today's floor-pin.
 */
function lockfileVersions(text) {
  const out = new Map();
  if (typeof text !== 'string' || !text.trim()) return out;
  let lock;
  try { lock = JSON.parse(text); } catch { return out; }
  if (!lock || typeof lock !== 'object') return out;
  const packages = lock.packages && typeof lock.packages === 'object' ? lock.packages : null;
  if (packages) {
    for (const [entryPath, entry] of Object.entries(packages)) {
      if (!entryPath.startsWith('node_modules/')) continue;
      const name = entryPath.slice('node_modules/'.length);
      if (name.includes('/node_modules/')) continue;
      if (!entry || typeof entry !== 'object' || entry.link) continue;
      if (typeof entry.version !== 'string' || !entry.version) continue;
      out.set(name, entry.version);
    }
  }
  const v1 = lock.dependencies && typeof lock.dependencies === 'object' ? lock.dependencies : null;
  if (v1) {
    for (const [name, entry] of Object.entries(v1)) {
      if (out.has(name)) continue;
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.version !== 'string' || !entry.version) continue;
      if (/^(?:file|link|git\+|https?):/.test(entry.version)) continue;
      out.set(name, entry.version);
    }
  }
  return out;
}

/**
 * The one derivation of what to hand `npm install` for a single dependency.
 * PURE — `satisfies(version, range)` is passed in (semver is host-loaded) and
 * must return TRUE only when it can prove the version is inside the range;
 * anything it cannot prove falls back to the floor-pin, i.e. today's behavior.
 *
 * Exported so the fixture can pin the rule in BOTH directions without a build.
 */
function resolveInstallSpec({ name, range, lockedVersion, satisfies }) {
  // First-party platform packages: declared range verbatim, lockfile ignored.
  // See the block comment above (pfb_f607d6b27453).
  if (name.startsWith('@somewhere-tech/')) {
    return `${name}@${String(range || 'latest').trim() || 'latest'}`;
  }
  if (lockedVersion && typeof satisfies === 'function') {
    let inRange = false;
    try { inRange = satisfies(lockedVersion, range) === true; } catch { inRange = false; }
    if (inRange) return `${name}@${lockedVersion}`;
  }
  return `${name}@${cleanRange(range)}`;
}

/**
 * The project's locked versions, read from the materialized build root. Both
 * hosts land here: the container materializes every uploaded file (the lockfile
 * included) into the build root, and the CLI's build root is the project itself.
 * A missing or unreadable lockfile is not an error — it is the documented
 * no-lockfile path.
 */
function readLockedVersions(root) {
  for (const name of LOCKFILE_NAMES) {
    let text;
    try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch { continue; }
    const versions = lockfileVersions(text);
    if (versions.size) return versions;
  }
  return new Map();
}

/**
 * Is `name` resolvable the way ESBUILD will resolve it — i.e. as a direct child
 * package of one of the exact search dirs (the per-build install + the baked
 * image set, mirroring esbuild's nodePaths)? We deliberately do NOT use Node's
 * require.resolve here: its `paths` option walks UP ancestor directories, so in
 * the monorepo it finds deps in a parent node_modules that esbuild's strict
 * nodePaths can't see — over-reporting "resolvable" and skipping an install
 * esbuild then needs. An isolated container has no such ancestor; this fs check
 * is correct in both environments.
 */
function isResolvable(name, searchDirs) {
  return searchDirs.some((dir) => fs.existsSync(path.join(dir, name, 'package.json')));
}

// Build-toolchain packages that legacy scaffolds declare under `dependencies`
// (CRA puts react-scripts there by default). The browser bundle never imports
// them, and installing react-scripts alone drags in a ~100MB tree that can
// blow the per-build install timeout — the platform IS the build toolchain.
// (tsk_4d9c865a)
const TOOLCHAIN_DEPS = new Set(['react-scripts', 'react-app-rewired', 'craco', '@craco/craco', 'vite', 'webpack', 'parcel']);

/* ─── Phantom-import detection (tsk_8e460b69) ─────────────────────────────────
 * esbuild 0.24 tree-shakes a bare import whose named bindings are ALL unused
 * before it attempts to resolve the module. An `import { nothing } from
 * 'missing-pkg'` where `nothing` is never referenced silently succeeds — no
 * "Could not resolve" error and no warning. The customer's deploy
 * goes live; if that code path ever executes in the browser it fails at runtime.
 *
 * This scanner runs AFTER the esbuild build succeeds and catches that class:
 * every bare specifier found in the frontend source that is NOT resolvable
 * through the same set of sources esbuild would use (per-build install, baked
 * image, React-19 baked set, NODE_POLYFILLS aliases) is surfaced as a warning.
 *
 * RULE 9 — WARN-FIRST: never a build failure. A phantom import the customer
 * hasn't reached yet doesn't break today's page. The warning names the package
 * and the file so the developer or their agent can add it to package.json.
 *
 * GRANDFATHER: the full resolvability chain (build root → IMAGE_NODE_MODULES →
 * REACT19_NODE_MODULES → NODE_POLYFILLS → node: prefix → relative/URL paths)
 * mirrors exactly what esbuild can resolve, so a working import NEVER warns.
 * Platform-provided specifiers (PLATFORM_MODULE_ROOTS) are exempt on top of
 * that: they are not npm packages, so no resolution chain would ever find them.
 */

/**
 * Extract bare import/export specifiers from JS-family source.
 * "Bare" = not relative (`./`, `../`), not root-anchored (`/`), not a URL.
 * Handles static import, re-export, bare side-effect import, and dynamic import().
 */
function extractBareSpecifiers(content) {
  if (typeof content !== 'string') return [];
  const out = new Set();
  const re = /(?:\bimport\b[^'";]*?\bfrom\s*|\bexport\b[^'";]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const spec = m[2];
    if (!spec) continue;
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) continue; // http:, data:, blob:, node:, virtual:, …
    out.add(spec);
  }
  return [...out];
}

/**
 * Return the root package name for a specifier: `@scope/pkg/subpath` → `@scope/pkg`,
 * `pkg/subpath` → `pkg`, `pkg` → `pkg`.
 */
function specRootPkg(spec) {
  return spec.startsWith('@')
    ? spec.split('/').slice(0, 2).join('/')
    : spec.split('/')[0];
}

/**
 * Root packages the PLATFORM provides — derived from typed-functions'
 * PLATFORM_MODULES, which is also what builds the virtual-module resolver, so
 * this can never drift into a stale hand list.
 *
 * These are not npm packages. Reporting one as "not in your package.json" told
 * a developer that the `somewhere/db` import our own managed-schema docs handed
 * them would fail to load in production, and the remediation it offered —
 * `npm install somewhere` — installs an unrelated package (tsk_53badecfb7).
 */
const PLATFORM_MODULE_ROOTS = new Set(typedFunctions.PLATFORM_MODULES.map(specRootPkg));

/* ─── Dependency review (PR1, tsk_35befef9 / npm supply-chain) ────────────────
 * After deps are installed (with --ignore-scripts), walk the customer's RESOLVED
 * dependency tree and report what actually shipped: package count, lifecycle
 * scripts that were SKIPPED, native modules, and any resolved version that
 * matches a known-compromised release. Surfaced at deploy as the "dependency
 * review" block + (for a known-bad hit) a non-blocking warning.
 *
 * RULE 9 — this is WARN-FIRST: we report, we never refuse the build. Promotion
 * of any signal to an actual block is a separate, gated step (PR4).
 *
 * No network: reads only the installed package.json files on the build fs. The
 * AUTHORITATIVE live advisory scan (OSV/npm-advisory) ships with the R2
 * dependency cache (PR2), running on cache-entry; this is the certain, feed-free
 * signal + a small hand-verified known-bad backstop so a famous worm can't slip
 * through before that feed lands.
 *
 * Scope = the customer's installed tree (build-root node_modules) — the long
 * tail npm pulled in. The pre-baked image deps (our toolchain + react) are our
 * own trusted pins, not the customer's supply-chain surface, so they're excluded.
 */

// Hand-verified backstop of CONFIRMED-compromised exact versions. NOT the
// authoritative source (PR2's live OSV scan is) — every entry is an exact
// name@version confirmed across independent advisories. Rule 7: no guessed or
// approximate entry, because a wrong known-bad becomes a false BLOCK the moment
// these promote past warn-first.
//
// Sept 8 2025 "crypto-clipper" cluster — chalk/debug/ansi maintainer phished
// (npmjs.help 2FA-reset lure); injected a browser wallet-drainer. Sources:
// Sonatype, Wiz, Semgrep, Vercel, Palo Alto Unit 42.
const KNOWN_BAD_VERSIONS = {
  debug: ['4.4.2'], chalk: ['5.6.1'], 'ansi-styles': ['6.2.2'], 'ansi-regex': ['6.2.1'],
  'strip-ansi': ['7.1.1'], 'wrap-ansi': ['9.0.1'], 'supports-color': ['10.2.1'],
  'supports-hyperlinks': ['4.1.1'], color: ['5.0.1'], 'color-name': ['2.0.1'],
  'color-convert': ['3.1.1'], 'color-string': ['2.1.1'], 'has-ansi': ['6.0.1'],
  'slice-ansi': ['7.1.1'], 'chalk-template': ['1.1.1'], backslash: ['0.2.1'],
  'is-arrayish': ['0.3.3'], 'error-ex': ['1.3.3'], 'simple-swizzle': ['0.2.3'],
  'proto-tinker-wc': ['0.1.87'], duckdb: ['1.3.3'], '@duckdb/node-api': ['1.3.3'],
  '@duckdb/node-bindings': ['1.3.3'], '@duckdb/duckdb-wasm': ['1.29.2'],
};

const MAX_REVIEW_PACKAGES = 5000; // pathological-tree guard
const NATIVE_BUILD_TOOLS = /node-gyp|node-pre-gyp|prebuild|prebuildify|cmake-js/;

// Walk a node_modules dir → {name, version, dir, pkg} per installed package.
// Handles @scope packages and nested node_modules (npm dedupe conflicts).
function* walkInstalled(nmDir, depth) {
  if (depth > 6 || !fs.existsSync(nmDir)) return;
  let entries;
  try { entries = fs.readdirSync(nmDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(nmDir, e.name);
    if (e.name.startsWith('@')) {
      let scoped;
      try { scoped = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const s of scoped) {
        if (s.name.startsWith('.')) continue;
        yield* emitInstalledPkg(path.join(full, s.name), depth);
      }
    } else {
      yield* emitInstalledPkg(full, depth);
    }
  }
}
function* emitInstalledPkg(dir, depth) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* not a package dir */ }
  if (pkg && typeof pkg.name === 'string') yield { name: pkg.name, version: pkg.version || '0.0.0', dir, pkg };
  yield* walkInstalled(path.join(dir, 'node_modules'), depth + 1);
}

function reviewDependencies(root, pkg) {
  const directDeps = (pkg && pkg.dependencies) || {};
  const review = {
    directDependencies: Object.keys(directDeps).length,
    scanned: 0,
    installScriptsExecuted: 0, // always 0 — --ignore-scripts
    installScriptsSkipped: [], // [{name, version, hooks}]
    nativeModules: [],         // [{name, version}]
    knownBad: [],              // [{name, version, severity, incident}]
    packages: [],              // [{name, version}] — resolved set, for the
                               // worker's live OSV advisory scan (PR4). Capped.
  };
  const seen = new Set();
  for (const { name, version, dir, pkg: p } of walkInstalled(path.join(root, 'node_modules'), 0)) {
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > MAX_REVIEW_PACKAGES) break;
    review.scanned++;
    review.packages.push({ name, version });

    const scripts = (p && p.scripts) || {};
    const hooks = ['preinstall', 'install', 'postinstall'].filter((h) => typeof scripts[h] === 'string' && scripts[h].trim());
    if (hooks.length) review.installScriptsSkipped.push({ name, version, hooks });

    const isNative = (p && p.gypfile === true)
      || fs.existsSync(path.join(dir, 'binding.gyp'))
      || hooks.some((h) => NATIVE_BUILD_TOOLS.test(scripts[h] || ''));
    if (isNative) review.nativeModules.push({ name, version });

    const bad = KNOWN_BAD_VERSIONS[name];
    if (bad && bad.includes(version)) {
      review.knownBad.push({ name, version, severity: 'critical', incident: 'confirmed-compromised npm release' });
    }
  }
  return review;
}

/* ─── Manifest path (tsk_118c1ecc) — direct-to-storage artifact upload ──────
 * A heavy compiled result (~36MB for project `tools`) cannot safely ride back
 * inline. When the request carries `artifact_upload` {url, token}, the
 * container PUTs every chunk to the worker's /v1/compile-artifacts route
 * (gated by the scoped single-build token — same pattern as the npm-proxy
 * per-build token) and the response carries only a MANIFEST: chunk names,
 * sizes, sha256 hashes. No chunk bodies. */

/** Throw an Error carrying a machine-readable `code` the worker branches on. */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function artifactDescriptor(pathname, kind, text) {
  const bytes = Buffer.from(text, 'utf8');
  const mime = pathname.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : 'application/javascript; charset=utf-8';
  return {
    path: pathname,
    kind,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    mime,
  };
}

function inlineResultBodyBytes(result) {
  let bytes = 0;
  for (const text of Object.values(result.chunks || {})) bytes += Buffer.byteLength(text, 'utf8');
  for (const artifact of Object.values(result.functions || {})) bytes += Buffer.byteLength(artifact.js, 'utf8');
  for (const artifact of Object.values(result.transforms || {})) bytes += Buffer.byteLength(artifact.js, 'utf8');
  return bytes;
}

function enforceInlineResultCap(body, result) {
  const cap = body.inline_result_cap_bytes;
  if (!Number.isFinite(cap) || cap <= 0) return;
  const inlineBytes = inlineResultBodyBytes(result);
  const serializedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (serializedBytes <= cap) return;
  const mb = (serializedBytes / (1024 * 1024)).toFixed(1);
  const inlineMb = (inlineBytes / (1024 * 1024)).toFixed(1);
  const capMb = (cap / (1024 * 1024)).toFixed(0);
  throw codedError(
    'RESULT_TOO_LARGE',
    `compiled result is ${mb}MB (${inlineMb}MB inline bodies) across ${result.artifact_manifest.artifacts.length} artifacts, above the ${capMb}MB limit`,
  );
}

function resolvedDependencyDigest(review) {
  const packages = [...(review && review.packages || [])]
    .map((item) => `${item.name}@${item.version}`)
    .sort();
  return crypto.createHash('sha256').update(packages.join('\n')).digest('hex');
}

function sourceLoader(filename) {
  if (/\.tsx$/i.test(filename)) return 'tsx';
  if (/\.(?:ts|mts|cts)$/i.test(filename)) return 'ts';
  if (/\.jsx$/i.test(filename)) return 'jsx';
  if (/\.(?:js|mjs|cjs)$/i.test(filename)) return 'js';
  if (/\.json$/i.test(filename)) return 'json';
  return null;
}

function resolveLocalFunctionImport(root, spec) {
  if (typeof spec !== 'string' || /^(?:node|cloudflare|workerd):/.test(spec)) return null;
  if (spec.startsWith('.') || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return null;
  const base = path.resolve(root, spec.replace(/^\/+/, ''));
  if (base !== root && !base.startsWith(root + path.sep)) return null;
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map((ext) => base + ext),
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map((ext) => path.join(base, 'index' + ext)),
  ];
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || null;
}

function functionLocalImportPlugin(root) {
  return {
    name: 'somewhere-function-local-root',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return null;
        if (/^(?:node|cloudflare|workerd):/.test(args.path)) return { path: args.path, external: true };
        const local = resolveLocalFunctionImport(root, args.path);
        return local ? { path: local } : null;
      });
    },
  };
}
/* ══════════════════════════════════════════════════════════════════════════
 * ENVIRONMENT-BOUND — everything that needs to know where the baked toolchain
 * and dependency trees live, how an install runs, and what stamps this build.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Build a compiler instance bound to one host environment.
 * @param {object} host — see the file header for the complete contract.
 */
function createCompileCore(host) {
  if (!host || typeof host !== 'object') throw new Error('createCompileCore(host) requires a host');
  for (const required of ['imageNodeModules', 'requireImage', 'installPackages']) {
    if (host[required] === undefined || host[required] === null) {
      throw new Error(`createCompileCore(host): host.${required} is required`);
    }
  }
  // One dir or several, in search order. The container has exactly one (its
  // baked image tree); the CLI's local dev loop has up to two (the project's
  // own node_modules first, then its managed cache), which is why this is a
  // list rather than the single path the container needed.
  // esbuild IS the compiler: same version in, same bytes out. A host may hand
  // us a different BUILD of that exact version (the CLI uses esbuild-wasm
  // 0.24.0, which the parity fixture proves emits identical output to the
  // container's native 0.24.0) but never a different version — the compiler
  // stamp carries esbuild.version and the vendor step refuses a pin mismatch.
  const esbuild = host.esbuild || require('esbuild');
  const IMAGE_NODE_MODULES = Array.isArray(host.imageNodeModules)
    ? host.imageNodeModules.filter(Boolean)
    : [host.imageNodeModules];
  if (!IMAGE_NODE_MODULES.length) throw new Error('createCompileCore(host): host.imageNodeModules is empty');
  const REACT19_NODE_MODULES = host.react19NodeModules || null;
  const imageRequire = host.requireImage;
  const tw4Require = host.requireTw4 || (() => { throw new Error('this host has no Tailwind v4 engine'); });
  const stamp = host.stamp || {};

  function compilerStamp(sourceDigest) {
    return {
      contract: COMPILER_CONTRACT,
      esbuild: esbuild.version,
      source: stamp.source,
      toolchain: stamp.toolchain,
      ...(sourceDigest ? { source_digest: sourceDigest } : {}),
    };
  }

  // semver is lazily required from the baked image and backs ensureDeps'
  // version-aware resolution. If it somehow can't load, getSemver returns null and
  // bakedSatisfies degrades to "does not satisfy" → per-build install (slower but
  // correct) — never a crash, and never a false baked match.
  let _semver;
  function getSemver() {
    if (_semver !== undefined) return _semver;
    try { _semver = imageRequire('semver'); } catch { _semver = null; }
    return _semver;
  }

  /**
   * The prefer-baked-but-respect-the-pin rule for ONE baked dependency: return
   * true only when the image's pre-baked copy of `name` satisfies the project's
   * requested `range`. When it returns false the caller installs the project's
   * declared version per-build into the build root, and esbuild resolves the build
   * root's node_modules BEFORE the baked nodePaths — so the project's version wins
   * and a baked dep is never forced onto an app that pinned another.
   *
   * Bias is deliberate and one-directional: a FALSE POSITIVE (claiming baked
   * satisfies when it doesn't) would ship the wrong version to the customer, so we
   * never risk it. Anything we cannot positively prove satisfies — a missing baked
   * version, a range semver can't parse (`latest`, git/alias specs), or semver
   * being unavailable — returns false and falls back to a per-build install, which
   * is correct, just slower. A false NEGATIVE only costs an unnecessary install.
   */
  function bakedSatisfies(name, range, baseDir) {
    // No explicit dir = ask the whole search path, in order. Any dir whose copy
    // satisfies the range is a hit, because that is the copy esbuild resolves.
    if (baseDir === undefined) return IMAGE_NODE_MODULES.some((dir) => bakedSatisfies(name, range, dir));
    let bakedVersion;
    try {
      bakedVersion = JSON.parse(fs.readFileSync(path.join(baseDir, name, 'package.json'), 'utf8')).version;
    } catch { return false; }
    if (!bakedVersion) return false;
    const semver = getSemver();
    if (!semver) return false;
    // Empty / missing range means "any version" — the baked copy is fine.
    const wanted = (typeof range === 'string' && range.trim()) ? range.trim() : '*';
    if (semver.validRange(wanted) === null) return false; // 'latest', git/alias specs, etc.
    try { return semver.satisfies(bakedVersion, wanted, { includePrerelease: false }); }
    catch { return false; }
  }

  // Packages the React 19 isolated set provides. ensureDeps consults the baked 19
  // for these BEFORE deciding to install — but ONLY when the baked 18 in
  // IMAGE_NODE_MODULES does NOT satisfy the pin (i.e. the app actually wants 19).
  const REACT19_PACKAGES = new Set(['react', 'react-dom']);

  /**
   * For a react/react-dom dependency that the default baked 18 does NOT satisfy:
   * can the baked React-19 set satisfy it? Returns the absolute dir of the baked
   * 19 package to symlink, or null (→ fall through to a per-build install of the
   * project's exact pin — the incompatible-pin path, RULE-6). The same prefer-
   * baked-but-respect-the-pin discipline as bakedSatisfies, just against the
   * isolated react19/ node_modules.
   */
  function react19BakedDir(name, range) {
    if (!REACT19_PACKAGES.has(name)) return null;
    // A host may have no isolated React-19 set (the CLI's dep cache is one flat
    // tree). Then there is nothing to prefer and the pin installs normally.
    if (!REACT19_NODE_MODULES) return null;
    if (!bakedSatisfies(name, range, REACT19_NODE_MODULES)) return null;
    return path.join(REACT19_NODE_MODULES, name);
  }

  /**
   * Resolve the customer's `dependencies` (directive flag #1 + invariant #2:
   * resolved versions match local), with version-aware prefer-baked resolution.
   * Per dependency, in order:
   *   1. Already in THIS build's node_modules → nothing to do.
   *   2. Baked in the image AND the baked version satisfies the requested range
   *      (bakedSatisfies) → use the baked copy, no install. This is the hot path:
   *      react + the top long-tail libs ship in the image, so most builds do zero
   *      `npm install` (perf) and the container barely reaches the registry (good
   *      for the egress-locked compile container).
   *   3. Otherwise → `npm install` the declared version into the build root. This
   *      covers both un-baked long-tail deps AND the case where the project pinned
   *      a version the baked copy does NOT satisfy (step 2 returned false): the
   *      per-build install lands in the build root, which esbuild resolves before
   *      the baked nodePaths, so the project's pin wins.
   * devDependencies (tailwind, vite, etc.) are NOT installed — the build toolchain
   * is the container's job, not the app's.
   */


  async function ensureDeps(root, pkg, warnings, ctx, scopedProxyReady = true) {
    const deps = (pkg && pkg.dependencies) || {};
    const buildRoot = path.join(root, 'node_modules');
    // The project's own lockfile, materialized alongside package.json. It IS
    // uploaded on every deploy and was, until now, ignored — which is what made
    // the deployed build resolve a different version of an app dependency than
    // the developer's machine (tsk_f79d71ce). Missing/unreadable → empty map →
    // the floor-pin path, unchanged.
    const locked = readLockedVersions(root);
    const semverForLock = getSemver();
    const satisfiesLocked = semverForLock
      ? (version, range) => {
          const wanted = (typeof range === 'string' && range.trim()) ? range.trim() : '*';
          if (semverForLock.validRange(wanted) === null) return false;
          return semverForLock.satisfies(version, wanted, { includePrerelease: true });
        }
      : null;
    const missing = [];
    // react/react-dom whose pin the baked 18 misses but the baked 19 satisfies:
    // collect them to symlink from the isolated react19 set instead of installing.
    // This is the tsk_2553662f hot-path fix — a React-19 app no longer triggers a
    // cold full install of react + react-dom (which dragged the whole heavy dep
    // tree into one over-budget job).
    const react19Links = [];
    for (const [name, range] of Object.entries(deps)) {
      if (TOOLCHAIN_DEPS.has(name)) continue;
      if (isResolvable(name, [buildRoot])) continue;
      if (isResolvable(name, IMAGE_NODE_MODULES) && bakedSatisfies(name, range)) continue;
      const r19 = react19BakedDir(name, range);
      if (r19) { react19Links.push({ name, dir: r19 }); continue; }
      // WHAT version to install is resolveInstallSpec's single decision — the
      // project's lockfile when it pins one inside the declared range, the
      // floor-pin otherwise, the declared range verbatim for first-party
      // @somewhere-tech/* packages. See the block comment on resolveInstallSpec.
      missing.push(resolveInstallSpec({
        name, range, lockedVersion: locked.get(name), satisfies: satisfiesLocked,
      }));
    }
    // Symlink the baked React-19 packages into the build root so esbuild resolves
    // them from root/node_modules (which it consults before the baked nodePaths) —
    // a single React instance per build, the baked 19, with zero install. A
    // symlink failure is non-fatal: drop it back into `missing` so the dep still
    // installs per-build (slower but correct), never a broken build.
    if (react19Links.length) {
      try { fs.mkdirSync(buildRoot, { recursive: true }); } catch { /* exists */ }
      for (const { name, dir } of react19Links) {
        const link = path.join(buildRoot, name);
        try {
          if (!fs.existsSync(link)) fs.symlinkSync(dir, link, 'dir');
        } catch (e) {
          warnings.push(`react19 link skipped for ${name}; installing per-build: ${e && e.message ? e.message : String(e)}`);
          missing.push(resolveInstallSpec({
            name, range: deps[name], lockedVersion: locked.get(name), satisfies: satisfiesLocked,
          }));
        }
      }
    }
    if (!missing.length) return;
    if (!scopedProxyReady) {
      throw codedError('NPM_PROXY_REQUIRED', `the scoped package proxy is required to resolve ${missing.length} dependency pin(s)`);
    }
    // Mark the build STAGE so the BUILD_TIMEOUT handler can report where it
    // stalled (tsk_2553662f: a timeout used to be a bare "build exceeded Nms"
    // with no hint whether npm install or esbuild was the culprit).
    if (ctx && ctx.setStage) ctx.setStage('installing');
    // WHICH packages to install and WHY is decided above and is the same
    // everywhere. HOW the install runs is the one host-specific part: the
    // container shells out to npm through its per-build scoped proxy with the
    // BUILD_TIMEOUT controller wired to the child, the CLI installs into its
    // own cache with no proxy. host.installPackages owns that and owns the
    // NPM_INSTALL_TIMEOUT / real-failure error classification with it.
    await host.installPackages({ root, specs: missing, ctx });
  }

  /**
   * Parse the tsconfig `paths` aliases into a list of matchers. esbuild resolves
   * these at build time (buildOpts.tsconfig is set), so a specifier that matches
   * an alias is NOT a phantom import — without this the ubiquitous `@/*` → `src/*`
   * alias would false-warn on every deploy that uses it (the jsxApp fixture, and
   * most real Vite apps). Malformed/absent tsconfig → no aliases (never a crash).
   * Each matcher is the key with a trailing `/*` stripped; a spec matches when it
   * equals the matcher OR starts with `matcher + '/'`.
   */
  function tsconfigAliasMatchers(tsconfigText) {
    if (typeof tsconfigText !== 'string') return [];
    try {
      // ts.parseConfigFileTextToJson tolerates JSONC (comments/trailing commas)
      // that real tsconfigs carry; it's the same parser used by runReferenceCheck.
      const ts = imageRequire('typescript');
      const cfg = ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText).config || {};
      const paths = (cfg.compilerOptions && cfg.compilerOptions.paths) || {};
      return Object.keys(paths).map((k) => k.replace(/\/\*$/, ''));
    } catch {
      return [];
    }
  }

  /**
 * Build-CONFIG files, which are never in the browser graph.
 *
 * The platform IS the bundler, so a project's vite/rollup/webpack/postcss/
 * tailwind config is never executed by anything the compiler emits. Scanning
 * them for phantom imports produced a warning whose own premise was false —
 * "if that code path runs, your app will fail to load it", for a code path
 * that cannot run — on our OWN init scaffold, whose vite.config.ts imports
 * vite and @vitejs/plugin-react (tsk_424174be).
 */
function isBuildConfigFile(filePath) {
  const base = filePath.split('/').pop() || '';
  return /^(?:vite|vitest|rollup|webpack|next|nuxt|svelte|astro|remix|tailwind|postcss|babel|jest|playwright|cypress|eslint|prettier|stylelint)\.config\.[cm]?[jt]sx?$/i.test(base);
}

/** Make the implicit project root explicit for path aliases. */
  function normalizeTsconfigText(tsconfigText) {
    if (typeof tsconfigText !== 'string') return tsconfigText;
    try {
      const parsed = imageRequire('typescript').parseConfigFileTextToJson('tsconfig.json', tsconfigText).config;
      const options = parsed && typeof parsed === 'object' ? parsed.compilerOptions : null;
      if (options && typeof options === 'object' && options.paths && options.baseUrl === undefined) {
        return JSON.stringify({ ...parsed, compilerOptions: { ...options, baseUrl: '.' } });
      }
    } catch { /* preserve malformed input so the compiler reports it */ }
    return tsconfigText;
  }

  /**
   * Scan `frontendFiles` for bare imports that are NOT resolvable through any of
   * the mechanisms esbuild uses. Returns a Map<rootPkg, filePaths[]>.
   *
   * Called after ensureDeps so build-root node_modules reflects installed deps.
   * `aliasMatchers` are the tsconfig `paths` prefixes esbuild also resolves.
   * Wrapped in compile() so any unexpected error degrades to 0 findings, never
   * a crash (same discipline as reviewDependencies).
   */
  function detectPhantomImports(frontendFiles, root, aliasMatchers = [], declaredDevDeps = []) {
    const buildRootNm = path.join(root, 'node_modules');
    const polyfillKeys = new Set(Object.keys(NODE_POLYFILLS));
    const devDeclared = new Set(declaredDevDeps);
    const isAliased = (spec) =>
      aliasMatchers.some((a) => spec === a || spec.startsWith(a + '/'));
    // Map<rootPkg, string[]> — files that import a phantom package
    const phantom = new Map();
    for (const [filePath, content] of Object.entries(frontendFiles)) {
      if (typeof content !== 'string') continue;
      // Only scan JS-family source files — CSS @import is a different resolver
      if (!/\.(tsx?|jsx?|mjs|cjs|js)$/i.test(filePath)) continue;
      // A build config is not in the browser graph at all (tsk_424174be).
      if (isBuildConfigFile(filePath)) continue;
      for (const spec of extractBareSpecifiers(content)) {
        // node: builtins are handled by NODE_POLYFILLS aliases; skip independently
        // (node:path is not a polyfillKey but is caught by the URL-shaped :// test
        // in extractBareSpecifiers already — this is belt-and-suspenders).
        if (spec.startsWith('node:')) continue;
        // Resolvable through a tsconfig `paths` alias (e.g. `@/App`) — esbuild
        // resolves these, so they are never phantom. Check the FULL specifier
        // (aliases like `@/App` have no npm-style root package).
        if (isAliased(spec)) continue;
        const rootPkg = specRootPkg(spec);
        // PROVIDED BY THE PLATFORM (`somewhere/db`, `somewhere:api`, …). Not npm
        // packages, so "add it to your package.json" is wrong advice on code our
        // own docs hand the developer (tsk_53badecfb7).
        if (PLATFORM_MODULE_ROOTS.has(rootPkg)) continue;
        // DECLARED in devDependencies. ensureDeps deliberately installs only
        // `dependencies` (the build toolchain is the platform's job, not the
        // app's), so a devDependency is never resolvable here — but it IS
        // declared, and "add it to your package.json" is already done. Warning
        // about it is a false positive with wrong remediation (tsk_424174be).
        if (devDeclared.has(rootPkg)) continue;
        // Resolvable through NODE_POLYFILLS alias (e.g. 'buffer', 'process')
        if (polyfillKeys.has(rootPkg)) continue;
        // Resolvable from per-build install (declared in package.json + installed)
        if (isResolvable(rootPkg, [buildRootNm])) continue;
        // Resolvable from the pre-baked image (react@18, zustand, lucide-react, …)
        if (isResolvable(rootPkg, IMAGE_NODE_MODULES)) continue;
        // Resolvable from the isolated React-19 baked set
        if (REACT19_NODE_MODULES && isResolvable(rootPkg, [REACT19_NODE_MODULES])) continue;
        // Not resolvable through any means — phantom import
        if (!phantom.has(rootPkg)) phantom.set(rootPkg, []);
        phantom.get(rootPkg).push(filePath);
      }
    }
    return phantom;
  }

  /**
   * Real Tailwind + PostCSS over the customer's CSS — the headline of the
   * migration. v3 (`@tailwind`/config) and v4 (`@import "tailwindcss"`) run their
   * actual engines against the materialized filesystem, so JIT scanning sees the
   * source and emits the utilities the app uses. No runtime CDN, no `sw-css-noop`.
   * Returns an esbuild onLoad plugin scoped to `.css`.
   *
   * cwd is the build root for the duration of the build (set by caller), so
   * Tailwind v3 auto-loads the customer's tailwind.config.js (via jiti, ESM/TS
   * configs included) and resolves its `content` globs relative to the project,
   * exactly like `vite build` locally.
   */
  function tailwindCssPlugin(twVersion, root) {
    const postcss = imageRequire('postcss');
    const autoprefixer = imageRequire('autoprefixer');

    function buildProcessor() {
      if (twVersion === 4) {
        const tw4 = tw4Require('@tailwindcss/postcss');
        return postcss([tw4({ base: root }), autoprefixer]);
      }
      const tailwind3 = imageRequire('tailwindcss');
      const hasConfig = ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts']
        .some((f) => fs.existsSync(path.join(root, f)));
      // With a config present, tailwind v3 auto-loads it from cwd (=root). Without
      // one (utility classes but no config file), give it explicit content globs
      // so JIT still scans the source instead of erroring/emitting nothing.
      const tw = hasConfig
        ? tailwind3()
        : tailwind3({ content: [path.join(root, '**/*.{html,js,ts,jsx,tsx,mjs,cjs}')], theme: { extend: {} }, plugins: [] });
      return postcss([tw, autoprefixer]);
    }

    return {
      name: 'somewhere-tailwind-css',
      setup(build) {
        const processor = buildProcessor();
        build.onLoad({ filter: /\.css$/ }, async (args) => {
          // CSS Modules (*.module.css) are class-name maps, not stylesheets to run
          // Tailwind over — let esbuild's native local-css loader handle them.
          // (Go RE2 has no lookbehind, so we filter all .css then bail here.)
          if (/\.module\.css$/i.test(args.path)) return undefined;
          let raw;
          try { raw = await fsp.readFile(args.path, 'utf8'); }
          catch (e) { return { errors: [{ text: `Cannot read CSS ${args.path}: ${e.message}` }] }; }
          try {
            const result = await processor.process(raw, { from: args.path, to: args.path });
            return { contents: result.css, loader: 'css' };
          } catch (e) {
            // Invariant #6: a Tailwind/PostCSS failure is a loud, actionable
            // compile error — never empty CSS served as "success".
            return { errors: [{ text: `Tailwind/PostCSS failed on ${path.relative(root, args.path)}: ${e.message}` }] };
          }
        });
      },
    };
  }

  /**
   * PR5 — tsc --noEmit type checking (directive Tier 1, invariant #6). Opt-in per
   * request (`typecheck:true`) so the deploy hot-path stays fast; the /v1/compile
   * inspect-fix loop turns it on. Reports type errors in the customer's OWN typed
   * code. Module-resolution noise (TS2307) and implicit-any-from-untyped-deps
   * (TS7016) are filtered: esbuild already proved every import resolves, so a
   * TS2307 here only means "this dep ships no .d.ts" — not an app error. Untyped
   * externals collapse to `any`, so real errors in the customer's annotations
   * (wrong shapes, bad generics) still surface. NON-blocking: type errors are
   * reported as metadata, never fail the build (rule 9 — surface before gating).
   */
  const TSC_IGNORE_CODES = new Set([2307, 7016, 2792, 6053]);
  function runTypecheck(root, tsconfigText) {
    const ts = imageRequire('typescript');
    const tsFiles = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) tsFiles.push(p);
      }
    })(root);
    if (!tsFiles.length) return { errors: [], checkedFiles: 0 };

    let userOpts = {};
    if (typeof tsconfigText === 'string') {
      try { userOpts = (ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText).config || {}).compilerOptions || {}; }
      catch { /* malformed tsconfig — use the lenient default below */ }
    }
    const { options } = ts.convertCompilerOptionsFromJson(
      {
        jsx: 'react-jsx', target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
        esModuleInterop: true, skipLibCheck: true, strict: false, noImplicitAny: false,
        allowJs: false, ...userOpts, noEmit: true,
      },
      root,
    );
    const program = ts.createProgram(tsFiles, options);
    const errors = [];
    for (const d of ts.getPreEmitDiagnostics(program)) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      if (d.code && TSC_IGNORE_CODES.has(d.code)) continue;
      const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      let loc = {};
      if (d.file && d.start != null) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        loc = { file: path.relative(root, d.file.fileName), line: line + 1, col: character + 1 };
      }
      errors.push({ code: `TS${d.code}`, message, ...loc });
    }
    return { errors, checkedFiles: tsFiles.length };
  }

  /**
   * Deploy-validation reference check (tsk §1 deploy-validation-gate). The
   * narrow, ALWAYS-SAFE cousin of runTypecheck, purpose-built for the deploy
   * gate that flags an UNDEFINED REFERENCE — the Bolo `sanitizeForSpeech is
   * not defined` class: code esbuild bundles past (valid syntax) but that
   * throws at runtime because nothing in the graph defines the name.
   *
   * Differences from runTypecheck that make it catch that class without
   * false-positiving on normal customer code:
   *   - Walks .js/.jsx TOO (allowJs:true + checkJs:true). The Bolo bug was in
   *     a .jsx; runTypecheck's allowJs:false skips those files entirely.
   *   - Includes the DOM lib so window/fetch/localStorage/navigator/etc.
   *     resolve — without it every browser global reads as an undefined name
   *     (a wall of false positives on real frontend code).
   *   - Filters module-resolution noise (TS2307 etc., same set as
   *     runTypecheck) AND scopes the SURFACED set to reference codes only on
   *     the worker side — here we return EVERY non-ignored error and let the
   *     worker pick the reference subset, so the container stays the single
   *     source of "what tsc said" and the gate's policy lives in one place.
   *
   * Returns the same {code, message, file, line, col} shape as runTypecheck.
   * Never throws into compile() — the caller wraps it.
   */
  function runReferenceCheck(root, tsconfigText) {
    const ts = imageRequire('typescript');
    const checkFiles = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(e.name)) checkFiles.push(p);
      }
    })(root);
    if (!checkFiles.length) return { errors: [], checkedFiles: 0 };

    let userOpts = {};
    if (typeof tsconfigText === 'string') {
      try { userOpts = (ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText).config || {}).compilerOptions || {}; }
      catch { /* malformed tsconfig — use the lenient default below */ }
    }
    const { options } = ts.convertCompilerOptionsFromJson(
      {
        jsx: 'react-jsx', target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
        esModuleInterop: true, skipLibCheck: true, strict: false, noImplicitAny: false,
        // DOM + es2022 so browser globals (window/fetch/localStorage/…) resolve
        // and don't read as undefined names — the whole reason this differs from
        // runTypecheck. NOTE: convertCompilerOptionsFromJson expects the SHORT
        // lib names ('es2022','dom'), not the lib.*.d.ts filenames (those are
        // rejected → empty lib → every browser global false-positives).
        lib: ['es2022', 'dom', 'dom.iterable'],
        ...userOpts,
        // These are forced ON regardless of the customer's tsconfig — the gate
        // exists to check .js/.jsx for undefined refs, and a customer
        // allowJs:false would silently disable it.
        allowJs: true, checkJs: true, noEmit: true,
      },
      root,
    );
    const program = ts.createProgram(checkFiles, options);
    const errors = [];
    for (const d of ts.getPreEmitDiagnostics(program)) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      if (d.code && TSC_IGNORE_CODES.has(d.code)) continue;
      const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      let loc = {};
      if (d.file && d.start != null) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        loc = { file: path.relative(root, d.file.fileName), line: line + 1, col: character + 1 };
      }
      errors.push({ code: `TS${d.code}`, message, ...loc });
    }
    return { errors, checkedFiles: checkFiles.length };
  }

  async function compileTransforms(body) {
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!entries.length) throw new Error('`entries` is required');
    const transforms = {};
    for (const entry of entries) {
      assertSourcePath(entry);
      const source = body.files[entry];
      const loader = sourceLoader(entry);
      if (typeof source !== 'string' || (loader !== 'jsx' && loader !== 'tsx')) {
        throw new Error(`transform entry ${JSON.stringify(entry)} must be a .jsx or .tsx source file`);
      }
      const out = await esbuild.transform(source, {
        loader,
        format: 'esm',
        target: 'es2022',
        jsx: 'automatic',
        sourcemap: 'inline',
        sourcefile: entry,
        logLevel: 'silent',
      });
      transforms[entry] = { js: out.code, warnings: out.warnings.map((warning) => warning.text) };
    }
    return { ok: true, transforms, warnings: [], compiler: compilerStamp() };
  }

  async function parseSources(body) {
    const errors = [];
    for (const [file, source] of Object.entries(body.files)) {
      if (typeof source !== 'string') continue;
      const loader = sourceLoader(file);
      if (!loader || loader === 'json') continue;
      try {
        await esbuild.transform(source, { loader, target: 'esnext', format: 'esm', logLevel: 'silent', sourcefile: file });
      } catch (err) {
        const messages = Array.isArray(err && err.errors) ? err.errors : [];
        if (messages.length) {
          for (const message of messages.slice(0, 5)) {
            errors.push({
              file,
              line: message.location && message.location.line,
              column: message.location ? message.location.column + 1 : undefined,
              message: message.text,
              line_text: message.location && message.location.lineText,
            });
          }
        } else {
          errors.push({ file, message: err && err.message ? err.message : String(err) });
        }
        if (errors.length >= 20) break;
      }
    }
    return { ok: true, errors, warnings: [], compiler: compilerStamp() };
  }

  async function compileFunctionEntries(root, entries, tsconfigText) {
    if (!entries.length) return { functions: {}, warnings: [], metafile: null, graph: { edges: [] } };
    const entryPoints = {};
    const outputNames = new Map();
    entries.forEach((entry, index) => {
      const name = `__sw_function_${String(index).padStart(4, '0')}`;
      entryPoints[name] = entry;
      outputNames.set(`${name}.js`, entry);
    });
    const buildOptions = {
      absWorkingDir: root,
      entryPoints,
      bundle: true,
      splitting: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      jsx: 'automatic',
      sourcemap: 'inline',
      write: false,
      metafile: true,
      outdir: 'function-out',
      entryNames: '[name]',
      nodePaths: IMAGE_NODE_MODULES,
      external: ['node:*', 'cloudflare:*', 'workerd:*'],
      define: {
        'import.meta.env.DEV': 'false',
        'import.meta.env.PROD': 'true',
        'import.meta.env.MODE': '"production"',
        'import.meta.env.SSR': 'true',
        'import.meta.env.BASE_URL': '"/"',
        'process.env.NODE_ENV': '"production"',
      },
      plugins: [functionLocalImportPlugin(root)],
    };
    const tsconfigPath = path.join(root, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) buildOptions.tsconfig = tsconfigPath;
    const result = await esbuild.build(buildOptions);
    const completeGraph = graphFromMetafile(result.metafile, root);
    const functions = {};
    for (const output of result.outputFiles || []) {
      const entry = outputNames.get(path.basename(output.path));
      if (!entry) continue;
      functions[entry] = {
        js: output.text,
        inlined: [entry],
        warnings: [],
      };
    }
    for (const entry of entries) {
      if (!functions[entry]) throw new Error(`bundler emitted no output for ${entry}`);
    }
    return { functions, warnings: result.warnings.map((warning) => warning.text), metafile: result.metafile, graph: completeGraph };
  }

  async function compile(body, ctx) {
    validateCompileInput(body);
    const operation = body.operation || 'project';
    if (operation === 'parse') return parseSources(body);
    if (operation !== 'project') throw new Error(`unsupported compile operation: ${operation}`);
    const result = await compileProject(body, ctx);
    const stamped = { ...result, compiler: compilerStamp(result.source_digest) };
    enforceInlineResultCap(body, stamped);
    return stamped;
  }

  // ctx (tsk_2553662f) carries the BUILD_TIMEOUT plumbing: `signal` (the
  // AbortController the handler aborts on timeout), `setStage(name)` so the
  // timeout 504 can report which stage stalled, and `npmChild` (the in-flight npm
  // process, so the abort kills it). Optional — the in-process harness/test path
  // calls compile(body) with no ctx and just runs to completion.
  async function compileProject(body, ctx) {
    const files = { ...body.files };
    const requestedEntry = typeof body.entry === 'string' && body.entry ? body.entry : null;
    const entry = requestedEntry || '__somewhere_empty_entry.mjs';
    if (!files || typeof files !== 'object') throw new Error('`files` map is required');
    if (requestedEntry && files[entry] === undefined) throw new Error(`entry "${entry}" not in files map`);
    if (!requestedEntry) files[entry] = 'export default null;\n';
    const functionEntries = [...new Set(body.function_entries || [])].sort();
    const functionPaths = new Set(body.function_paths || functionEntries);
    const transformEntries = [...new Set(body.transform_entries || [])]
      .filter((item) => item !== requestedEntry)
      .sort();
    for (const functionEntry of functionEntries) {
      if (typeof files[functionEntry] !== 'string') throw new Error(`function entry ${JSON.stringify(functionEntry)} not in files map`);
    }
    for (const transformEntry of transformEntries) {
      if (typeof files[transformEntry] !== 'string') throw new Error(`transform entry ${JSON.stringify(transformEntry)} not in files map`);
    }
    const digest = sourceDigest(body);
    const parsed = await parseSources({ files: body.files });
    if (parsed.errors.length) {
      const err = codedError('SOURCE_PARSE_ERROR', parsed.errors.map((error) => `${error.file}: ${error.message}`).join('; '));
      // The joined message keeps its exact existing text (the worker's error
      // copy reads it), but the STRUCTURED errors ride along: {file, line,
      // column, message, line_text} per bad file. A caller that wants to point
      // at the offending line — the local dev loop's terminal and its in-page
      // overlay — should not have to regex a paragraph back apart.
      err.source_errors = parsed.errors;
      throw err;
    }

    // Classify functions out of the frontend graph. Every routed entry is still
    // compiled below in THIS transaction, from the same materialized root and
    // resolved dependency tree.
    const functionRoutes = [];
    const frontendFiles = {};
    for (const p of Object.keys(files)) {
      if (functionPaths.has(p) || isFunctionPath(p)) functionRoutes.push(p);
      else frontendFiles[p] = files[p];
    }

    const packageJsonText = typeof body.package_json === 'string'
      ? body.package_json
      : files['package.json'];
    const tsconfigText = normalizeTsconfigText(
      typeof body.tsconfig === 'string' ? body.tsconfig : files['tsconfig.json'],
    );
    let pkg = {};
    if (typeof packageJsonText === 'string') {
      try { pkg = JSON.parse(packageJsonText); } catch { /* malformed → no extra deps */ }
    }
    const viteEnv = body.vite_env || {};
    const twVersion = detectTailwind(files);
    const warnings = [];

    // Per-phase wall-clock instrumentation (tsk_241c7c9f). Date.now() is fine
    // here — real Node in a container. Each value is ms for that phase; null =
    // phase did not run on this path. Echoed under metadata.timing_ms, purely
    // additive (no existing metadata field touched).
    const _t0 = Date.now();
    const timing = { materialize: null, install: null, typed_functions: null, bundle: null, refcheck: null, upload: null, total: null };
    const _ms = (start) => Date.now() - start;

    const _tMat = Date.now();
    const root = await materialize(files, body.binary_files);
    if (typeof packageJsonText === 'string') {
      await fsp.writeFile(path.join(root, 'package.json'), packageJsonText, 'utf8').catch(() => {});
    }
    if (typeof tsconfigText === 'string') {
      await fsp.writeFile(path.join(root, 'tsconfig.json'), tsconfigText, 'utf8').catch(() => {});
    }
    timing.materialize = _ms(_tMat);

    // ── validate_only fast path (tsk §1 deploy-validation-gate) ────────────
    // The deploy validation gate asks ONLY "does the module graph have an
    // undefined reference?" — it does NOT want a bundle, Tailwind, or npm
    // install (the slow parts). Run just the reference check over the
    // materialized graph and return metadata.validation_errors. No esbuild,
    // no chdir, no chunk emit. Wrapped so a tsc crash degrades to "no
    // validation errors" (ran-but-empty is indistinguishable from a clean
    // graph here, which is the safe direction — the worker treats an absent
    // validation_errors array as "not reference-checked", never as "clean").
    if (body.validate_only) {
      let validationErrors = null;
      const _tRef = Date.now();
      try {
        validationErrors = runReferenceCheck(root, tsconfigText).errors;
      } catch (e) {
        warnings.push(`reference check skipped: ${e && e.message ? e.message : String(e)}`);
      }
      timing.refcheck = _ms(_tRef);
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
      timing.total = _ms(_t0);
      return {
        ok: true,
        validate_only: true,
        warnings,
        metadata: { validation_errors: validationErrors, timing_ms: timing },
      };
    }

    const prevCwd = process.cwd();
    try {
      // PR2 npm proxy — when the deploy path supplies a registry+token, route this
      // build's `npm install` through the worker /v1/npm cache. Written as a
      // build-root .npmrc; ensureDeps runs npm with cwd=root so it's picked up.
      // always-auth so the bearer rides tarball GETs too. The token is a
      // short-lived proxy capability, NOT a registry credential (credential desert
      // preserved). Without it, a build that needs an install fails closed.
      const hasScopedProxy = typeof body.npm_registry === 'string' && !!body.npm_registry
        && typeof body.npm_token === 'string' && !!body.npm_token;
      if (hasScopedProxy) {
        try {
          const reg = body.npm_registry.endsWith('/') ? body.npm_registry : body.npm_registry + '/';
          const authKey = reg.replace(/^https?:/, '');
          await fsp.writeFile(
            path.join(root, '.npmrc'),
            `registry=${reg}\n${authKey}:_authToken=${body.npm_token}\nalways-auth=true\n`,
            'utf8',
          );
        } catch (e) {
          warnings.push(`npm proxy config skipped: ${e && e.message ? e.message : String(e)}`);
        }
      }

      // Resolve the long-tail deps before building (invariant #2). Awaited +
      // abortable now (tsk_2553662f): a heavy install can be killed by the
      // BUILD_TIMEOUT instead of blocking the event loop past the budget.
      const _tInstall = Date.now();
      // Two different questions. `hasScopedProxy` is "did this REQUEST carry
      // proxy credentials", and it decides the .npmrc above. Whether an
      // install may run AT ALL without them is a property of the HOST: the
      // container is egress-locked and must fail closed, the CLI reaches npm
      // directly through the developer's own config. Default is the container's
      // refusal, so opening it is always deliberate.
      await ensureDeps(root, pkg, warnings, ctx, hasScopedProxy || host.requiresPackageProxy === false);
      timing.install = _ms(_tInstall);

      // Dependency review (PR1) — WARN-FIRST, non-blocking. A scanner bug must
      // never break a build (that's the exact rule-9 anti-pattern), so it's
      // wrapped: on error we say so in warnings and continue without the block.
      let dependencyReview = null;
      try {
        dependencyReview = reviewDependencies(root, pkg);
        if (dependencyReview.knownBad.length) {
          const list = dependencyReview.knownBad.map((b) => `${b.name}@${b.version}`).join(', ');
          const n = dependencyReview.knownBad.length;
          warnings.push(
            `Security: ${n} ${n === 1 ? 'dependency resolves' : 'dependencies resolve'} to a release flagged as compromised in a known npm supply-chain incident: ${list}. Your build completed — this is a warning, not a block — but we strongly recommend pinning a safe version.`,
          );
        }
      } catch (e) {
        warnings.push(`dependency review skipped: ${e && e.message ? e.message : String(e)}`);
      }

      // Tailwind v3 config auto-load + content scanning resolve relative to cwd.
      process.chdir(root);

      // v4's `@import "tailwindcss"` is resolved (by @tailwindcss/postcss's
      // resolver) relative to the importing CSS file — it expects the project to
      // have `tailwindcss` installed. We substitute the isolated v4 engine, so
      // link it into the build root's node_modules where the resolver walks up
      // to find it. (No-op if the customer somehow shipped their own.)
      if (twVersion === 4) {
        const nm = path.join(root, 'node_modules');
        await fsp.mkdir(nm, { recursive: true });
        const link = path.join(nm, 'tailwindcss');
        if (!fs.existsSync(link)) {
          if (host.tw4TailwindDir) await fsp.symlink(host.tw4TailwindDir, link, 'dir').catch(() => {});
        }
      }

      // Typed server functions are sentinel-gated. analyzeTypedFunctions returns
      // after one string scan when no exact `somewhere:v1` candidate exists, so
      // ordinary deploys never construct a TypeScript Program. Stage 1 is
      // warning-only: an analyzer defect must not reject otherwise-working code.
      let typedAnalysis = {
        manifest: null,
        summary: { procedures: 0, contract_digest: null, warnings: 0 },
        warnings: [],
        declaration: null,
        runtime: typedFunctions.RUNTIME_SOURCE,
        timing_ms: { scan: 0, typecheck: 0, total: 0 },
      };
      try {
        typedAnalysis = typedFunctions.analyzeTypedFunctions({
          loadTypescript: () => imageRequire('typescript'),
          root,
          files,
          functionEntries,
          tsconfigText,
        });
        warnings.push(...typedAnalysis.warnings);
      } catch (e) {
        warnings.push(`Typed function check skipped; this deploy continued unchanged. Fix: retry the deploy, then contact support if the warning repeats. (${e && e.message ? e.message : String(e)})`);
      }
      timing.typed_functions = typedAnalysis.timing_ms;

      const tsconfigPath = path.join(root, 'tsconfig.json');
      const buildOpts = {
        absWorkingDir: root,
        entryPoints: [entry],
        bundle: true,
        splitting: true,
        format: 'esm',
        target: 'es2022',
        jsx: 'automatic',
        sourcemap: 'inline',
        write: false,
        metafile: true,
        outdir: 'out',
        entryNames: '[name]-[hash]',
        chunkNames: 'chunk-[hash]',
        assetNames: 'asset-[hash]',
        // A .js entry only ever comes from the CRA adapter (module-script
        // detection is .jsx/.tsx-only, so no pre-existing project can reach
        // here with one) — CRA allows JSX in .js files, so parse all .js as
        // JSX for those builds. The jsx loader is a superset of js.
        loader: { ...ASSET_LOADERS, ...(/\.js$/i.test(entry) ? { '.js': 'jsx' } : {}) },
        // esbuild resolves bare deps from root/node_modules first, then the
        // pre-baked image set (flag #1). Single node_modules tree per build =
        // single React instance, without the retired CDN dependency workaround.
        nodePaths: IMAGE_NODE_MODULES,
        // Node builtins → browser polyfills (so packages importing buffer/stream/
        // etc. resolve instead of hard-erroring). esbuild resolves these targets
        // from the pre-baked node_modules via nodePaths.
        alias: { ...NODE_POLYFILLS },
        define: {
          'import.meta.env.DEV': 'false',
          'import.meta.env.PROD': 'true',
          'import.meta.env.MODE': '"production"',
          'import.meta.env.SSR': 'false',
          'import.meta.env.BASE_URL': '"/"',
          'process.env.NODE_ENV': '"production"',
          // Node polyfills (the buffer/process packages) reference the `global`
          // identifier, which the browser doesn't define. Map it to globalThis.
          global: 'globalThis',
          ...buildViteEnvDefines(viteEnv, files),
          ...buildReactEnvDefines(viteEnv, files),
        },
        plugins: [
          typedFunctions.virtualApiPlugin(esbuild),
          urlAssetPlugin(root, body.binary_paths),
          svgPlugin(root),
          ...(twVersion > 0 ? [tailwindCssPlugin(twVersion, root)] : []),
        ],
      };
      if (fs.existsSync(tsconfigPath)) buildOpts.tsconfig = tsconfigPath;

      // Stage marker (tsk_2553662f): we're past install, now bundling. If the
      // BUILD_TIMEOUT fires during esbuild, its 504 reports stage='bundling'.
      if (ctx && ctx.setStage) ctx.setStage('bundling');
      // Use an esbuild CONTEXT so a BUILD_TIMEOUT abort can CANCEL the in-flight
      // build (and dispose the worker) instead of leaking it. Without a signal
      // (the local harness) this is a plain build()+dispose, behaviourally
      // identical to the old esbuild.build() call.
      let result;
      const _tBundle = Date.now();
      const bctx = await esbuild.context(buildOpts);
      try {
        const onAbort = () => { bctx.cancel().catch(() => {}); };
        if (ctx && ctx.signal) {
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        result = await bctx.rebuild();
        if (ctx && ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      } finally {
        await bctx.dispose();
        timing.bundle = _ms(_tBundle);
      }
      for (const w of result.warnings) warnings.push(w.text);

      // Phantom-import detection (tsk_8e460b69): esbuild tree-shakes unused named
      // imports before resolution, so `import { x } from 'missing-pkg'` where `x`
      // is never referenced silently succeeds. Scan the source for bare specifiers
      // that are NOT resolvable through any of esbuild's search paths and surface
      // them as warnings. RULE 9 — always non-blocking; scanner errors degrade to
      // 0 findings, never a crash.
      try {
        const aliasMatchers = tsconfigAliasMatchers(tsconfigText);
        const phantom = detectPhantomImports(
          frontendFiles, root, aliasMatchers, Object.keys((pkg && pkg.devDependencies) || {}),
        );
        for (const [pkg, files] of phantom) {
          const uniq = [...new Set(files)];
          const where = uniq.slice(0, 2).join(', ') + (uniq.length > 2 ? ` and ${uniq.length - 2} other file(s)` : '');
          warnings.push(
            `\`${pkg}\` is imported in ${where} but is not in your package.json and could not be resolved — if that code path runs, your app will fail to load it. Add it to the \`dependencies\` in your package.json.`,
          );
        }
      } catch (e) {
        warnings.push(`phantom-import scan skipped: ${e && e.message ? e.message : String(e)}`);
      }

      const entryBase = entry.split('/').pop().replace(/\.[^.]+$/, '');
      const chunks = {};
      let entryChunk = null;
      for (const f of result.outputFiles || []) {
        const name = f.path.split('/').pop();
        if (requestedEntry) {
          chunks[name] = f.text;
          if (!entryChunk && name.startsWith(`${entryBase}-`) && name.endsWith('.js')) entryChunk = name;
        }
      }
      if (requestedEntry && !entryChunk) throw new Error('bundler emitted no entry chunk');

      // Every routed function is compiled in one batched esbuild invocation from
      // this same root/dependency tree. No per-entry container request exists.
      if (ctx && ctx.setStage) ctx.setStage('bundling-functions');
      const functionBuild = await compileFunctionEntries(root, functionEntries, tsconfigText);
      warnings.push(...functionBuild.warnings);

      // Independently referenced JSX/TSX module entries are transformation
      // artifacts of this same complete project transaction, not another
      // publication request.
      const transformBuild = transformEntries.length
        ? await compileTransforms({ entries: transformEntries, files })
        : { transforms: {} };
      const transforms = transformBuild.transforms || {};

      // PR5 — opt-in type checking. Non-blocking: a type error is reported in
      // metadata, never a build failure (rule 9). A tsc crash degrades to a
      // warning, not a lost build.
      let typeErrors = null;
      if (body.typecheck) {
        try { typeErrors = runTypecheck(root, tsconfigText).errors; }
        catch (e) { warnings.push(`type check skipped: ${e && e.message ? e.message : String(e)}`); }
      }

      // Manifest path (tsk_118c1ecc): when the worker handed us an upload
      // capability, write the chunks to storage OURSELVES and answer with a
      // manifest only — the result stays small no matter how heavy the build.
      // Otherwise enforce the worker's inline cap: a result the deploy Worker
      // provably cannot parse must be a LOUD deterministic error here, never a
      // 36MB body that hangs the request.
      let uploadedChunks = null;
      const functionArtifacts = Object.entries(functionBuild.functions).map(([pathname, artifact]) =>
        artifactDescriptor(pathname, 'function', artifact.js));
      const transformArtifacts = Object.entries(transforms).map(([pathname, artifact]) =>
        artifactDescriptor(pathname, 'transform', artifact.js));
      const staticArtifacts = Object.entries(chunks).map(([name, text]) =>
        artifactDescriptor(`_compiled/${name}`, 'static', text));
      const artifacts = [...staticArtifacts, ...functionArtifacts, ...transformArtifacts]
        .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
      if (artifacts.length > MAX_ARTIFACT_COUNT) {
        throw codedError('RESULT_TOO_LARGE', `compiled artifact count ${artifacts.length} > ${MAX_ARTIFACT_COUNT}`);
      }
      if (body.artifact_upload && typeof body.artifact_upload.url === 'string' && typeof body.artifact_upload.token === 'string') {
        const _tUpload = Date.now();
        if (typeof host.uploadArtifacts !== 'function') {
          throw codedError('ARTIFACT_UPLOAD_FAILED', 'this compiler host cannot upload artifacts');
        }
        uploadedChunks = await host.uploadArtifacts(body.artifact_upload, chunks);
        timing.upload = _ms(_tUpload);
      }

      timing.total = _ms(_t0);
      const dependencyDigest = resolvedDependencyDigest(dependencyReview);
      return {
        ok: true,
        entry_chunk: entryChunk,
        chunks: uploadedChunks ? {} : chunks,
        ...(uploadedChunks ? { uploaded_chunks: uploadedChunks } : {}),
        functions: functionBuild.functions,
        function_graph: functionBuild.graph,
        transforms,
        errors: [],
        source_digest: digest,
        artifact_manifest: {
          project_id: body.project_id,
          build_id: body.build_id,
          source_digest: digest,
          dependency_digest: dependencyDigest,
          compiler: compilerStamp(digest),
          artifacts,
        },
        // The compiler emits Tailwind in the CSS chunk — the worker must not inject
        // the runtime CDN. Always false; the compiled stylesheet rides in chunks.
        needs_tailwind: false,
        // Mirrored at top level (in addition to metadata.warnings) so the worker's
        // existing bundleProject(), which reads `body.warnings`, is drop-in on the
        // PR3 cutover without a response remap.
        warnings,
        graph: graphFromMetafile(result.metafile, root),
        metadata: {
          timing_ms: timing,
          importGraph: importGraphFromMetafile(result.metafile, root),
          routes: { static: Object.keys(frontendFiles).filter((item) => item !== '__somewhere_empty_entry.mjs'), functions: functionRoutes },
          tailwind: twVersion > 0 ? { version: twVersion, compiled: true } : null,
          typeErrors,
          typed_functions: {
            manifest: typedAnalysis.manifest,
            summary: typedAnalysis.summary,
            timing_ms: typedAnalysis.timing_ms,
          },
          // Dependency review (PR1) — what the customer's resolved tree contains.
          // Null only if the scan itself threw (a `dependency review skipped`
          // warning is then present). knownBad already echoed into warnings above.
          dependency_review: dependencyReview,
          dependency_digest: dependencyDigest,
          warnings,
          // TODO PR4: prerenderedHtml via renderToString in headless Chromium.
          // TODO: securityFindings, bundleAnalysis.
        },
      };
    } finally {
      process.chdir(prevCwd);
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
  return {
    // The compile contract — identical signatures to the pre-extraction
    // server.js exports, so the container's consumers and contract tests are
    // untouched by the move.
    compile,
    compileProject,
    compileTransforms,
    parseSources,
    compilerStamp,
    // Exported for the container's regression fixtures (and reused by the CLI's
    // parity fixture). See server.js's module.exports for what each one guards.
    detectTailwind,
    reviewDependencies,
    runTypecheck,
    runReferenceCheck,
    ensureDeps,
    bakedSatisfies,
    react19BakedDir,
    detectPhantomImports,
    extractBareSpecifiers,
    tsconfigAliasMatchers,
    normalizeTsconfigText,
    isFunctionPath,
    sourceDigest,
    REACT19_NODE_MODULES,
    IMAGE_NODE_MODULES,
  };
}

module.exports = {
  createCompileCore,
  COMPILER_CONTRACT,
  // Install-spec derivation (tsk_f79d71ce) — pure, exported for the fixture
  // that pins the rule in both directions (lockfile present / absent).
  LOCKFILE_NAMES,
  lockfileVersions,
  resolveInstallSpec,
  cleanRange,
  NODE_POLYFILLS,
  ASSET_LOADERS,
  KNOWN_BAD_VERSIONS,
  MAX_TOTAL_SOURCE_BYTES,
  MAX_FILE_COUNT,
  MAX_BINARY_BYTES,
  MAX_ARTIFACT_COUNT,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_BYTES,
  importGraphFromMetafile,
  graphFromMetafile,
  isFunctionPath,
  detectTailwind,
  reviewDependencies,
  extractBareSpecifiers,
  sourceDigest,
};
