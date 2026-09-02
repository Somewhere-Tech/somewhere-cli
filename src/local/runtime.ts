/**
 * The local function runtime behind `somewhere dev --local` and
 * `somewhere exec`: run a project's functions in local Node while every
 * sw.* binding talks to the real platform over the same REST surface the
 * deployed runtime uses.
 *
 * Contract fidelity comes from running the VENDORED deployed runtime
 * (runtime/platform-context.mjs + runtime/sw-init.mjs — extracted verbatim
 * from the deploy pipeline) rather than a reimplementation. The deployed
 * shim's REST fallback path (no D1 binding) is exactly the local path: we
 * build the same `env` bindings object it expects, minus PROJECT_DB.
 *
 * Local-only deviations, all deliberate:
 *   - sw.env is a fail-loud proxy: keys that exist on the platform but have
 *     no local value THROW on access (the env API never returns values).
 *   - Handler errors return the real message + stack in the response body
 *     (deployed keeps them in logs only) — it's your own terminal.
 *   - Uncaught errors print to the terminal instead of POSTing to /v1/logs.
 */
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiClient } from '../lib/client.js';
import { IGNORE } from '../lib/files.js';
import { compileRoutes, matchRoute, type LocalRoute } from './router.js';
import { entryUrl } from './loader.js';
import { loadLocalEnv } from './envfile.js';

// ─── Vendored deployed runtime ──────────────────────────────────────────────

interface PlatformContextModule {
  buildPlatformContext: (env: Record<string, unknown>, request: Request) => PlatformContext;
}

/** The per-request sw/ctx object. Typed loosely — the vendored runtime owns the shape. */
export interface PlatformContext {
  env: Record<string, string | undefined>;
  params: Record<string, string>;
  __sw_pendingRefresh?: { access: string | null; refresh: string | null };
  __sw_pendingCookies?: string[];
  [key: string]: unknown;
}

function packageRoot(): string {
  // dist/local/runtime.js → package root is two levels up.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

let contextModule: PlatformContextModule | null = null;

/** Import the vendored runtime once: sw-init (globalThis.sw.endpoint) + context factory. */
export async function loadVendoredRuntime(): Promise<PlatformContextModule> {
  if (contextModule) return contextModule;
  const root = packageRoot();
  await import(pathToFileURL(join(root, 'runtime', 'sw-init.mjs')).href);
  contextModule = (await import(
    pathToFileURL(join(root, 'runtime', 'platform-context.mjs')).href
  )) as PlatformContextModule;
  return contextModule;
}

// ─── Project state ──────────────────────────────────────────────────────────

export interface LocalProjectState {
  projectId: string;
  subdomain: string;
  cwd: string;
  /** env bindings handed to buildPlatformContext — same names the deploy pipeline binds. */
  bindings: Record<string, unknown>;
  /** Platform env keys with no local value: access throws. */
  missingEnvKeys: string[];
  /** Keys resolved locally (from .env/.env.local/shell). */
  localEnvKeys: string[];
  routes: LocalRoute[];
}

interface EnvKeyRow {
  key: string;
  scope?: string;
}

interface ScopeRow {
  table: string;
  owner_column: string;
}

/** Walk the project dir and return every function-routable source file. */
export function collectFunctionFiles(cwd: string): Array<{ file: string; absPath: string }> {
  const out: Array<{ file: string; absPath: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(cwd, full).split('\\').join('/');
      if (!/\.(ts|tsx|mts|js|mjs|jsx)$/i.test(rel)) continue;
      // Same key remapping as deploy: functions/ prefix is stripped; api/,
      // _lib/ and root parametric files at the root are functions as-is.
      const key = rel.startsWith('functions/') ? rel.slice('functions/'.length) : rel;
      out.push({ file: key, absPath: full });
    }
  };
  walk(cwd);
  return out;
}

/**
 * Fetch everything the runtime needs from the platform (project info, env
 * key list, table scopes), merge local env values, and compile routes.
 */
export async function prepareLocalProject(
  client: ApiClient,
  token: string,
  projectId: string,
  cwd: string,
): Promise<LocalProjectState> {
  const [project, envResult, scopesResult] = await Promise.all([
    client.call<{ id: string; subdomain: string }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}`,
    ),
    client.call<{ keys?: EnvKeyRow[]; vars?: EnvKeyRow[] }>('GET', '/env', undefined, {
      project_id: projectId,
    }),
    client
      .call<{ scopes?: ScopeRow[] }>('GET', '/db/scopes', undefined, { project_id: projectId })
      .catch(() => ({ scopes: [] as ScopeRow[] })),
  ]);

  const remoteKeys = (envResult.keys ?? envResult.vars ?? []).map((k) => k.key);
  const localFileEnv = loadLocalEnv(cwd);

  const values: Record<string, string> = {};
  for (const key of remoteKeys) {
    const local = localFileEnv[key] ?? process.env[key];
    if (local !== undefined) values[key] = local;
  }
  // Local-only keys are honored too — useful before the first `somewhere env set`.
  for (const [key, value] of Object.entries(localFileEnv)) {
    if (!(key in values)) values[key] = value;
  }
  const missingEnvKeys = remoteKeys.filter((k) => !(k in values));

  const scopes: Record<string, string> = {};
  for (const s of scopesResult.scopes ?? []) {
    scopes[s.table.toLowerCase()] = s.owner_column;
  }

  // Mirror of the deploy pipeline's bindings (buildFunctionBundle), minus
  // PROJECT_DB — its absence selects the runtime's REST db path, which is
  // exactly what local dev wants.
  const bindings: Record<string, unknown> = {
    PROJECT_ID: project.id,
    SUBDOMAIN: project.subdomain,
    TIER: 'free', // tier isn't readable over the project API; only informational in the runtime
    PROJECT_API_KEY: token,
    USER_ENV: JSON.stringify(values),
    PROJECT_SCOPES: JSON.stringify(scopes),
    PROJECT_ENV: 'dev',
  };

  const files = collectFunctionFiles(cwd);
  const routes = compileRoutes(files);

  return {
    projectId: project.id,
    subdomain: project.subdomain,
    cwd,
    bindings,
    missingEnvKeys,
    localEnvKeys: Object.keys(values),
    routes,
  };
}

/** Re-scan the directory and recompile routes (after add/remove of files). */
export function refreshRoutes(state: LocalProjectState): void {
  state.routes = compileRoutes(collectFunctionFiles(state.cwd));
}

// ─── sw.env fail-loud proxy ─────────────────────────────────────────────────

function makeEnvProxy(
  values: Record<string, string>,
  missingKeys: string[],
): Record<string, string | undefined> {
  const missing = new Set(missingKeys);
  return new Proxy({ ...values }, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      if (prop in target) return target[prop];
      if (missing.has(prop)) {
        throw new Error(
          `sw.env.${prop} is set on the platform, but env values can't be fetched over the API. ` +
            `Add ${prop}=... to a .env file in your project root (never deployed) or export it ` +
            `in your shell, then restart \`somewhere dev\`.`,
        );
      }
      return undefined;
    },
    has(target, prop) {
      return Reflect.has(target, prop) || (typeof prop === 'string' && missing.has(prop));
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), ...missing])];
    },
    getOwnPropertyDescriptor(target, prop) {
      const own = Reflect.getOwnPropertyDescriptor(target, prop);
      if (own) return own;
      if (typeof prop === 'string' && missing.has(prop)) {
        return { enumerable: true, configurable: true, value: undefined };
      }
      return undefined;
    },
  }) as Record<string, string | undefined>;
}

// ─── Dispatch (port of the generated index.mjs fetch handler) ───────────────

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: code, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Port of the shim's attachPendingRefresh — auth auto-refresh headers + cookies. */
function attachPendingRefresh(response: Response, ctx: PlatformContext): Response {
  const pending = ctx.__sw_pendingRefresh;
  const cookies = ctx.__sw_pendingCookies ?? [];
  const hasRefresh = !!(pending && pending.access && pending.refresh);
  if (!hasRefresh && cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  if (hasRefresh && pending) {
    headers.set('X-New-Access-Token', pending.access as string);
    headers.set('X-New-Refresh-Token', pending.refresh as string);
  }
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface DispatchResult {
  response: Response;
  route: string | null;
  /** Present when the handler (or context build) threw — for terminal display. */
  error?: unknown;
}

/**
 * Route one Request through the local runtime: match → import (current
 * generation) → buildPlatformContext → handler → response envelope.
 */
export async function dispatchRequest(
  request: Request,
  state: LocalProjectState,
): Promise<DispatchResult> {
  const url = new URL(request.url);
  const match = matchRoute(state.routes, url.pathname);

  if (!match) {
    return {
      response: jsonError(404, 'FUNCTION_NOT_FOUND', 'No function registered at ' + url.pathname),
      route: null,
    };
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(entryUrl(match.route.absPath))) as Record<string, unknown>;
  } catch (err) {
    return {
      response: jsonError(
        500,
        'FUNCTION_LOAD_FAILED',
        `${match.route.file} failed to load: ${err instanceof Error ? err.message : String(err)}`,
      ),
      route: match.route.displayPath,
      error: err,
    };
  }

  const method = request.method.toUpperCase();
  const handler = (mod[method] ?? mod.default) as
    | ((req: Request, sw: PlatformContext) => unknown)
    | undefined;
  if (typeof handler !== 'function') {
    return {
      response: jsonError(405, 'METHOD_NOT_ALLOWED', method + ' not supported on ' + match.route.displayPath),
      route: match.route.displayPath,
    };
  }

  try {
    Object.defineProperty(request, 'params', {
      value: match.params,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } catch {
    // frozen Request — sw.params still carries them
  }

  const { buildPlatformContext } = await loadVendoredRuntime();
  let ctx: PlatformContext;
  try {
    ctx = buildPlatformContext(state.bindings, request);
    ctx.params = match.params;
    // Swap the plain env object for the fail-loud proxy (see module docs).
    ctx.env = makeEnvProxy(
      JSON.parse((state.bindings.USER_ENV as string) || '{}') as Record<string, string>,
      state.missingEnvKeys,
    );
  } catch (err) {
    return {
      response: jsonError(
        500,
        'CONTEXT_BUILD_FAILED',
        `Function context could not be built: ${err instanceof Error ? err.message : String(err)}`,
      ),
      route: match.route.displayPath,
      error: err,
    };
  }

  try {
    const result = await handler(request, ctx);
    let response: Response;
    if (result instanceof Response) {
      response = result;
    } else {
      response = new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return { response: attachPendingRefresh(response, ctx), route: match.route.displayPath };
  } catch (err) {
    // Deployed runtime hides the message and points at dashboard Logs; local
    // dev puts the real error in the response — it's the developer's terminal.
    return {
      response: jsonError(
        500,
        'FUNCTION_ERROR',
        `Function handler threw: ${err instanceof Error ? err.message : String(err)}`,
      ),
      route: match.route.displayPath,
      error: err,
    };
  }
}
