/**
 * readability.mjs — detect minified/obfuscated published source for the
 * swpx/swpm npm "verdict layer" (task tsk_f30faf55).
 *
 * Pure ES module. No imports, no network, no node builtins, no dependencies.
 * Runs synchronously and environment-agnostically (Cloudflare Workers + node:test).
 * Standard JS only (String/Array/Object/Math/RegExp).
 */

/** Average line length above this flags "long-lines". */
const AVG_LINE_LENGTH_THRESHOLD = 500;

/** Whitespace ratio below this (for sources >= MIN_WHITESPACE_LENGTH) flags "low-whitespace". */
const WHITESPACE_RATIO_THRESHOLD = 0.10;

/** Only apply the whitespace-ratio heuristic to sources at least this long. */
const MIN_WHITESPACE_LENGTH = 500;

/** A single line longer than this flags "single-huge-line". */
const SINGLE_HUGE_LINE_THRESHOLD = 50000;

/**
 * Analyze a source string for signs of minification/obfuscation.
 *
 * Heuristics (any one firing => minified). Each firing heuristic pushes a
 * short reason string:
 *  - average line length > 500            => "long-lines"
 *  - whitespace ratio < 0.10 (len >= 500) => "low-whitespace"
 *  - any single line longer than 50000    => "single-huge-line"
 *
 * Robust to empty/undefined/garbage input: returns the safe default
 * { minified: false, reasons: [] } without throwing.
 *
 * @param {unknown} source - The published source text to analyze.
 * @returns {{ minified: boolean, reasons: string[] }}
 */
export function analyzeReadability(source) {
  const reasons = [];

  // Defensive: coerce only real strings; anything else is treated as empty.
  if (typeof source !== 'string' || source.length === 0) {
    return { minified: false, reasons };
  }

  const total = source.length;

  // Split into physical lines. Handles \n, \r\n, and \r line endings; a
  // source with no newline is a single line.
  const lines = source.split(/\r\n|\r|\n/);
  const lineCount = lines.length || 1;

  // --- Heuristic 1: average line length ---
  // Average chars per line = total chars / number of lines.
  const avgLineLength = total / lineCount;
  if (avgLineLength > AVG_LINE_LENGTH_THRESHOLD) {
    reasons.push('long-lines');
  }

  // --- Heuristic 2: whitespace ratio (only for non-tiny files) ---
  if (total >= MIN_WHITESPACE_LENGTH) {
    const whitespaceMatches = source.match(/\s/g);
    const whitespaceCount = whitespaceMatches ? whitespaceMatches.length : 0;
    const whitespaceRatio = whitespaceCount / total;
    if (whitespaceRatio < WHITESPACE_RATIO_THRESHOLD) {
      reasons.push('low-whitespace');
    }
  }

  // --- Heuristic 3: a single huge line ---
  let maxLineLength = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length;
    if (len > maxLineLength) maxLineLength = len;
  }
  if (maxLineLength > SINGLE_HUGE_LINE_THRESHOLD) {
    reasons.push('single-huge-line');
  }

  return { minified: reasons.length > 0, reasons };
}

/**
 * Convenience boolean wrapper.
 *
 * @param {unknown} source - The published source text to analyze.
 * @returns {boolean} true iff analyzeReadability(source).minified is true.
 */
export function isMinified(source) {
  return analyzeReadability(source).minified;
}
