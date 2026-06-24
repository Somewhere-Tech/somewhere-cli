/**
 * capabilities.mjs — static capability detection for the swpx/swpm verdict layer.
 *
 * Pure ES module. No imports, no network, no node builtins, no dependencies.
 * Runs identically under Cloudflare Workers and node:test. Fully synchronous.
 *
 * Given a package's source text, returns which side-effecting capabilities the
 * source statically references. This is a conservative *static* signal — it does
 * not execute code and does not resolve dynamic strings; it only matches literal
 * patterns. The result is a sorted, de-duplicated subset of the four known tokens.
 */

/**
 * The complete, ordered set of capability tokens this detector can emit.
 * @type {ReadonlyArray<'child_process'|'fs'|'network'|'process.env'>}
 */
const CAPABILITY_ORDER = ['child_process', 'fs', 'network', 'process.env'];

/**
 * Build a RegExp that matches a CommonJS `require('mod')` or `require("mod")`
 * for any of the given module names, tolerating the optional `node:` prefix and
 * surrounding whitespace. Module names are treated as literal text.
 *
 * @param {string[]} modules - module specifiers to match (without `node:` prefix)
 * @returns {RegExp}
 */
function requireOf(modules) {
  const alt = modules.map(escapeRegExp).join('|');
  // require ( "node:?(mod)" )  — single or double quotes
  return new RegExp(
    'require\\s*\\(\\s*[\'"](?:node:)?(?:' + alt + ')[\'"]\\s*\\)',
  );
}

/**
 * Build a RegExp that matches an ESM static or dynamic import of any of the
 * given module names. Covers:
 *   - `import ... from 'mod'`  /  `import 'mod'`  /  `export ... from 'mod'`
 *   - `import('mod')` (dynamic)
 * Tolerates the optional `node:` prefix and single/double quotes.
 *
 * @param {string[]} modules - module specifiers to match (without `node:` prefix)
 * @returns {RegExp}
 */
function importOf(modules) {
  const alt = modules.map(escapeRegExp).join('|');
  const spec = '[\'"](?:node:)?(?:' + alt + ')[\'"]';
  // `from 'mod'`  (static import/export ... from)
  const fromForm = 'from\\s+' + spec;
  // bare `import 'mod'`  (side-effect import)
  const bareForm = 'import\\s+' + spec;
  // dynamic `import('mod')`
  const dynForm = 'import\\s*\\(\\s*' + spec + '\\s*\\)';
  return new RegExp('(?:' + fromForm + '|' + bareForm + '|' + dynForm + ')');
}

/**
 * Escape a string for safe literal use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Network -----------------------------------------------------------------
const NETWORK_MODULES = ['net', 'http', 'https', 'http2', 'dgram', 'tls', 'ws'];
const NETWORK_REQUIRE = requireOf(NETWORK_MODULES);
const NETWORK_IMPORT = importOf(NETWORK_MODULES);
// fetch(  — word-boundary so it is not a substring of e.g. `prefetch(`.
const NETWORK_FETCH = /\bfetch\s*\(/;
// new WebSocket(  /  new XMLHttpRequest(
const NETWORK_WEBSOCKET = /\bnew\s+WebSocket\s*\(/;
const NETWORK_XHR = /\bnew\s+XMLHttpRequest\s*\(/;

// --- Filesystem --------------------------------------------------------------
const FS_MODULES = ['fs', 'fs/promises'];
const FS_REQUIRE = requireOf(FS_MODULES);
const FS_IMPORT = importOf(FS_MODULES);

// --- child_process -----------------------------------------------------------
const CP_MODULES = ['child_process'];
const CP_REQUIRE = requireOf(CP_MODULES);
const CP_IMPORT = importOf(CP_MODULES);
// Calls to exec( execSync( spawn( spawnSync( fork( execFile(.
// Word boundary prevents matching substrings like `myExec(` or `.preexec(`.
const CP_CALL = /\b(?:exec|execSync|spawn|spawnSync|fork|execFile)\s*\(/;

// --- process.env -------------------------------------------------------------
// Literal text; no boundary needed — its presence is the signal.
const ENV_LITERAL = /process\.env/;

/**
 * Detect the set of side-effecting capabilities statically referenced by a
 * package's source text.
 *
 * Detection is purely lexical (no execution, no dynamic-string resolution):
 *  - `"network"`: require/import of net, http, https, http2, dgram, tls, or ws;
 *    OR a call to `fetch(`; OR `new WebSocket(`; OR `new XMLHttpRequest(`.
 *  - `"fs"`: require/import of `fs` or `fs/promises` (with or without `node:`).
 *  - `"child_process"`: require/import of `child_process`; OR a call to
 *    `exec(`, `execSync(`, `spawn(`, `spawnSync(`, `fork(`, or `execFile(`.
 *  - `"process.env"`: the literal text `process.env` appears anywhere.
 *
 * Both CommonJS (`require('x')` / `require("node:x")`) and ESM
 * (`import ... from 'x'` / `import('x')`) forms are recognized, with single or
 * double quotes and the optional `node:` prefix.
 *
 * Defensive: empty, non-string, or otherwise unusable input returns `[]`.
 *
 * @param {unknown} source - the raw source text of a package
 * @returns {string[]} sorted, de-duplicated subset of
 *   `["child_process", "fs", "network", "process.env"]`
 */
export function detectCapabilities(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return [];
  }

  /** @type {Set<string>} */
  const found = new Set();

  if (
    NETWORK_REQUIRE.test(source) ||
    NETWORK_IMPORT.test(source) ||
    NETWORK_FETCH.test(source) ||
    NETWORK_WEBSOCKET.test(source) ||
    NETWORK_XHR.test(source)
  ) {
    found.add('network');
  }

  if (FS_REQUIRE.test(source) || FS_IMPORT.test(source)) {
    found.add('fs');
  }

  if (CP_REQUIRE.test(source) || CP_IMPORT.test(source) || CP_CALL.test(source)) {
    found.add('child_process');
  }

  if (ENV_LITERAL.test(source)) {
    found.add('process.env');
  }

  // Emit in the canonical order, which is also the sorted order for these tokens.
  return CAPABILITY_ORDER.filter((token) => found.has(token));
}