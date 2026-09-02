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
import { fallbackProjectServingUrl } from '../lib/project-urls.js';
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
  /** May this account's LOCAL loop read and write the project database?
   *  `null` means the platform did not say — an older platform, or a read that
   *  did not return the field. Never treated as a refusal. */
  localDevDbAllowed: boolean | null;
  /** Plan names that include it, as the platform states them. Empty when the
   *  platform did not say. The CLI never hard-codes a plan list of its own. */
  localDevDbPlans: string[];
}

interface EnvKeyRow {
  key: string;
  scope?: string;
}

/**
 * One row of GET /db/scopes. `intent` is what the platform PROVED about the
 * table — user-owned, shared, server-only, or membership-joined — and it is
 * what the structured query API (`sw.db.from` and friends) asks for before it
 * will compose any SQL. Reading only `owner_column` and dropping the intent is
 * why a `shared()` table came back locally as "this table has no declared
 * intent" while working perfectly on the same deployed project
 * (tsk_a21bc829).
 */
/**
 * Env values the platform provides for a project, resolved for a local run.
 *
 * Anything named here is NOT the developer's to supply, so it must never be
 * reported as a value they forgot. Keep this to keys the platform genuinely
 * writes on their behalf — a key the developer owns belongs in their .env, and
 * silently inventing a value for one would be worse than the warning.
 */
export function platformProvidedEnv(
  ctx: { localOrigin?: string; subdomain?: string | null },
): Record<string, string> {
  const appUrl = ctx.localOrigin ?? fallbackProjectServingUrl({ subdomain: ctx.subdomain ?? null });
  return appUrl ? { APP_URL: appUrl } : {};
}

interface ScopeRow {
  table: string;
  owner_column: string | null;
  intent?: 'scoped' | 'shared' | 'server_only' | 'member';
}

interface ScopesResponse {
  scopes?: ScopeRow[];
  /** 'visitor' when owner() resolves to a stable anonymous visitor for
   *  signed-out requests, which changes who owns a row. */
  owner_identity_mode?: string;
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
  opts: { localOrigin?: string } = {},
): Promise<LocalProjectState> {
  const [project, envResult, scopesResult] = await Promise.all([
    client.call<{
      id: string;
      subdomain: string;
      local_dev_db_allowed?: boolean;
      local_dev_db_required_plans?: string[];
    }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}`,
    ),
    client.call<{ keys?: EnvKeyRow[]; vars?: EnvKeyRow[] }>('GET', '/env', undefined, {
      project_id: projectId,
    }),
    client
      .call<ScopesResponse>('GET', '/db/scopes', undefined, { project_id: projectId })
      .catch(() => ({ scopes: [] as ScopeRow[] }) as ScopesResponse),
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
  // Keys the PLATFORM sets, not the developer. APP_URL is written by deploy
  // and holds wherever the app is being served; the developer never authored
  // it, so reporting it back as one of THEIR missing values sent a first-time
  // user off to write a .env entry for a variable that is not theirs, and
  // devalued every real warning beside it (tsk_6a2a09bc5d).
  //
  // Locally the answer is knowable: the app is being served right here. Fill it
  // with the local origin when there is one, and otherwise with the project's
  // public URL — which is what the platform fills it with, and what run_code
  // already does for the same key.
  for (const [key, value] of Object.entries(
    platformProvidedEnv({ localOrigin: opts.localOrigin, subdomain: project.subdomain }),
  )) {
    if (remoteKeys.includes(key) && !(key in values)) values[key] = value;
  }

  const missingEnvKeys = remoteKeys.filter((k) => !(k in values));

  // The scope bake, mirroring what deploy bakes into a function bundle. Two
  // maps, and the runtime treats a disagreement between them as a bad bundle:
  // PROJECT_SCOPES carries an owner column ONLY for a user-owned table, and
  // every entry in it must have a matching `scoped` intent.
  const scopes: Record<string, string> = {};
  const intents: Record<string, string> = {};
  for (const s of scopesResult.scopes ?? []) {
    const table = s.table.toLowerCase();
    const intent = s.intent ?? (s.owner_column ? 'scoped' : undefined);
    if (!intent) continue;
    intents[table] = intent;
    if (intent === 'scoped' && s.owner_column) scopes[table] = s.owner_column;
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
  // Baked only when there is something to say, exactly like the deploy bundle:
  // an absent binding is the runtime's own "nothing declared" default, and
  // baking an empty map instead would be a different statement.
  if (Object.keys(intents).length > 0) {
    bindings.PROJECT_TABLE_INTENTS = JSON.stringify(intents);
  }
  // Who owns a row on a signed-out request. Baked only for 'visitor', matching
  // deploy — an absent binding reads as 'authenticated'.
  if (scopesResult.owner_identity_mode === 'visitor') {
    bindings.PROJECT_OWNER_IDENTITY_MODE = 'visitor';
  }

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
    localDevDbAllowed: typeof project.local_dev_db_allowed === 'boolean'
      ? project.local_dev_db_allowed
      : null,
    localDevDbPlans: Array.isArray(project.local_dev_db_required_plans)
      ? project.local_dev_db_required_plans.filter((p): p is string => typeof p === 'string')
      : [],
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
