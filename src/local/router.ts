/**
 * File-based routing for the local function runtime — a faithful port of the
 * deploy pipeline's route compiler + matcher (worker/src/utils/function-bundle.ts:
 * compileRoutePattern / routeSpecificityKey / matchRoute), so a URL resolves to
 * the same function locally as it does deployed.
 *
 *   api/hello.ts           → /api/hello              (static)
 *   api/sites/[id].ts      → /api/sites/:id          (param)
 *   api/files/[...path].ts → /api/files/*path        (catch-all)
 *   [...path].ts (root)    → /*path                  (root catch-all)
 *
 * Static beats param beats rest. `_lib/` and plain root files are bundled for
 * imports but never routed.
 */

export interface RouteSegment {
  type: 'static' | 'param' | 'rest';
  value: string;
}

export interface LocalRoute {
  /** Route key relative to the functions root, e.g. "api/sites/[id].ts". */
  file: string;
  /** Absolute path of the source file on disk. */
  absPath: string;
  pattern: RouteSegment[];
  displayPath: string;
}

export function compileRoutePattern(file: string): {
  pattern: RouteSegment[];
  displayPath: string;
} {
  const noExt = file.replace(/\.(ts|tsx|mts|js|mjs|jsx)$/, '');
  const parts = noExt.split('/');
  const pattern: RouteSegment[] = [];
  const display: string[] = [];
  parts.forEach((seg, i) => {
    const rest = seg.match(/^\[\.\.\.([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
    if (rest) {
      if (i !== parts.length - 1) {
        throw new Error(`catch-all [...${rest[1]}] must be the last path segment: ${file}`);
      }
      pattern.push({ type: 'rest', value: rest[1] });
      display.push(`*${rest[1]}`);
      return;
    }
    const param = seg.match(/^\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
    if (param) {
      pattern.push({ type: 'param', value: param[1] });
      display.push(`:${param[1]}`);
      return;
    }
    if (/[\[\]]/.test(seg)) {
      throw new Error(`malformed parametric segment "${seg}" in ${file}. Use [name] or [...name].`);
    }
    pattern.push({ type: 'static', value: seg });
    display.push(seg);
  });
  return { pattern, displayPath: '/' + display.join('/') };
}

function routeSpecificityKey(pattern: RouteSegment[]): string {
  return pattern.map((s) => (s.type === 'static' ? '2' : s.type === 'param' ? '1' : '0')).join('');
}

function hasRestSegment(pattern: RouteSegment[]): boolean {
  return pattern.some((s) => s.type === 'rest');
}

export function isRoutable(file: string): boolean {
  const isRootParametric = !file.includes('/') && /\[/.test(file);
  return file.startsWith('api/') || isRootParametric;
}

/**
 * Compile + sort routes most-specific first, mirroring buildFunctionBundle:
 * non-rest beats rest; within a group, segment-wise static > param wins.
 * Throws on two files compiling to the same route (same deploy-time error).
 */
export function compileRoutes(files: Array<{ file: string; absPath: string }>): LocalRoute[] {
  const routes: LocalRoute[] = [];
  for (const { file, absPath } of files) {
    if (!isRoutable(file)) continue;
    const { pattern, displayPath } = compileRoutePattern(file);
    routes.push({ file, absPath, pattern, displayPath });
  }

  const seen = new Map<string, string>();
  for (const r of routes) {
    const prior = seen.get(r.displayPath);
    if (prior) {
      throw new Error(
        `Two functions compile to the same route "${r.displayPath}": ${prior} and ${r.file}`,
      );
    }
    seen.set(r.displayPath, r.file);
  }

  routes.sort((a, b) => {
    const aRest = hasRestSegment(a.pattern);
    const bRest = hasRestSegment(b.pattern);
    if (aRest !== bRest) return aRest ? 1 : -1;
    const ka = routeSpecificityKey(a.pattern);
    const kb = routeSpecificityKey(b.pattern);
    return kb.localeCompare(ka);
  });

  return routes;
}

export interface RouteMatch {
  route: LocalRoute;
  params: Record<string, string>;
}

/** Walk routes in order and return the first match — port of the shim's matchRoute. */
export function matchRoute(routes: LocalRoute[], pathname: string): RouteMatch | null {
  const urlSegs = pathname.split('/').filter(Boolean);
  outer: for (const route of routes) {
    const params: Record<string, string> = {};
    const pat = route.pattern;
    for (let i = 0; i < pat.length; i++) {
      const p = pat[i];
      if (p.type === 'rest') {
        params[p.value] = urlSegs.slice(i).map(decodeURIComponent).join('/');
        return { route, params };
      }
      if (i >= urlSegs.length) continue outer;
      if (p.type === 'static') {
        if (urlSegs[i] !== p.value) continue outer;
      } else {
        params[p.value] = decodeURIComponent(urlSegs[i]);
      }
    }
    if (pat.length === urlSegs.length) {
      return { route, params };
    }
  }
  return null;
}
