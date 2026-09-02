/**
 * How many files, said the same way everywhere.
 *
 * One project used to get three different answers out of one CLI: `somewhere
 * deploy` said "2 static file(s) + 1 function(s)", `somewhere preview` said
 * "Synced 3 files" with the function invisible inside the number, and
 * `somewhere promote` said "3 files + functions" with the count of functions
 * replaced by the word. A developer reading all three cannot tell whether the
 * app grew, whether the function shipped, or which number to trust — which is
 * exactly what happened in the parity run that produced this module.
 *
 * The shape, everywhere: `3 static files + 1 function`. Two nouns, two
 * numbers, no parenthesised plurals.
 *
 * The counting rule, everywhere: static = the pages, scripts, styles and
 * assets that make up the site; functions = the api/ handlers, counted
 * separately because they are the half a boolean used to hide. It is the same
 * split the project itself reports, so the CLI's number and the project's
 * number are the same number.
 *
 * Pure and dependency-free so both directions can be fixtured without a
 * network.
 */

export interface PublishSurfaceCounts {
  /** Pages, scripts, styles, assets. `null` when it genuinely is not known. */
  staticFiles: number | null;
  /**
   * api/ handlers. `null` means "not known"; `'some'` means the only thing
   * available was a yes/no — say functions are there without inventing a count.
   */
  functions: number | 'some' | null;
}

/** A count with its noun, singular or plural — never `file(s)`. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one phrase. Renders as many of the two halves as are actually known:
 *
 *   { staticFiles: 3, functions: 1 }      → `3 static files + 1 function`
 *   { staticFiles: 3, functions: 0 }      → `3 static files`
 *   { staticFiles: 1, functions: 2 }      → `1 static file + 2 functions`
 *   { staticFiles: 3, functions: 'some' } → `3 static files + functions`
 *   { staticFiles: null, functions: 1 }   → `1 function`
 *   { staticFiles: null, functions: null} → `Files`
 *
 * A zero function count prints nothing rather than "+ 0 functions": a static
 * site saying it has no backend on every line is noise, and the absence is
 * already the answer.
 */
export function formatPublishSurface(counts: PublishSurfaceCounts): string {
  const parts: string[] = [];
  if (counts.staticFiles !== null) {
    parts.push(plural(counts.staticFiles, 'static file', 'static files'));
  }
  if (counts.functions === 'some') {
    parts.push('functions');
  } else if (typeof counts.functions === 'number') {
    // Zero is suppressed only as a TAIL: "3 static files + 0 functions" is
    // noise on a static site, but a functions-only deploy that moved nothing
    // still has to say so rather than fall through to a bare noun.
    if (counts.functions > 0 || parts.length === 0) {
      parts.push(plural(counts.functions, 'function', 'functions'));
    }
  }
  if (parts.length === 0) return 'Files';
  return parts.join(' + ');
}

/**
 * Count a collected publish surface the way the project does.
 *
 * Binary assets are static files — an image is as much part of the site as the
 * page that shows it, and splitting them out is an implementation detail of how
 * the CLI reads them off disk, not something a developer asked about.
 */
export function countPublishSurface(collected: {
  files: Record<string, unknown>;
  binaryFiles?: Record<string, unknown>;
  functions?: Record<string, unknown>;
}): PublishSurfaceCounts {
  return {
    staticFiles:
      Object.keys(collected.files).length + Object.keys(collected.binaryFiles ?? {}).length,
    functions: Object.keys(collected.functions ?? {}).length,
  };
}

/**
 * A count the platform sent, when it sent one. Anything that is not a finite
 * number is not a count — `null` (unknown) is honest and renders as an absence,
 * where `0` would be a claim.
 */
export function countFromResponse(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return null;
}
