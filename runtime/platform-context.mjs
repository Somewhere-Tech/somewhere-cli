// VENDORED from worker/src/runtime/context.ts (PLATFORM_CONTEXT_JS) @ d8fc42de
// — the exact runtime deployed functions run against. Do not edit by hand;
// re-sync with: node scripts/extract-runtime.mjs <monorepo>
// ── Primordial freeze (tsk_327fe8a4, opinionated-not-greenfield) ───────────
// The structured-query guard, the cookie jars, and the identity path all rely
// on core JavaScript built-ins behaving as specified. Customer/npm code in the
// same bundle could monkey-patch those built-ins to sabotage the platform's own
// guard. Rather than chase every intrinsic the guard touches (a leaky allowlist
// every review round re-broke), we FREEZE the core intrinsic prototypes and
// namespace objects HERE — at the very top of the platform bundle, before any
// (lazy) customer module evaluates. After this, a reassignment like
// JSON.parse = ... or Array.prototype.push = ... is a no-op in sloppy mode and
// throws in strict; either way the platform guard is untouched. Freezing the
// prototypes also blocks Object.prototype pollution. Monkey-patching core
// built-ins is a deprecated, rare practice (a handful of old polyfill packages);
// modern code never needs it and it is explicitly UNSUPPORTED. We freeze only
// what the guard depends on (Reflect/Date are deliberately NOT frozen —
// reflect-metadata / decorator libraries add to Reflect, and the guard no longer
// routes through Reflect). NB: this file is emitted as a template literal — no
// backticks, no unescaped dollar-brace.
(function __sw_freezePrimordials() {
  var frozen = [
    Object.prototype, Array.prototype, Function.prototype,
    String.prototype, RegExp.prototype, Map.prototype,
    Object, Array, JSON,
  ];
  for (var i = 0; i < frozen.length; i++) {
    try { Object.freeze(frozen[i]); } catch (_) { /* already frozen / non-configurable */ }
  }
})();

// sw.auth.me identity memoization bounds. The cache itself is REQUEST-LOCAL
// (declared inside buildPlatformContext) — identity is an authority input,
// and a process-wide cache let a credential revoked server-side keep scoped
// authority inside a warm isolate for up to the TTL (sol MED-2, 2026-08-02).
// No identity crosses requests; every new request re-verifies against the
// platform. TTL still applies within a long-running request: the smaller of
// 60s or (jwt.exp - now - 5s), so a near-expiry token is never returned past
// its real expiry even mid-request.
const __sw_AUTH_ME_TTL_MS = 60_000;
const __sw_AUTH_ME_MAX = 256;

// Thin intrinsic aliases used by the scope/intent/jar/identity decision path.
// The primordial freeze above makes the core built-ins immutable, so these
// call the intrinsics DIRECTLY — no per-method capture / Reflect.apply
// scaffolding chasing individual mutations. They stay as named helpers for
// readability. __sw_objCreateNull() keeps the null-prototype jars (H1
// defense-in-depth): even with Object.prototype frozen against pollution, a
// jar that inherits nothing is the clearest statement of intent.
function __sw_lower(s) { return String(s).toLowerCase(); }
function __sw_reMatch(re, s) { return re.test(s); }
function __sw_own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function __sw_jsonParse(s) { return JSON.parse(s); }
function __sw_objCreateNull() { return Object.create(null); }
function __sw_assign(...args) { return Object.assign(...args); }
function __sw_keys(o) { return Object.keys(o); }
function __sw_arrayIsArray(x) { return Array.isArray(x); }
function __sw_cacheGet(m, k) { return m.get(k); }
function __sw_cacheSet(m, k, v) { return m.set(k, v); }
function __sw_cacheDelete(m, k) { return m.delete(k); }
function __sw_cacheKeys(m) { return m.keys(); }
function __sw_cacheSize(m) { return m.size; }

// Per-isolate marker for database latency messaging. buildPlatformContext runs
// once per request, so this must stay at module scope: only the first database
// query after a runtime cold start should receive the first-touch label.
let __sw_hasCompletedDbQuery = false;

// ── W3C trace context, runtime side (tsk_47a2a3f6) ─────────────────────────
// A deployed function is the ROOT of the trace for the request it serves.
// Every platform call it makes carries `traceparent`, so the platform's own
// span for that call lands as a CHILD of the operation that made it — which is
// what turns N unrelated HTTP requests into one ordered waterfall.
//
// Every function here is best-effort. Tracing must never throw into a
// customer's request: each entry point is wrapped, and on any failure the
// request proceeds untraced rather than failing.
const __sw_TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const __sw_MAX_CLIENT_SPANS = 200;

function __sw_randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

function __sw_parseTraceparent(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length < 55) return null;
  const head = value.slice(0, 55);
  const m = __sw_TRACEPARENT_RE.exec(head);
  if (!m) return null;
  if (m[1] === 'ff') return null;
  if (m[1] === '00' && value.length !== 55) return null;
  if (m[1] !== '00' && value.length > 55 && value[55] !== '-') return null;
  if (m[2] === '00000000000000000000000000000000' || m[3] === '0000000000000000') return null;
  return { traceId: m[2], parentSpanId: m[3], sampled: (parseInt(m[4], 16) & 1) === 1 };
}

// Collapse a platform API path to the sw.* operation a developer wrote.
// '/v1/db/query' -> 'sw.db.query'; '/v1/fs/<id>/read' -> 'sw.fs.read'.
// Ids are dropped so the waterfall groups by operation instead of exploding
// into one distinct name per row.
function __sw_traceOpName(path) {
  try {
    const clean = String(path).split('?')[0];
    if (clean.indexOf('/v1/') !== 0) return clean;
    const segs = clean.slice(4).split('/').filter(function (s) {
      if (!s) return false;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return false; // uuid
      if (/^[0-9a-f]{16,}$/i.test(s)) return false;           // opaque hex id
      if (/^\d+$/.test(s)) return false;                      // numeric id
      return true;
    });
    return 'sw.' + segs.slice(0, 3).join('.');
  } catch (_) {
    return 'platform.call';
  }
}

function __sw_initTrace(request) {
  try {
    const inbound = __sw_parseTraceparent(request.headers.get('traceparent'));
    return {
      traceId: inbound ? inbound.traceId : __sw_randHex(16),
      spanId: __sw_randHex(8),
      parentSpanId: inbound ? inbound.parentSpanId : null,
      // A function has no sampling policy of its own. An inbound decision to
      // DROP is honored; otherwise this is "no opinion", not "store this" --
      // the platform applies TRACE_SAMPLE_RATE deterministically on the trace
      // id, both on its own hops and when these spans are posted to
      // /v1/traces, so the whole chain is kept or dropped together
      // (tsk_07a7465a). Before that this true was load-bearing and exempted
      // every runtime-originated request from sampling entirely.
      sampled: inbound ? inbound.sampled : true,
      tracestate: __sw_traceHeader(request, 'tracestate', 512),
      baggage: __sw_traceHeader(request, 'baggage', 8192),
      spans: [],
      dropped: 0,
    };
  } catch (_) {
    return null;
  }
}

function __sw_traceHeader(request, name, maxLength) {
  try {
    const value = request.headers.get(name);
    if (!value || value.length > maxLength || /[\r\n]/.test(value)) return null;
    return value;
  } catch (_) { return null; }
}

function __sw_traceRecord(trace, span) {
  if (!trace) return;
  if (trace.spans.length >= __sw_MAX_CLIENT_SPANS) { trace.dropped += 1; return; }
  trace.spans.push(span);
}

function __sw_b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

// Pre-flight: parse the JWT shape and check exp. Throws an AUTH_ERROR
// for malformed / expired tokens so we never even attempt the network
// call for obviously-bad input.
// Pull a named cookie out of a Cookie header. Returns the raw value
// (URL-decoded) or null. Used by sw.auth.fromRequest + anonSession so
// every demo doesn't reinvent cookie parsing.
function __sw_readCookie(header, name) {
  if (!header || typeof header !== 'string') return null;
  // Match name= surrounded by start, ;, or whitespace. Encoded chars
  // (e.g. %3D) are tolerated in the value — we strip surrounding
  // whitespace and decodeURIComponent at the end.
  const re = new RegExp('(?:^|;\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)');
  const m = header.match(re);
  if (!m) return null;
  const v = m[1].trim();
  if (!v) return null;
  try { return decodeURIComponent(v); } catch (_) { return v; }
}

function __sw_cookieHeaderHasName(header, name) {
  if (!header || typeof header !== 'string') return false;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(0, eq).trim() === name) return true;
  }
  return false;
}

// Pull a Bearer token out of an Authorization header. Returns the raw
// JWT or null. Used by fromRequest as the fall-back to cookie auth.
function __sw_readBearer(header) {
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^bearer\s+(.+)$/i);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

function __sw_preflightJwt(token) {
  const pre = __sw_preflightJwtAllowExpired(token);
  if (pre.expired) {
    const err = new Error('sw.auth.me: token expired');
    err.code = 'AUTH_ERROR';
    err.status = 401;
    throw err;
  }
  return pre;
}

// Same shape parser as __sw_preflightJwt but does NOT throw on expiry —
// it returns { expired: true } instead so the header-based auto-refresh
// flow can decide whether to send the request to the platform with
// X-Refresh-Token attached.
function __sw_preflightJwtAllowExpired(token) {
  if (typeof token !== 'string' || !token) {
    const err = new Error('sw.auth.me: token is required');
    err.code = 'AUTH_ERROR';
    err.status = 401;
    throw err;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    const err = new Error('sw.auth.me: token is not a JWT');
    err.code = 'AUTH_ERROR';
    err.status = 401;
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(__sw_b64urlDecode(parts[1]));
  } catch (_) {
    const err = new Error('sw.auth.me: token payload is not JSON');
    err.code = 'AUTH_ERROR';
    err.status = 401;
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  const expSec = typeof payload.exp === 'number' ? payload.exp : 0;
  return { sig: parts[2], expSec, expired: expSec > 0 && expSec <= now };
}

// devFsEnabled is set BY THE CALLER — the run_code harness passes true at its
// own entrypoint (a separate, developer-authenticated worker); the function
// bundle (fetch handlers, and the cron/queue/job invocations delivered to them
// over HTTP) never passes it. sol round 6: the project/developer file view
// (sw.fs.dev) is CONSTRUCTED at the entrypoint that is structurally allowed to
// have it, never derived afterward from anything the request carries. A request
// cannot forge its way into being a run_code invocation, so there is no signal
// to replay. Customer code only ever receives the built sw object; it never
// reaches buildPlatformContext, so it cannot set this flag.
function buildPlatformContext(env, request, runtimeFetch = fetch, outboundFetch = runtimeFetch, devFsEnabled = false, existingTrace = null) {
  const __sw_runtimeFetch = runtimeFetch;
  const __sw_outboundFetch = outboundFetch;
  const projectId = env.PROJECT_ID;
  const draftId = request.headers.get('X-Sw-Draft-Id') || null;
  const draftCandidateReleaseId = request.headers.get('X-Sw-Draft-Candidate') || null;
  if ((draftId === null) !== (draftCandidateReleaseId === null)) {
    const err = new Error('The draft execution identity is incomplete, so no platform resource was selected.');
    err.code = 'DRAFT_CONTEXT_INVALID';
    err.status = 503;
    err.__sw_expose = true;
    throw err;
  }
  const isDraftExecution = draftId !== null;
  const projectEnv = isDraftExecution ? 'draft' : (env.PROJECT_ENV || 'dev');
  const platformDomain = env.PLATFORM_DOMAIN || 'somewhere.tech';
  const tenantDomain = env.TENANT_DOMAIN || platformDomain;
  const platformBase = env.PLATFORM_API_BASE || ('https://api.' + platformDomain);
  const apiKey = env.PROJECT_API_KEY;
  // A durable sw.agent callback re-enters the customer's own route. Preserve
  // a private clone before user code consumes req.body so the agent runtime
  // can verify and read the signed checkpoint independently.
  const __sw_internalInvocationRequest = request.headers.get('X-Somewhere-Signature')
      && request.headers.get('X-Somewhere-Invocation-Timestamp')
      && (request.headers.get('X-Somewhere-Job-Id') || request.headers.get('X-Somewhere-Message-Id'))
    ? request.clone()
    : null;
  const __sw_agentInvocationRequest = request.headers.get('X-Somewhere-Agent-Invocation') === '1'
      && __sw_internalInvocationRequest
    ? __sw_internalInvocationRequest.clone()
    : null;

  // Root trace for this invocation. Adopted from the caller when one was
  // propagated in (a browser or an upstream service that speaks W3C trace
  // context), otherwise minted here.
  const __sw_trace = existingTrace || __sw_initTrace(request);

  async function platformFetch(path, opts) {
    opts = opts || {};
    if (path === '/v1/db/query' || path === '/v1/db/batch' || path === '/v1/db/raw-read') {
      __sw_enforceAmbientCookieCsrf();
    }
    // One child span per platform call, measured caller-side so it includes
    // the network hop the platform's own server span cannot see.
    const __sw_spanId = __sw_trace ? __sw_randHex(8) : null;
    const __sw_spanStart = Date.now();
    const headers = {
      ...(opts.headers || {}),
      'Authorization': 'Bearer ' + apiKey,
      ...(__sw_trace ? {
        traceparent: '00-' + __sw_trace.traceId + '-' + __sw_spanId + '-' + (__sw_trace.sampled ? '01' : '00'),
        ...(__sw_trace.tracestate ? { tracestate: __sw_trace.tracestate } : {}),
        ...(__sw_trace.baggage ? { baggage: __sw_trace.baggage } : {}),
      } : {}),
      // tsk_95ecae23 — tell the platform which execution slot this bundle is
      // running in (prod vs dev), so the REST-fallback data path (/v1/db/query,
      // /v1/db/batch) and the direct `dev --local` client select the DEV data
      // slot instead of silently defaulting to prod. The slot is baked into the
      // bundle at deploy/run time as PROJECT_ENV (see function-bundle.ts /
      // code-bundle.ts); 'dev' for legacy/local tools, 'draft' for an exact
      // session candidate, and 'prod' for the promoted production bundle. The server only DIVERTS off prod when the
      // project is enrolled in DEV_SLOT_ENFORCE_PROJECTS, so an unenrolled
      // project sees this header but its binding is unchanged.
      'X-Sw-Env-Slot': projectEnv,
      ...(isDraftExecution ? {
        'X-Sw-Draft-Id': draftId,
        'X-Sw-Draft-Candidate': draftCandidateReleaseId,
      } : {}),
    };
    if (opts.body && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    const __sw_method = opts.method || 'GET';
    let __sw_response;
    try {
      __sw_response = await __sw_runtimeFetch(platformBase + path, {
        method: __sw_method,
        headers,
        body: opts.body,
      });
    } catch (err) {
      // A transport failure is exactly the operation an agent came to find,
      // so it is recorded — then rethrown UNCHANGED. Tracing observes; it
      // never swallows, retries, or reshapes the caller's error.
      if (__sw_trace) {
        __sw_traceRecord(__sw_trace, {
          span_id: __sw_spanId,
          trace_id: __sw_trace.traceId,
          parent_span_id: __sw_trace.spanId,
          name: __sw_traceOpName(path),
          kind: 'client',
          started_at: __sw_spanStart,
          duration_ms: Date.now() - __sw_spanStart,
          status: 'error',
          error_code: (err && err.code) || 'PLATFORM_UNREACHABLE',
          attributes: { 'http.method': __sw_method },
        });
      }
      throw err;
    }
    if (__sw_trace) {
      __sw_traceRecord(__sw_trace, {
        span_id: __sw_spanId,
        trace_id: __sw_trace.traceId,
        parent_span_id: __sw_trace.spanId,
        name: __sw_traceOpName(path),
        kind: 'client',
        started_at: __sw_spanStart,
        duration_ms: Date.now() - __sw_spanStart,
        status: __sw_response.status >= 400 ? 'error' : 'ok',
        error_code: __sw_response.status >= 400 ? 'HTTP_' + __sw_response.status : null,
        attributes: { 'http.method': __sw_method, 'http.status_code': __sw_response.status },
      });
    }
    return __sw_response;
  }

  async function platformJSON(path, opts) {
    const r = await platformFetch(path, opts);
    let data;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok || !data || data.ok === false) {
      const code = (data && (data.code || data.error)) || 'PLATFORM_ERROR';
      // A 402 INSUFFICIENT_BALANCE or PAID_API_NOT_ACTIVATED is the same
      // error an app's end user can trigger, and apps routinely echo
      // err.message to end users. Never surface the owner-framed billing
      // prose (or the owner dashboard URL) — keep the real code/status on
      // the error object for the developer's own logging (sw.logs /
      // console.error), but the message stays neutral (tsk_8a4809cf,
      // tsk_d4224d57).
      const msg = (r.status === 402 && (code === 'INSUFFICIENT_BALANCE' || code === 'PAID_API_NOT_ACTIVATED' || code === 'PAID_AI_DISABLED'))
        ? 'This AI feature is temporarily unavailable. Please try again later.'
        : ((data && data.message) || ('Platform call failed: ' + r.status));
      const err = new Error(msg);
      err.code = code;
      err.status = r.status;
      if (data && data.retry_after_ms !== undefined) err.retry_after_ms = data.retry_after_ms;
      if (data && data.retry !== undefined) err.retry = data.retry;
      throw err;
    }
    return data.data;
  }

  // fs paths accept both '/avatars/x.png' and 'avatars/x.png' — code ported
  // from Supabase storage never uses the leading slash. A missing slash used
  // to glue the path onto the projectId in the URL ('/v1/fs/<id>avatars/…')
  // → malformed route → opaque "fs.write failed: 403" (pfb_06445ed51a8b).
  function __sw_fsPath(path) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('sw.fs: path must be a non-empty string (got ' + (path === '' ? 'an empty string' : typeof path) + ')');
    }
    return path.startsWith('/') ? path : '/' + path;
  }

  // Header-based auto-refresh stash. When sw.auth.fromRequest or
  // sw.auth.me sees a paired X-Refresh-Token on the inbound request
  // and the platform mints a new pair (returned via X-New-Access-Token
  // / X-New-Refresh-Token on the /v1/auth/me response), we park the
  // new pair here. The function shim (generateIndexModule) reads this
  // after the user handler returns and attaches the same two headers
  // to the user's outbound Response — so the dev's function does zero
  // refresh work.
  const __sw_pendingRefresh = { access: null, refresh: null };

  // REQUEST-LOCAL identity memoization for sw.auth.me — keyed by the JWT
  // signature segment. The map dies with the request, so a revoked credential
  // can never resolve from a previous request's verification (sol MED-2).
  const __sw_authMeCache = new Map();
  // REQUEST-LOCAL single-flight for sw.auth.me — keyed by the JWT signature.
  // The TTL cache above is SKIPPED on the expired+refresh path, so without this
  // a request that resolves the principal twice (sw.auth.requireUser AND the
  // sw.db scoped-query resolver) fired TWO independent /v1/auth/me calls — i.e.
  // TWO auto-refreshes of the SAME refresh token. Against single-use rotation
  // the second read as reuse and revoked the whole session (tsk_786aba5e). This
  // map holds the in-flight/settled me() PROMISE per signature so every lookup
  // in one request — cached path or refresh path — shares ONE verification.
  const __sw_authMeInflight = new Map();

  // Private best-effort control-plane work started after a customer operation
  // has already succeeded. The generated request shim transfers every promise
  // to executionCtx.waitUntil before returning the response, so accounting can
  // finish without adding latency to (or changing) the committed DB result.
  const __sw_pendingBackground = [];

  // httpOnly cookie sessions (sw.auth.*WithCookie, tsk_1288e1c6). Auth cookies
  // produced during the handler are parked here; the shim attaches them as
  // Set-Cookie on the outbound Response post-handler (Option B — invisible, the
  // dev never touches headers). The cookie persists 30d; the access JWT inside
  // expires ~15min and fromRequest auto-refreshes it from the refresh cookie,
  // re-issuing fresh cookies — so the browser stays logged in across restarts.
  const __sw_pendingCookies = [];
  const __SW_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
  let __sw_legacyAuthCookiesExpired = false;
  function __sw_authCookie(name, value, maxAge) {
    return name + '=' + encodeURIComponent(value) +
      '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + maxAge;
  }
  function __sw_expireLegacyAuthCookies(requestUrl) {
    if (__sw_legacyAuthCookiesExpired) return;
    __sw_legacyAuthCookiesExpired = true;

    // Hard cutover: these names are never authority inputs again. Drain the
    // old host-only scope and, on the shared tenant domain, the attacker-
    // writable parent scope. The request is still unauthenticated unless a
    // browser-enforced __Host- credential is independently present.
    __sw_pendingCookies.push(__sw_authCookie('token', '', 0));
    __sw_pendingCookies.push(__sw_authCookie('auth_token', '', 0));
    __sw_pendingCookies.push(__sw_authCookie('session', '', 0));
    __sw_pendingCookies.push(__sw_authCookie('refresh_token', '', 0));
    __sw_pendingCookies.push(__sw_authCookie('sw_refresh_token', '', 0));
    __sw_pendingCookies.push(__sw_authCookie('sw_anon_id', '', 0));

    try {
      const host = new URL(requestUrl || '').hostname.toLowerCase();
      const tenantDomain = String(env.TENANT_DOMAIN || 'somewhere.site')
        .toLowerCase().replace(/^\./, '');
      if (tenantDomain && (host === tenantDomain || host.endsWith('.' + tenantDomain))) {
        const attrs = '; Domain=.' + tenantDomain + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
        __sw_pendingCookies.push('token=' + attrs);
        __sw_pendingCookies.push('auth_token=' + attrs);
        __sw_pendingCookies.push('session=' + attrs);
        __sw_pendingCookies.push('refresh_token=' + attrs);
        __sw_pendingCookies.push('sw_refresh_token=' + attrs);
        __sw_pendingCookies.push('sw_anon_id=' + attrs);
      }
    } catch (_) { /* host-only expirations above still apply */ }
  }
  function __sw_expireLegacyAuthCookiesIfPresent(cookieHeader, requestUrl) {
    if (
      __sw_cookieHeaderHasName(cookieHeader, 'token')
      || __sw_cookieHeaderHasName(cookieHeader, 'auth_token')
      || __sw_cookieHeaderHasName(cookieHeader, 'session')
      || __sw_cookieHeaderHasName(cookieHeader, 'refresh_token')
      || __sw_cookieHeaderHasName(cookieHeader, 'sw_refresh_token')
      || __sw_cookieHeaderHasName(cookieHeader, 'sw_anon_id')
    ) {
      __sw_expireLegacyAuthCookies(requestUrl);
    }
  }
  function __sw_setAuthCookies(access, refresh) {
    // __Host- is browser-enforced: Secure + Path=/ + no Domain attribute.
    __sw_pendingCookies.push(__sw_authCookie('__Host-token', access, __SW_COOKIE_MAX_AGE));
    __sw_pendingCookies.push(__sw_authCookie('__Host-sw_refresh_token', refresh, __SW_COOKIE_MAX_AGE));
    try {
      const cookieHeader = request && request.headers && request.headers.get('cookie');
      __sw_expireLegacyAuthCookiesIfPresent(cookieHeader, request && request.url);
    } catch (_) { /* the canonical session pair is already staged */ }
  }
  function __sw_clearAuthCookies(requestUrl) {
    __sw_pendingCookies.push(__sw_authCookie('__Host-token', '', 0));
    __sw_pendingCookies.push(__sw_authCookie('__Host-sw_refresh_token', '', 0));
    __sw_expireLegacyAuthCookies(requestUrl || (request && request.url));
  }

  // Expected-failure marking for the cookie helpers (tsk_a5f3e7d3). The
  // routing shim's catch-all turns every uncaught throw into an opaque 500
  // FUNCTION_ERROR — right for real bugs, wrong for "wrong password": the
  // doc'd cookie snippet has no try/catch, so every expected auth failure
  // surfaced as a 500 (and fed the 5xx-based uptime alerting). An error
  // flagged here carries a customer-safe message from the platform auth
  // API; the shim returns it as a structured 4xx with the real code +
  // message instead. Platform 5xx and anything unflagged stay opaque.
  function __sw_markExpected(err) {
    if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      err.__sw_expose = true;
    }
    return err;
  }

  // Arg-shape forgiveness for the cookie helpers (tsk_3bc373ea): every other
  // sw.auth method takes one options object, so agents naturally pass one
  // here too — and req is never read by these helpers. Accepted shapes:
  //   (req, email, password)      — documented positional form
  //   (req, email, password, { display_name? })
  //   (req, { email, password, display_name? })
  //   ({ email, password, display_name? })       — req omitted
  // Anything else throws a 400 VALIDATION_ERROR naming the supported shapes,
  // surfaced as a structured 4xx via __sw_expose (never INTERNAL_ERROR/500).
  function __sw_cookieCreds(method, req, email, password, extra) {
    let opts = null;
    if (email !== null && typeof email === 'object') {
      opts = email;
      password = email.password;
      email = email.email;
    } else if (req !== null && typeof req === 'object' &&
               !(req.headers && typeof req.headers.get === 'function') &&
               email === undefined && password === undefined) {
      opts = req;
      password = req.password;
      email = req.email;
    }
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
      const shapes = method === 'signupWithCookie'
        ? method + '(req, email, password), ' + method + '(req, email, password, opts), or ' +
          method + '(req, { email, password })'
        : method + '(req, email, password) or ' + method + '(req, { email, password })';
      const err = new Error('sw.auth.' + method + ': email and password are required — call ' + shapes + '.');
      err.code = 'VALIDATION_ERROR';
      err.status = 400;
      err.__sw_expose = true;
      throw err;
    }
    const creds = { email: email, password: password };
    if (method === 'signupWithCookie') {
      if (!opts && extra !== undefined) {
        opts = (extra !== null && typeof extra === 'object') ? extra : { display_name: extra };
      }
      if (opts) {
        const displayName = opts.display_name !== undefined ? opts.display_name
          : opts.displayName !== undefined ? opts.displayName
          : opts.full_name !== undefined ? opts.full_name
          : opts.fullName !== undefined ? opts.fullName
          : opts.name;
        if (displayName !== undefined) creds.display_name = displayName;
      }
    }
    if (method === 'signupWithCookie' && opts) {
      for (const k of ['display_name', 'locale', 'timezone', 'turnstile_token']) {
        if (opts[k] !== undefined) creds[k] = opts[k];
      }
    }
    return creds;
  }

  // Response contract (tsk_72c4b4d2, A-F05): a sign-in/profile success MUST
  // carry a user object — the cookie helpers wrap it as { user }. An upstream
  // success body without one is a platform fault; throwing here (instead of
  // returning a bare object or null) removes the ambiguous 200-with-null
  // success state the usability audit caught.
  function __sw_requireAuthUser(method, d) {
    if (d && d.user && typeof d.user === 'object') return d.user;
    const err = new Error('sw.auth.' + method + ': the platform sign-in response did not include a user object. This is a platform fault, not an error in your code — report it via support_ticket.');
    err.code = 'AUTH_RESPONSE_MALFORMED';
    err.status = 502;
    throw err;
  }

  // Cross-origin gate for cookie sessions (tsk_1dd4e1b4, tsk_272ce30,
  // tsk_67661784). SameSite=Lax does not isolate sibling projects under the
  // shared .tech or .site project domains, so cookie auth must independently
  // enforce the browser origin boundary.
  //   - Writes (POST/PUT/PATCH/DELETE): require and are checked against
  //     Origin (CSRF). Referer is never accepted in place of Origin.
  //   - Reads (GET/HEAD): checked only when an explicit CORS Origin header
  //     is present (credentialed cross-origin fetch). Top-level navigations
  //     carry no Origin and stay allowed — that's exactly what Lax intends —
  //     and their Referer legitimately names the previous, often foreign,
  //     page, so Referer is ignored for reads.
  //   - Unsafe cookie-auth writes missing Origin return ORIGIN_REQUIRED.
  //   - Cross-origin source mismatches return a typed 403. An internal marker
  //     from the web edge preserves exact configured origins and projects
  //     grandfathered by migration 0218; inbound spoofed markers are stripped
  //     before customer dispatch.
  //   - Same-origin requests and Bearer-header auth are unaffected.
  function __sw_isUnsafeCookieMethod(method) {
    method = (method || 'GET').toUpperCase();
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  }

  function __sw_cookieOriginRequired(req) {
    if (!__sw_isUnsafeCookieMethod(req.method || 'GET')) return false;
    return !(req.headers.get('Origin') || req.headers.get('origin'));
  }

  function __sw_cookieCsrfAssessment(req) {
    const method = (req.method || 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    let src = req.headers.get('Origin') || req.headers.get('origin');
    if (!src && !isRead) src = req.headers.get('Referer') || req.headers.get('referer');
    if (!src) return { wouldBlock: false, reason: 'no_source_header', source: null, sourceHost: null, requestHost: null };
    if ((req.headers.get('X-Sw-Cors-Authorized') || req.headers.get('x-sw-cors-authorized')) === '1') {
      return { wouldBlock: false, reason: 'allowed_origin', source: src, sourceHost: null, requestHost: null };
    }
    let srcUrl, reqUrl;
    try {
      // 'null' (opaque origin: sandboxed iframe, data: page) fails to parse
      // and is rejected — a same-site sandboxed page still sends the cookie
      // under Lax, so it must never authenticate.
      srcUrl = new URL(src);
      reqUrl = new URL(req.url);
    } catch (_) {
      return { wouldBlock: true, reason: 'bad_source_origin', source: src, sourceHost: null, requestHost: null };
    }
    if (src !== srcUrl.origin) {
      return { wouldBlock: true, reason: 'bad_source_origin', source: src, sourceHost: null, requestHost: null };
    }
    const srcHost = srcUrl.hostname.toLowerCase();
    const reqHost = reqUrl.hostname.toLowerCase();
    if (srcUrl.origin === reqUrl.origin) {
      return { wouldBlock: false, reason: 'same_origin', source: src, sourceHost: srcHost, requestHost: reqHost };
    }
    if (srcUrl.protocol !== reqUrl.protocol) {
      return { wouldBlock: true, reason: 'cross_site', source: src, sourceHost: srcHost, requestHost: reqHost };
    }
    if ([platformDomain, tenantDomain].some(function (domain) {
      return srcHost === domain || reqHost === domain
        || srcHost.slice(-(domain.length + 1)) === '.' + domain
        || reqHost.slice(-(domain.length + 1)) === '.' + domain;
    })) {
      return { wouldBlock: true, reason: 'platform_sibling', source: src, sourceHost: srcHost, requestHost: reqHost };
    }
    // Customer parent/subdomain relationships are not origin authority.
    // Exact server-derived or configured origins arrive via the edge marker.
    return { wouldBlock: true, reason: 'cross_site', source: src, sourceHost: srcHost, requestHost: reqHost };
  }

  function __sw_recordCookieCsrfBlocked(req, assessment) {
    try {
      const key = String(projectId || 'unknown');
      const g = globalThis.__sw_csrfBlockedCounts || (globalThis.__sw_csrfBlockedCounts = {});
      g[key] = (g[key] || 0) + 1;
      const pathname = (function () { try { return new URL(req.url).pathname; } catch (_) { return ''; } })();
      console.warn('[CSRF_BLOCKED] cookie-authed ' + (req.method || 'GET') + ' ' + pathname +
        ' rejected (' + assessment.reason + ').');
      platformFetch('/v1/logs', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          level: 'warn',
          message: 'Cookie-session cross-origin request blocked: ' + assessment.reason,
          source: 'server',
          data: {
            kind: 'csrf_blocked',
            count: g[key],
            method: req.method || 'GET',
            path: pathname,
            reason: assessment.reason,
            source_host: assessment.sourceHost,
            request_host: assessment.requestHost,
          },
        }),
      }).catch(function () {});
    } catch (_) { /* telemetry must never affect auth */ }
  }

  function __sw_enforceCookieCsrf(req) {
    if (__sw_cookieOriginRequired(req)) {
      // Name the header AND both remedies. The old copy pointed only at
      // "API-key authenticated requests", which sends a non-browser caller
      // toward a developer key that is wrong for per-user calls and is itself
      // rejected from a browser context. State what the caller can actually do.
      const err = new Error(
        "This " + (req.method || "POST").toUpperCase() + " was authenticated by a session cookie, "
        + "so it must include an Origin header naming the site it came from. Browsers always send one. "
        + "A non-browser client (a script, an agent, or a server-side caller) must either send that same "
        + "Origin header explicitly, or stop sending the session cookie and pass the user token in an "
        + "Authorization: Bearer header instead, which is not origin-checked."
      );
      err.code = 'ORIGIN_REQUIRED';
      err.status = 400;
      throw __sw_markExpected(err);
    }
    const assessment = __sw_cookieCsrfAssessment(req);
    if (!assessment || !assessment.wouldBlock) return;
    __sw_recordCookieCsrfBlocked(req, assessment);
    const err = new Error('Cookie-authenticated cross-origin requests are not allowed for this origin.');
    err.code = 'CROSS_ORIGIN_COOKIE_AUTH_FORBIDDEN';
    err.status = 403;
    throw __sw_markExpected(err);
  }

  // THE verified request identity (tsk_5b91e0e4). Assigned by the sw.auth
  // namespace; resolves the same way sw.auth.fromRequest does and returns
  // { user, id, role } — id/role captured from the verification result before
  // any object reaches customer code. sw.db calls it lazily with this
  // context's own `request`, so a structured query on a user-owned table is
  // scoped by the platform, never by anything the handler passes in.
  let __sw_authResolveRequest = null;
  // The same identity spine under an intent-named handle. Runtime v2 surfaces
  // (tsk_327fe8a4) call this with (request, { forwardedToken }) to accept the
  // second credential transport; it verifies identically to the request-
  // attached path. Assigned by the sw.auth namespace alongside the resolver.
  let __sw_authVerifyPrincipal = null;
  // Ambient visitor identity for owner()-scoped structured queries on
  // visitor-mode projects (tsk_99bec0b4). Assigned by the sw.auth namespace;
  // sw.db calls it (through a memo) ONLY when there is no verified user AND the
  // baked owner-identity mode is 'visitor'. Reads/mints the __Host-sw_anon_id cookie
  // from the SAME frozen snapshot identity is derived from, and queues the
  // Set-Cookie itself. Never throws; returns a stable { id } for this visitor.
  let __sw_resolveVisitorIdentity = null;

  // Runtime v2 (tsk_327fe8a4, sol P0-3): SNAPSHOT the auth-bearing request state
  // ONCE, synchronously, before any customer code can touch the Request object.
  // Authority is derived from this frozen snapshot — never re-read from the
  // customer-visible (mutable) Request — so overriding req.headers.get to null
  // can no longer downgrade a scoped end-user to the trusted-project principal.
  // sw.auth.fromRequest(req) with an EXPLICIT request is unchanged (the caller
  // chose that request); only the context's own closed-over identity snapshots.
  const __sw_authHeaderSnapshot = (function () {
    const names = ['cookie', 'authorization', 'origin', 'referer',
      'x-no-auto-refresh', 'x-refresh-token', 'sec-fetch-site',
      'x-sw-cors-authorized'];
    const map = Object.create(null);
    try {
      if (request && request.headers && typeof request.headers.get === 'function') {
        for (const n of names) {
          const v = request.headers.get(n);
          if (v != null) map[n] = v;
        }
      }
    } catch (_) { /* fail-closed: an unreadable header snapshot yields no identity */ }
    return map;
  })();
  const __sw_authSnapshotRequest = {
    url: (request && request.url) || '',
    method: (request && request.method) || 'GET',
    headers: {
      get(name) {
        const k = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(__sw_authHeaderSnapshot, k)
          ? __sw_authHeaderSnapshot[k]
          : null;
      },
    },
  };
  function __sw_enforceAmbientCookieCsrf() {
    const cookieHeader = __sw_authSnapshotRequest.headers.get('cookie') || '';
    for (const name of ['__Host-token', '__Host-auth_token', '__Host-session']) {
      if (__sw_readCookie(cookieHeader, name)) {
        __sw_enforceCookieCsrf(__sw_authSnapshotRequest);
        return;
      }
    }
  }
  const __sw_nativeProjectDb = env.PROJECT_DB;
  if (__sw_nativeProjectDb) {
    const __sw_guardedProjectDb = new Proxy(__sw_nativeProjectDb, {
      get(target, property) {
        const value = target[property];
        if ((property !== 'prepare' && property !== 'batch') || typeof value !== 'function') return value;
        return function () {
          __sw_enforceAmbientCookieCsrf();
          return value.apply(target, arguments);
        };
      },
    });
    env = new Proxy(env, {
      get(target, property) {
        return property === 'PROJECT_DB' ? __sw_guardedProjectDb : target[property];
      },
    });
  }
  // Project-runtime authority is an ACTUAL credential on the immutable
  // inbound request, not the absence of an app-user credential. This exact
  // comparison is available only inside the generated closure: customer code
  // cannot read PROJECT_API_KEY or set this result. Surfaces with an explicit
  // trusted project path can also select it structurally.
  function __sw_hasRuntimeProjectAuthority() {
    const authorization = __sw_authSnapshotRequest.headers.get('authorization');
    return typeof apiKey === 'string' && apiKey.length > 0
      && authorization === 'Bearer ' + apiKey;
  }

  // Runtime v2 (sol P0-3): resolve the request's VERIFIED principal ONCE,
  // through the identity chokepoint (__sw_authVerifyPrincipal — the seven
  // checks), against the immutable snapshot, and memoize. Every derive helper
  // reads THIS one resolution. Never a second verification: it funnels through
  // the request-local single-flight me(). This resolves USER identity for
  // user-owned ops — it does NOT decide sw.fs.dev, which is constructed only at
  // the run_code entrypoint (devFsEnabled) and is absent in every HTTP-reached
  // context, never keyed on anything the request carries (sol round 6).
  let __sw_identityPromise = null;
  let __sw_verifiedSubjectProof = null;
  async function __sw_resolveSignedInvocationIdentity() {
    if (!__sw_internalInvocationRequest) return null;
    const req = __sw_internalInvocationRequest;
    const body = await req.clone().text();
    const source = req.headers.get('X-Somewhere-Invocation-Source') || req.headers.get('X-Somewhere-Source') || 'job';
    const invocationId = req.headers.get('X-Somewhere-Job-Id') || req.headers.get('X-Somewhere-Message-Id') || '';
    const timestamp = req.headers.get('X-Somewhere-Invocation-Timestamp') || '';
    const bodySha256 = req.headers.get('X-Somewhere-Body-SHA256') || '';
    const signature = req.headers.get('X-Somewhere-Signature') || '';
    try {
      const verified = await platformJSON('/v1/jobs/verify-invocation', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          source,
          invocation_id: invocationId,
          target_method: req.method,
          target_path: new URL(req.url).pathname,
          timestamp,
          body,
          body_sha256: bodySha256,
          signature,
        }),
      });
      if (!verified || verified.subject_type !== 'app_user'
          || typeof verified.subject_id !== 'string' || !verified.subject_id
          || typeof verified.subject_proof !== 'string' || !verified.subject_proof) return null;
      __sw_verifiedSubjectProof = verified.subject_proof;
      return { user: null, id: verified.subject_id, role: 'user' };
    } catch (_) {
      return null;
    }
  }
  function __sw_resolveIdentityOnce() {
    if (!__sw_identityPromise) {
      __sw_identityPromise = Promise.resolve().then(function () {
        return __sw_authVerifyPrincipal ? __sw_authVerifyPrincipal(__sw_authSnapshotRequest) : null;
      }).then(function (principal) {
        return principal || __sw_resolveSignedInvocationIdentity();
      }).catch(function () { return null; });
    }
    return __sw_identityPromise;
  }

  function __sw_snapshotAppToken() {
    const cookieHeader = __sw_authSnapshotRequest.headers.get('cookie') || '';
    for (const name of ['__Host-token', '__Host-auth_token', '__Host-session']) {
      const token = __sw_readCookie(cookieHeader, name);
      if (token) return token;
    }
    return __sw_readBearer(__sw_authSnapshotRequest.headers.get('authorization'));
  }

  async function __sw_runtimeSubjectHeaders(authorityHeader, subjectlessAuthority, forceProject) {
    const subject = forceProject ? null : await __sw_optionalSubject();
    if (!subject) return { [authorityHeader]: subjectlessAuthority };
    const appToken = __sw_pendingRefresh.access || __sw_snapshotAppToken();
    const proofHeaders = appToken
      ? { 'X-App-Token': appToken }
      : (__sw_verifiedSubjectProof ? { 'X-Somewhere-Subject-Proof': __sw_verifiedSubjectProof } : null);
    if (!proofHeaders) {
      const err = new Error('The verified app-user subject could not be carried to the platform.');
      err.code = 'AUTHORITY_UNAVAILABLE';
      err.status = 503;
      throw __sw_markExpected(err);
    }
    return {
      [authorityHeader]: 'app_user',
      'X-Somewhere-Acting-Subject': String(subject),
      ...proofHeaders,
    };
  }

  // The ONE "derive the acting subject" helper every user-owned surface routes
  // through — the parsimonious core, not a per-method guard. Resolves the
  // verified principal FROM THE SNAPSHOT, or fails closed with a typed
  // AUTH_REQUIRED before any side effect. No surface accepts a caller-supplied id.
  async function __sw_requireSubject(label) {
    const p = await __sw_resolveIdentityOnce();
    if (!p || !p.id) {
      const err = new Error((label || 'This operation') + ' requires a signed-in user.');
      err.code = 'AUTH_REQUIRED';
      err.status = 401;
      throw __sw_markExpected(err);
    }
    return p.id;
  }
  // The nullable form — the acting subject or null, no throw. For surfaces
  // whose "no verified user" branch is a legitimate server/developer path
  // (e.g. sw.fs.read of a project-owned asset), NOT a widening of user scope.
  async function __sw_optionalSubject() {
    const p = await __sw_resolveIdentityOnce();
    return p && p.id ? p.id : null;
  }

  const sw = {
    project_id: projectId,
    subdomain: env.SUBDOMAIN || '',
    tier: env.TIER || 'free',
    env: (env.USER_ENV ? JSON.parse(env.USER_ENV) : {}),
    request_id: request.headers.get('cf-ray') || crypto.randomUUID(),
    // sw.trace — the correlation handle for THIS invocation (tsk_47a2a3f6).
    // Return `sw.trace.id` in an error response, log it, or put it in a
    // support message, and the whole ordered operation tree for the request
    // is one call away. Read-only; setting it does nothing.
    trace: __sw_trace
      ? Object.freeze({ id: __sw_trace.traceId, span_id: __sw_trace.spanId })
      : Object.freeze({ id: null, span_id: null }),
    // Read by the request shim after the handler returns, to ship the
    // waterfall. Never touched by customer code.
    __sw_trace,
    // The routing shim attaches the already-validated match before context
    // construction. Copy it here so the draft-safe view can be frozen before
    // customer code receives it.
    params: request.params || {},
    // Exposed under a name the user code is told never to touch. The
    // shim reads it post-handler. Lives on the same object so user
    // handlers can't accidentally return a fresh ctx without it.
    __sw_pendingRefresh,
    __sw_pendingCookies,
    __sw_pendingBackground,

    // sw.crypto — small crypto helpers for deployed functions.
    //
    //   hmacSha256Hex(message, secret) → lowercase hex HMAC-SHA256. Verify
    //     inbound webhook signatures: auth/db/inbox webhooks sign the string
    //     "<t>.<body>" with your webhook secret and send it as the header
    //     X-Somewhere-Signature: t=<t>,v1=<hex>.
    //   timingSafeEqual(a, b) → constant-time string compare; use it to
    //     compare your computed signature against the request's so a timing
    //     side-channel can't leak how many bytes matched.
    //   bcrypt.verify(password, hash) → VERIFY-ONLY check against a bcrypt
    //     hash imported from another provider (Supabase / Clerk / Firebase /
    //     a self-hosted app) so users sign in with their existing password,
    //     no reset. There is deliberately NO bcrypt *hashing* surface — the
    //     platform only ever mints PBKDF2. If these are your sw.auth
    //     app_users you don't even need this: POST /v1/auth/import + the
    //     login path migrate them to native PBKDF2 automatically. One verify
    //     is ~10-50ms CPU; don't loop it.
    /** @deprecated Use the wrapped global fetch directly. */
    fetch: __sw_outboundFetch,

    crypto: {
      hmacSha256Hex: async function (message, secret) {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw',
          enc.encode(String(secret)),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
        return Array.from(new Uint8Array(sig))
          .map(function (b) { return b.toString(16).padStart(2, '0'); })
          .join('');
      },
      timingSafeEqual: function (a, b) {
        a = String(a);
        b = String(b);
        if (a.length !== b.length) return false;
        let mismatch = 0;
        for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
        return mismatch === 0;
      },
      bcrypt: {
        verify: async function (password, hash) {
          const d = await platformJSON('/v1/auth/bcrypt-verify', {
            method: 'POST',
            body: JSON.stringify({ password: password, hash: hash }),
          });
          return !!(d && d.valid === true);
        },
      },
    },

    db: (function () {
      // Two execution paths for sw.db, picked once at function start.
      //   1. Production prefers the native D1 binding (env.PROJECT_DB).
      //      Zero HTTP, no auth middleware — fastest path.
      //   2. Enrolled dev uses REST through /v1/db/query (+ /v1/db/batch),
      //      because the API worker owns slot resolution and can resolve the
      //      fork independently of the baked database id. Flag-off dev retains
      //      the native-first path. Production falls back to REST only when no
      //      binding is attached.
      //
      // The fallback synthesizes an object that mimics D1's binding
      // surface — prepare(sql).bind(...).all() / .batch([...]) — so
      // the rest of this module doesn't branch on which path served
      // the query.
      const nativeDraftDbRequired = env.DRAFT_NATIVE_DB_REQUIRED === '1';
      function __sw_draftDbUnavailable() {
        const err = new Error(
          'This draft database clone is unavailable, so the draft cannot run safely. Retry shortly.'
        );
        err.code = 'DRAFT_DB_NOT_ISOLATED';
        err.status = 503;
        err.binding = 'PROJECT_DB';
        err.__sw_expose = true;
        return err;
      }
      function __sw_makeUnavailableDraftDB() {
        return {
          prepare: function () { throw __sw_draftDbUnavailable(); },
          batch: function () { throw __sw_draftDbUnavailable(); },
        };
      }
      function __sw_makeRestDB(restOpts) {
        restOpts = restOpts || {};
        // Managed-mode raw path (tsk_97f17edb) posts to /v1/db/raw-read, backed
        // by a read-only database capability. Default paths are the normal
        // write-capable data plane.
        const queryPath = restOpts.queryPath || '/v1/db/query';
        const batchPath = restOpts.batchPath || '/v1/db/batch';
        // Recognize the two managed-mode capability responses and surface them
        // as EXPOSED errors the developer sees verbatim, instead of the generic
        // DB_CONNECTION_NOT_READY the 403/503 branches would otherwise assign.
        function managedCapabilityError(body) {
          const code = body && (body.error || body.code);
          if (code === 'MANAGED_RAW_WRITE_FORBIDDEN') {
            const err = new Error((body && body.message) ||
              'This database is in managed mode; raw writes are refused. Use the composed query builder (sw.db.insert/update/remove) or switch the database to SQL mode.');
            err.code = 'MANAGED_RAW_WRITE_FORBIDDEN';
            err.status = 403;
            err.retryable = false;
            err.next_action = (body && body.data && body.data.next_action) || 'use_composed_write_or_switch_to_sql_mode';
            err.__sw_expose = true;
            return err;
          }
          if (code === 'MANAGED_READ_UNAVAILABLE') {
            const err = new Error((body && body.message) ||
              'Managed-mode read capability is temporarily unavailable. Retry shortly.');
            err.code = 'MANAGED_READ_UNAVAILABLE';
            err.status = 503;
            err.retryable = true;
            err.__sw_expose = true;
            return err;
          }
          return null;
        }
        const sizeErrorCodes = new Set([
          'STATEMENT_TOO_LARGE',
          'DATABASE_VALUE_TOO_LARGE',
          'DATABASE_INPUT_TOO_LARGE',
        ]);
        function responseSizeError(response, body, fallback) {
          const code = body && (body.error || body.code);
          if (!sizeErrorCodes.has(code)) return null;
          const err = new Error((body && body.message) || fallback);
          err.code = code;
          err.status = response.status >= 400 && response.status < 500 ? response.status : 400;
          err.__sw_expose = true;
          return err;
        }
        // A PLAN answer, not a connection failure. The platform refuses the
        // local loop's database calls on a plan without the local-dev database
        // entitlement, and its message already names the plans, this account's
        // plan, and that deploying is unaffected. Surfacing it verbatim is the
        // whole fix: this used to fall through to connectionNotReady below,
        // whose copy tells the developer to redeploy the function — a
        // remediation that has never changed this answer (tsk_4df056ea).
        function planGateError(body) {
          const code = body && (body.error || body.code);
          if (code !== 'LOCAL_DEV_DB_NOT_ENABLED' && code !== 'CLOUD_DEV_NOT_ENABLED') return null;
          const err = new Error((body && body.message) ||
            'This plan does not include reaching the project database from `somewhere dev`. `somewhere deploy` publishes on every plan.');
          err.code = code;
          err.status = 403;
          err.retryable = false;
          err.__sw_expose = true;
          return err;
        }
        function connectionNotReady(operation, response, body) {
          const upstreamCode = body && (body.error || body.code);
          if (response.status !== 401 && response.status !== 403) return null;
          const err = new Error(
            'sw.db.' + operation + ' cannot reach the project database: the PROJECT_DB binding is unavailable, ' +
            'and the fallback runtime credential was rejected (HTTP ' + response.status +
            (upstreamCode ? ', ' + upstreamCode : '') + '). Retry shortly; if this persists, promote or redeploy the function.'
          );
          err.code = 'DB_CONNECTION_NOT_READY';
          err.status = 503;
          err.binding = 'PROJECT_DB';
          err.__sw_expose = true;
          return err;
        }
        async function runOne(sql, params) {
          const r = await platformFetch(queryPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, sql: sql, params: params || [] }),
          });
          if (!r.ok) {
            const txt = await r.text().catch(function () { return ''; });
            let j = null;
            try { j = txt ? JSON.parse(txt) : null; } catch (_) { j = null; }
            const managedErr = managedCapabilityError(j);
            if (managedErr) throw managedErr;
            const planErr = planGateError(j);
            if (planErr) throw planErr;
            const responseCode = j && (j.error || j.code);
            const isolationCode = draftExecution && responseCode === 'DRAFT_DB_NOT_ISOLATED'
              ? 'DRAFT_DB_NOT_ISOLATED'
              : enrolledDev && responseCode === 'DEV_DB_NOT_ISOLATED'
                ? 'DEV_DB_NOT_ISOLATED'
                : null;
            const connectionErr = connectionNotReady('query', r, j);
            if (connectionErr) throw connectionErr;
            const sizeErr = responseSizeError(r, j, 'The database rejected this query because an input exceeded a size limit.');
            if (sizeErr) throw sizeErr;
            const err = new Error(isolationCode
              ? ((j && j.message) || 'The isolated dev database is not ready.')
              : ('sw.db query failed: HTTP ' + r.status + ' ' + txt.slice(0, 200)));
            err.code = isolationCode || 'DB_QUERY_FAILED';
            if (isolationCode && r.status >= 400 && r.status < 500) {
              err.status = r.status;
              err.__sw_expose = true;
            }
            throw err;
          }
          const j = await r.json();
          const d = (j && j.data) || j || {};
          // d.rows are row objects (the field name is a CF carry-over;
          // see worker/src/utils/d1.ts:queryD1 — results[0] is already
          // a record). Normalize to D1-binding shape.
          return {
            results: Array.isArray(d.rows) ? d.rows : (Array.isArray(d.results) ? d.results : []),
            meta: {
              last_row_id: (d.meta && d.meta.last_row_id) || null,
              changes: (d.meta && d.meta.changes) || 0,
              rows_read: (d.meta && d.meta.rows_read) || 0,
              rows_written: (d.meta && d.meta.rows_written) || 0,
              duration: (d.meta && typeof d.meta.duration === 'number') ? d.meta.duration : null,
              served_by_region: (d.meta && d.meta.served_by_region) || null,
            },
          };
        }
        function prepare(sql) {
          // __sw_sql / __sw_params are read back by batch() so it can
          // reassemble { sql, params } and send the whole batch to the
          // atomic /v1/db/batch endpoint. The query path (all/first/run)
          // is unchanged.
          const stmt = {
            __sw_sql: sql,
            __sw_params: [],
            bind: function () { stmt.__sw_params = Array.prototype.slice.call(arguments); return stmt; },
            all: function () { return runOne(sql, stmt.__sw_params); },
            first: async function () {
              const r = await runOne(sql, stmt.__sw_params);
              return r.results[0] || null;
            },
            run: function () { return runOne(sql, stmt.__sw_params); },
          };
          return stmt;
        }
        async function batch(prepareds) {
          // The native D1 binding runs .batch([...]) as a single
          // all-or-nothing transaction. On the REST fallback we MUST
          // give the same guarantee, so route the whole batch through
          // the atomic /v1/db/batch endpoint (the atomic batch
          // coordinator commits every statement or none). NEVER replay
          // statements one-by-one over /v1/db/query: that silently
          // drops atomicity and can leave a half-applied batch with no
          // signal (parity audit: REST-fallback db.batch atomicity).
          const list = Array.isArray(prepareds) ? prepareds : [];
          const statements = list.map(function (p) {
            return { sql: p && p.__sw_sql, params: (p && p.__sw_params) || [] };
          });
          // If we cannot assemble an atomic request, fail loudly rather
          // than degrade to non-atomic sequential execution.
          if (statements.length === 0 || statements.some(function (s) { return typeof s.sql !== 'string'; })) {
            const err = new Error('sw.db.batch could not be assembled for atomic execution (each statement needs a SQL string). Refusing to run a non-atomic batch.');
            err.code = 'DB_BATCH_NOT_ATOMIC';
            throw err;
          }
          const r = await platformFetch(batchPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, statements: statements }),
          });
          const txt = await r.text().catch(function () { return ''; });
          let j = null;
          try { j = txt ? JSON.parse(txt) : null; } catch (_) { j = null; }
          if (!r.ok || !j || j.ok === false) {
            const managedErr = managedCapabilityError(j);
            if (managedErr) throw managedErr;
            const planErr = planGateError(j);
            if (planErr) throw planErr;
            const connectionErr = connectionNotReady('batch', r, j);
            if (connectionErr) throw connectionErr;
            const sizeErr = responseSizeError(r, j, 'The database rejected this batch because an input exceeded a size limit.');
            if (sizeErr) throw sizeErr;
            const msg = (j && j.message) || ('sw.db.batch failed: HTTP ' + r.status + ' ' + txt.slice(0, 200));
            const responseCode = j && (j.error || j.code);
            const isolationCode = draftExecution && responseCode === 'DRAFT_DB_NOT_ISOLATED'
              ? 'DRAFT_DB_NOT_ISOLATED'
              : enrolledDev && responseCode === 'DEV_DB_NOT_ISOLATED'
                ? 'DEV_DB_NOT_ISOLATED'
                : null;
            const err = new Error(msg + ' The batch was rolled back; no statements were applied.');
            err.code = isolationCode || (j && j.error) || 'DB_BATCH_FAILED';
            if (isolationCode && r.status >= 400 && r.status < 500) {
              err.status = r.status;
              err.__sw_expose = true;
            }
            throw err;
          }
          const d = (j && j.data) || {};
          const results = Array.isArray(d.results) ? d.results : [];
          // Normalize each per-statement result to the D1-binding shape
          // the callers expect: { results, meta: { changes, last_row_id } }.
          return results.map(function (row) {
            return {
              results: Array.isArray(row && row.rows) ? row.rows : [],
              meta: {
                last_row_id: (row && row.last_row_id != null) ? row.last_row_id : null,
                changes: (row && row.changes) || 0,
                rows_read: 0,
                rows_written: (row && row.changes) || 0,
              },
            };
          });
        }
        return { prepare: prepare, batch: batch };
      }

      // Enrollment is stamped into each dev bundle at deploy/rebake time. Only
      // an enrolled dev bundle may bypass its baked native PROJECT_DB and ask
      // the API to resolve the current fork. Unenrolled dev and every prod
      // bundle retain master's native-first behavior byte-for-byte at runtime.
      const draftExecution = projectEnv === 'draft';
      const enrolledDev = projectEnv === 'dev' && env.DEV_SLOT_ENFORCED === '1';
      const DB = nativeDraftDbRequired
        ? (env.PROJECT_DB || __sw_makeUnavailableDraftDB())
        : draftExecution
        ? __sw_makeRestDB()
        : (enrolledDev ? __sw_makeRestDB() : (env.PROJECT_DB || __sw_makeRestDB()));
      const __sw_dbExecutionPath = nativeDraftDbRequired
        ? (env.PROJECT_DB ? 'native' : 'unavailable')
        : draftExecution
        ? 'draft-rest'
        : enrolledDev
        ? 'rest'
        : (env.PROJECT_DB ? 'native' : 'rest');

      // Database write-mode (tsk_97f17edb). Canonical project metadata baked
      // identically onto every slot (NOT inferred from PROJECT_SCHEMA). 'managed'
      // means managed-table writes are EXCLUSIVELY composed: the arbitrary-SQL
      // path (sw.db.query/batch) must not POSSESS write authority. Absent reads
      // as 'sql' — raw writes run as written, byte-identical to before.
      const DB_WRITE_MODE = (env.PROJECT_DB_WRITE_MODE === 'managed') ? 'managed' : 'sql';
      // The transport the RAW arbitrary-SQL surface (sw.db.query/batch) executes
      // on. In managed mode it is a READ-ONLY capability (REST → /v1/db/raw-read,
      // backed by a read-scoped credential), so a raw write cannot commit — reads
      // still pass. In sql mode it is the same write-capable binding as before,
      // so nothing changes. The COMPOSED path (sw.db.from/insert/update/remove)
      // always keeps the write-capable DB. Built lazily so a sql-mode function
      // never allocates it.
      const RAW_SQL_READ_ONLY = DB_WRITE_MODE === 'managed';
      let __sw_rawReadDbInstance = null;
      function rawSqlDb() {
        if (!RAW_SQL_READ_ONLY) return DB;
        if (!__sw_rawReadDbInstance) {
          __sw_rawReadDbInstance = __sw_makeRestDB({ queryPath: '/v1/db/raw-read', batchPath: '/v1/db/raw-read' });
        }
        return __sw_rawReadDbInstance;
      }

      // Table-intent METADATA baked in at deploy time (lowercased table name →
      // owner column / intent). These no longer drive any raw-SQL enforcement:
      // the raw-SQL rewriter was removed (tsk_fde5d117 — the platform never
      // parses or rewrites SQL it did not compose). The maps stay baked because
      // the structured query builder (step 1) and deploy gates (step 3) consume
      // them. Declarations are recorded via sw.db.scope / db_scope_set below.
      const SCOPES = (function () {
        try { return env.PROJECT_SCOPES ? __sw_jsonParse(env.PROJECT_SCOPES) : {}; }
        catch (_) { return {}; }
      })();

      const TABLE_INTENTS = (function () {
        try { return env.PROJECT_TABLE_INTENTS ? __sw_jsonParse(env.PROJECT_TABLE_INTENTS) : {}; }
        catch (_) { return {}; }
      })();

      // Declared column shapes for MANAGED tables — tables born through
      // db/schema.ts (Managed Database Slice 4, tsk_bae52569). Baked at
      // release build as PROJECT_SCHEMA, the sibling of PROJECT_SCOPES:
      // lowercased table name -> { columns: [{ n, t, nul, d }] }. The
      // builder checks what the platform composes BEFORE transport, so a
      // wrong write is a clear 400 naming the column and expected type
      // instead of a runtime database surprise. Tables with no baked shape
      // (SQL-world, imported, undeclared) behave byte-identically to before.
      const SCHEMA = (function () {
        try { return env.PROJECT_SCHEMA ? __sw_jsonParse(env.PROJECT_SCHEMA) : {}; }
        catch (_) { return {}; }
      })();

      // Release-pinned, opt-in named views. Absent on every legacy bundle and
      // on releases with no sw.db.live declaration. This never contains raw
      // SQL shapes; only the explicit v4 artifact is baked here.
      const LIVE_MANIFEST = (function () {
        try {
          const parsed = env.PROJECT_LIVE_MANIFEST ? __sw_jsonParse(env.PROJECT_LIVE_MANIFEST) : null;
          return parsed && __sw_arrayIsArray(parsed.liveViews) && __sw_arrayIsArray(parsed.invalidation)
            ? parsed
            : { liveViews: [], invalidation: [] };
        } catch (_) { return { liveViews: [], invalidation: [] }; }
      })();
      // Closure-private capability registry. Customer code can hold a result
      // object but cannot mint the WeakMap entry created only after a successful
      // composed from() execution.
      const __sw_liveReadBrands = new WeakMap();

      // Owner-identity mode (tsk_99bec0b4). 'visitor' (baked only for new
      // projects) lets owner() resolve to a stable anonymous visitor when
      // nobody is signed in; an absent binding reads as 'authenticated' — the
      // verified-user-only behaviour existing bundles/projects already have.
      const OWNER_IDENTITY_MODE = (env.PROJECT_OWNER_IDENTITY_MODE === 'visitor') ? 'visitor' : 'authenticated';

      // Loud fail for the retired { user } option (tsk_fde5d117). sw.db.query
      // used to REWRITE raw SQL to inject an owner filter when { user } was
      // passed. That rewriter is gone: platform-proven scoping exists only on
      // structured queries the platform composes. Throwing here — instead of
      // silently running the SQL as written — is what keeps every existing
      // scoped call from becoming an unscoped full-table read.
      function __sw_throwRawSqlCannotBePlatformScoped(api) {
        const err = new Error(api + ' no longer applies platform scoping to raw SQL. ' +
          'Platform-proven scoping exists only on structured queries the platform composes. ' +
          'Either write the ownership filter into your SQL yourself (WHERE user_id = ?) and drop { user }, ' +
          'or use the structured query API.');
        err.code = 'RAW_SQL_CANNOT_BE_PLATFORM_SCOPED';
        err.status = 403;
        err.__sw_expose = true;
        throw err;
      }

      function ensureBinding() {
        // Always satisfied now — DB is either the native binding or
        // the REST facade. Kept as a no-op so the call sites below
        // don't have to change. Remove with the next refactor.
      }

      function __sw_stripStringsAndComments(sql) {
        // BLANKS every string-literal and comment character with a SPACE,
        // one-for-one, so the returned string is the SAME LENGTH as the input
        // and offsets stay byte-aligned with the original SQL. Used by the
        // DDL guard (__sw_assertNoDdl) and the realtime mutation detector
        // (__sw_mutationOf).
        let out = '', i = 0;
        const n = sql.length;
        while (i < n) {
          const ch = sql[i];
          if (ch === "'") {
            out += ' '; i++;
            while (i < n) {
              if (sql[i] === "'" && sql[i + 1] === "'") { out += '  '; i += 2; continue; }
              if (sql[i] === "'") { out += ' '; i++; break; }
              out += ' '; i++;
            }
            continue;
          }
          if (ch === '-' && sql[i + 1] === '-') {
            while (i < n && sql[i] !== '\n') { out += ' '; i++; }
            continue;
          }
          if (ch === '/' && sql[i + 1] === '*') {
            out += '  '; i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += ' '; i++; }
            if (i < n) { out += '  '; i += 2; }
            continue;
          }
          out += ch; i++;
        }
        return out;
      }

      function __sw_extractTables(sql) {
        // Two length-preserving views, built in ONE quote/comment-aware pass:
        //   scan — strings, comments AND identifier CONTENTS blanked: keyword
        //          LOCATION. A keyword inside any quote/identifier/comment can't
        //          false-match, and an apostrophe inside an identifier ("a'b")
        //          can't open a fake string that hides a real FROM/INTO.
        //   read — strings + comments blanked but identifier delimiters+contents
        //          kept: reading the table NAME (quoted/qualified forms legible).
        // Both are the same length so offsets align. Table extraction must
        // recognize bare, quoted, qualified, and parenthesized references;
        // ambiguity is refused instead of inferred.
        const bq = String.fromCharCode(96);
        const blanks = function (k) { let s = ''; while (s.length < k) s += ' '; return s; };
        let scan = '', read = '';
        { let i = 0; const n = sql.length;
          while (i < n) {
            const ch = sql[i];
            if (ch === "'") {
              const st = i; i++;
              while (i < n) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i] === "'") { i++; break; } i++; }
              const seg = blanks(i - st); scan += seg; read += seg; continue;
            }
            if (ch === '"' || ch === bq) {
              const st = i; i++;
              while (i < n) { if (sql[i] === ch && sql[i + 1] === ch) { i += 2; continue; } if (sql[i] === ch) { i++; break; } i++; }
              read += sql.slice(st, i);
              scan += ch + blanks(i - st - 2) + ch;
              continue;
            }
            if (ch === '[') {
              const st = i; i++;
              while (i < n && sql[i] !== ']') i++;
              if (i < n) i++;
              read += sql.slice(st, i);
              scan += '[' + blanks(i - st - 2) + ']';
              continue;
            }
            if (ch === '-' && sql[i + 1] === '-') {
              const st = i; while (i < n && sql[i] !== '\n') i++;
              const seg = blanks(i - st); scan += seg; read += seg; continue;
            }
            if (ch === '/' && sql[i + 1] === '*') {
              const st = i; i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++; if (i < n) i += 2;
              const seg = blanks(i - st); scan += seg; read += seg; continue;
            }
            scan += ch; read += ch; i++;
          }
        }
        const up = scan.toUpperCase();
        const tables = new Set();
        const kws = ['FROM', 'JOIN', 'INTO', 'UPDATE'];
        for (let i = 0; i < scan.length; i++) {
          let matched = null;
          for (let k = 0; k < kws.length; k++) { if (__sw_kwAt(up, i, kws[k])) { matched = kws[k]; break; } }
          if (!matched) continue;
          let j = i + matched.length;
          while (j < scan.length && /\s/.test(scan[j])) j++;
          // UPDATE OR <verb> (ROLLBACK/ABORT/REPLACE/FAIL/IGNORE): the table
          // follows the conflict clause, not the bare 'OR'. Skip "OR <verb>" so
          // 'UPDATE OR IGNORE notes' reads 'notes', not 'or'.
          if (matched === 'UPDATE' && __sw_kwAt(up, j, 'OR')) {
            j += 2; while (j < scan.length && /\s/.test(scan[j])) j++;
            while (j < scan.length && /[A-Za-z]/.test(scan[j])) j++;   // the conflict verb
            while (j < scan.length && /\s/.test(scan[j])) j++;
          }
          // Read this table reference, then — for FROM only — keep reading
          // comma-separated tables (pre-ANSI cross join "FROM a, b, c") until the
          // next clause keyword, so a scoped table can't hide behind a comma.
          while (true) {
            // Descend wrapping parens that are NOT a subquery: FROM (notes) is a
            // parenthesized reference to the real table; FROM (SELECT ...) is a
            // subquery whose own inner FROM the scan matches separately. Count the
            // wraps entered so the comma-walk below can consume their closers
            // (else 'FROM (a), notes' stops at the wrap's ')' and misses notes).
            let wrapOpens = 0;
            while (scan[j] === '(') {
              let q = j + 1; while (q < scan.length && /\s/.test(scan[q])) q++;
              if (__sw_kwAt(up, q, 'SELECT') || __sw_kwAt(up, q, 'WITH') || __sw_kwAt(up, q, 'VALUES')) break;
              j = q; wrapOpens++;
            }
            let name = null;
            while (j < read.length) {
              let part = '';
              const c = read[j];
              if (c === '"' || c === bq) {
                j++;
                while (j < read.length) { if (read[j] === c && read[j + 1] === c) { part += c; j += 2; continue; } if (read[j] === c) { j++; break; } part += read[j]; j++; }
              } else if (c === '[') {
                j++;
                while (j < read.length && read[j] !== ']') { part += read[j]; j++; }
                if (j < read.length) j++;
              } else {
                while (j < read.length && /[A-Za-z0-9_]/.test(read[j])) { part += read[j]; j++; }
              }
              if (part === '') break;
              name = part;
              let p = j; while (p < read.length && /\s/.test(read[p])) p++;
              if (read[p] === '.') { j = p + 1; while (j < read.length && /\s/.test(read[j])) j++; continue; }
              break;
            }
            if (name) tables.add(name.toLowerCase());
            if (matched !== 'FROM') break;
            // FROM comma-list continuation. Robustly advance to the NEXT depth-0
            // comma in the from-region — regardless of what the current item is
            // (bareword, (paren), (SELECT…), foo(), a JOIN chain, alias). Stop at
            // the next top-level clause keyword / ')' that ends the from-region /
            // ';' / end. Then read the table after the comma. This closes the
            // comma-after-non-bareword extraction misses (round-7 wf_f9e54887).
            let cd = 0, hitComma = false;
            while (j < scan.length) {
              const ch = scan[j];
              if (ch === '(') { cd++; j++; continue; }
              if (ch === ')') {
                if (cd === 0) { if (wrapOpens > 0) { wrapOpens--; j++; continue; } break; }
                cd--; j++; continue;
              }
              if (cd === 0) {
                if (ch === ',') { hitComma = true; j++; while (j < scan.length && /\s/.test(scan[j])) j++; break; }
                if (__sw_kwAt(up, j, 'WHERE') || __sw_kwAt(up, j, 'GROUP') || __sw_kwAt(up, j, 'ORDER') ||
                    __sw_kwAt(up, j, 'LIMIT') || __sw_kwAt(up, j, 'HAVING') || __sw_kwAt(up, j, 'WINDOW') ||
                    __sw_kwAt(up, j, 'RETURNING') || ch === ';') break;
              }
              j++;
            }
            if (!hitComma) break;
          }
        }
        return tables;
      }

      function __sw_detectStmt(stripped) {
        const t = stripped.trimStart().toLowerCase();
        if (t.startsWith('select') || t.startsWith('with')) return 'select';
        if (t.startsWith('insert')) return 'insert';
        if (t.startsWith('update')) return 'update';
        if (t.startsWith('delete')) return 'delete';
        return 'other';
      }


      // True iff the uppercase keyword 'word' sits at offset i in 'up' with a
      // word boundary on both sides.
      function __sw_kwAt(up, i, word) {
        if (up.substr(i, word.length) !== word) return false;
        const before = up[i - 1];
        const after = up[i + word.length];
        const isWord = function (ch) { return ch != null && /[A-Z0-9_]/.test(ch); };
        return !isWord(before) && !isWord(after);
      }

      function __sw_tablesTouched(sql) {
        return Array.from(__sw_extractTables(sql));
      }

      /* The raw-SQL auto-scope rewriter and its scan/enforce helpers were
         deleted here (tsk_fde5d117) — removed, not merely unreachable. The
         platform never parses or rewrites SQL it did not write; raw SQL in
         server functions runs as written, trusted and unscoped. The retired
         symbol names are pinned-absent by check-scope-violation-idiom.mjs and
         test-rewriter-fully-deleted.mjs — deliberately NOT re-listed here, so
         the emitted runtime carries none of them even as dead text. */
      



      // Normalize Postgres-style $N placeholders to D1's positional ?
      // markers. D1's .bind() walks ? left-to-right; left-untouched $N
      // tokens silently bind in array order, so 'WHERE id = $1 AND a = $2'
      // with ['x', 'A'] would still bind x→? then A→? — fine here, but
      // 'a = $2 WHERE id = $1' would bind 'x' to a and 'A' to id (zero
      // changes). Reject mixed ?/$N as VALIDATION_ERROR.
      function __sw_normalizePlaceholders(sql, params) {
        const inputParams = params || [];
        let out = '';
        let hasQ = false;
        const usedNs = [];
        let i = 0;
        const n = sql.length;
        while (i < n) {
          const ch = sql[i];
          if (ch === "'") {
            out += ch; i++;
            while (i < n) {
              if (sql[i] === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue; }
              out += sql[i];
              if (sql[i] === "'") { i++; break; }
              i++;
            }
            continue;
          }
          if (ch === '"') {
            out += ch; i++;
            while (i < n) {
              if (sql[i] === '"' && sql[i + 1] === '"') { out += '""'; i += 2; continue; }
              out += sql[i];
              if (sql[i] === '"') { i++; break; }
              i++;
            }
            continue;
          }
          if (ch === '-' && sql[i + 1] === '-') {
            while (i < n && sql[i] !== '\n') { out += sql[i]; i++; }
            continue;
          }
          if (ch === '/' && sql[i + 1] === '*') {
            out += '/*'; i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++; }
            if (i < n) { out += '*/'; i += 2; }
            continue;
          }
          if (ch === '?') { hasQ = true; out += '?'; i++; continue; }
          if (ch === '$' && sql[i + 1] >= '0' && sql[i + 1] <= '9') {
            let j = i + 1;
            let digits = '';
            while (j < n && sql[j] >= '0' && sql[j] <= '9') { digits += sql[j]; j++; }
            const num = parseInt(digits, 10);
            if (num < 1) {
              const err = new Error('Invalid placeholder $' + digits + ' — placeholder numbers are 1-indexed.');
              err.code = 'VALIDATION_ERROR';
              throw err;
            }
            usedNs.push(num);
            out += '?';
            i = j;
            continue;
          }
          out += ch; i++;
        }
        if (hasQ && usedNs.length > 0) {
          const err = new Error('Mixed placeholder styles in one statement. Use either ? throughout or $N throughout, not both.');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        if (usedNs.length === 0) return { sql: out, params: inputParams };
        const maxN = Math.max.apply(null, usedNs);
        if (maxN > inputParams.length) {
          const err = new Error('Placeholder $' + maxN + ' has no matching param — only ' + inputParams.length + ' provided.');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        const newParams = usedNs.map((num) => inputParams[num - 1]);
        return { sql: out, params: newParams };
      }

      // Postgres-flavored SQL → SQLite. Mirrors translateSqlForDialect
      // in worker/src/utils/sql-translate.ts; kept inline because this
      // runs inside the customer's deployed function bundle (no imports
      // available at runtime). Literal- and comment-aware: text inside
      // '...', "...", -- ..., or /* ... */ is preserved verbatim.
      // Dialect is hard-coded to 'sqlite' today (every project is on
      // D1); when a project lands on a Postgres backend the dialect
      // flips at deploy time and the function becomes a pass-through.
      const __sw_DIALECT = 'sqlite';
      function __sw_translateForDialect(sqlIn) {
        if (__sw_DIALECT !== 'sqlite') return sqlIn;
        // Pre-pass: json arrows. The quoted key is syntactically a
        // SQL literal but semantically part of the operator, so the
        // literal-aware walker below would skip it. See sql-translate.ts.
        let sql = sqlIn
          .replace(/(\w+)->>\s*'([^']+)'/g, "json_extract($1, '$.$2')")
          .replace(/(\w+)->\s*'([^']+)'/g, "json_extract($1, '$.$2')");
        const rewrites = [
          [/\bNOW\s*\(\s*\)/gi, "datetime('now')"],
          [/\bTRUE\b/g, '1'],
          [/\bFALSE\b/g, '0'],
          [/\bILIKE\b/gi, 'LIKE'],
          [/\bSERIAL\b/gi, 'INTEGER'],
          [/\bBOOLEAN\b/gi, 'INTEGER'],
          // NOTE: RETURNING * is intentionally NOT rewritten — SQLite/D1
          // support it natively. Rewriting it to RETURNING id silently
          // dropped every other column and broke id-less tables (tsk_7afb8f97).
        ];
        let out = '';
        let code = '';
        const flushCode = () => {
          if (!code) return;
          let s = code;
          for (const [re, rep] of rewrites) s = s.replace(re, rep);
          out += s;
          code = '';
        };
        let i = 0;
        const n = sql.length;
        while (i < n) {
          const ch = sql[i];
          if (ch === "'") {
            flushCode();
            out += ch; i++;
            while (i < n) {
              if (sql[i] === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue; }
              out += sql[i];
              if (sql[i] === "'") { i++; break; }
              i++;
            }
            continue;
          }
          if (ch === '"') {
            flushCode();
            out += ch; i++;
            while (i < n) {
              if (sql[i] === '"' && sql[i + 1] === '"') { out += '""'; i += 2; continue; }
              out += sql[i];
              if (sql[i] === '"') { i++; break; }
              i++;
            }
            continue;
          }
          if (ch === '-' && sql[i + 1] === '-') {
            flushCode();
            while (i < n && sql[i] !== '\n') { out += sql[i]; i++; }
            continue;
          }
          if (ch === '/' && sql[i + 1] === '*') {
            flushCode();
            out += '/*'; i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++; }
            if (i < n) { out += '*/'; i += 2; }
            continue;
          }
          code += ch; i++;
        }
        flushCode();
        return out;
      }

      function __sw_prepOn(database, sql, params) {
        const normalized = __sw_normalizePlaceholders(sql, params);
        const translated = __sw_translateForDialect(normalized.sql);
        let stmt = database.prepare(translated);
        if (normalized.params && normalized.params.length) stmt = stmt.bind(...normalized.params);
        return stmt;
      }

      // Query-latency alerting (tsk_4d3e9e item 2, tsk_6dc2766d,
      // tsk_cd7739e6173542439f0d3b61b53bb6b8) +
      // schema-drift hint (tsk_4d3e9e item 7). Wraps any sw.db execution:
      // console.warn on queries at or above SW_SLOW_QUERY_MS, and on errors matching
      // "no such column" / "no such table" rewrites the message to
      // tell the developer their schema is out of date — a real
      // missing-column error otherwise blames the deployed code when
      // the actual fix is db_migrate. The first successful query in a
      // runtime instance gets a neutral first-touch label because it can
      // include startup work. Later warnings distinguish provider-reported
      // SQL-engine duration from all other binding time. The residual is NOT
      // labelled as SQL execution or as a specific queue: it can include
      // activation, placement, transport, provider queueing, and binding work.
      // Logs and the dashboard Logs tab surface the structured timing fields.
      const SW_SLOW_QUERY_MS = 100;
      // Strip engine/infra labels from a raw database error so the developer
      // sees the actionable cause ("UNIQUE constraint failed: users.email")
      // without the provider noise ("D1_ERROR", "SQLITE_CONSTRAINT_UNIQUE").
      // No D1/SQLite/Cloudflare term survives (rule 8 — product language only).
      function __sw_productizeDbMessage(msg) {
        return String(msg)
          .replace(/D1_ERROR:?/gi, '')
          .replace(/SQLITE_[A-Z_]+/gi, '')
          .replace(/\bSQLite\b/gi, 'database')
          .replace(/\bD1\b/gi, 'database')
          .replace(/\bCloudflare\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .replace(/^[\s:;.,]+|[\s:;.,]+$/g, '')
          .trim();
      }
      function __sw_decorateError(label, sqlPreview, err) {
        const msg = (err && err.message) || String(err);
        let sizeCode = null;
        let sizeMessage = null;
        if (/string or blob too big|row (?:is )?too big/i.test(msg)) {
          sizeCode = 'DATABASE_VALUE_TOO_LARGE';
          sizeMessage = 'A string, binary value, or resulting row exceeds the database size limit. Store large files with sw.fs or split the record.';
        } else if (/statement too long/i.test(msg)) {
          sizeCode = 'STATEMENT_TOO_LARGE';
          sizeMessage = 'SQL statement exceeds the 100,000-byte text limit. Split large multi-row statements into smaller batches.';
        } else if (/SQLITE_TOOBIG/i.test(msg)) {
          sizeCode = 'DATABASE_INPUT_TOO_LARGE';
          sizeMessage = 'The database rejected this query because its SQL text, a value, or the resulting row exceeded a size limit.';
        }
        if (sizeCode) {
          const sized = new Error(sizeMessage);
          sized.code = sizeCode;
          sized.status = 400;
          sized.__sw_expose = true;
          sized.original = err;
          return sized;
        }
        const snippet = String(sqlPreview).replace(/\s+/g, ' ').slice(0, 200);
        const m = msg.match(/no such (?:column|table)[^A-Za-z0-9_]*([A-Za-z0-9_.]*)/i);
        if (m) {
          const ident = m[1] || 'unknown';
          console.warn('[SW_SCHEMA_DRIFT] ' + label + ' — ' + ident + ' missing — ' + snippet);
          // Productize the raw cause before it reaches the developer — the
          // native binding / provider passthrough prefixes "D1_ERROR:" /
          // "SQLITE_*" onto the "no such column/table" text. The
          // DB_QUERY_ERROR branch below already strips those; do the same
          // here so the SCHEMA_DRIFT message stays product-language only.
          const detail = __sw_productizeDbMessage(msg) || 'a referenced column or table does not exist';
          const better = new Error('Schema drift: ' + detail + '. Your code references "' + ident + '" but the database schema does not. Add the missing table/column with db_migrate (a restore point is taken automatically), then declare its access intent with db_scope_set.');
          better.code = 'SCHEMA_DRIFT';
          better.original = err;
          return better;
        }
        // Any OTHER database error: the native binding / provider passthrough
        // surfaces raw strings like "D1_ERROR: ... : SQLITE_CONSTRAINT" that
        // leak the engine and read as noise. Rewrite to product language, but
        // FAIL LOUD: log the real cause server-side (Logs tab) and keep
        // .original — never swallow it.
        if (/D1_ERROR|SQLITE/i.test(msg)) {
          console.error('[SW_DB_ERROR] ' + label + ' — ' + msg + ' — ' + snippet);
          const detail = __sw_productizeDbMessage(msg);
          const wrapped = new Error(
            (detail ? 'Your database query could not be completed: ' + detail + '.'
                    : 'Your database query could not be completed.') +
            ' Check the query and your table and column names against your schema; the full database error is in your project Logs.'
          );
          wrapped.code = 'DB_QUERY_ERROR';
          wrapped.original = err;
          return wrapped;
        }
        return err;
      }
      // Retry-on-backpressure (founder 2026-06-08): a write that gets
      // "D1 overloaded / queued for too long" or SQLITE_BUSY did NOT commit
      // (rejected before it ran), so retrying is safe — no double-write.
      // Only CLEAR backpressure signals are retried (never a generic error,
      // so a post-commit network blip can't trigger a double-write). Reads
      // are idempotent, also safe. Bounded attempts + backoff: absorbs
      // transient spikes; sustained overload still surfaces after ~1.5s
      // (correct backpressure, not an infinite hang).
      function __sw_isRetryable(err) {
        const m = String((err && err.message) || err || '').toLowerCase();
        return m.indexOf('overload') !== -1 ||
               m.indexOf('queued for too long') !== -1 ||
               m.indexOf('sqlite_busy') !== -1 ||
               m.indexOf('database is locked') !== -1 ||
               (m.indexOf('busy') !== -1 && m.indexOf('database') !== -1);
      }
      // Patience budget ~10s total: gentle early (transient spikes clear in
      // ms) and progressively patient (absorb sustained overload by WAITING,
      // not erroring — Postgres-like graceful degradation, bounded by the
      // request window so we never hold a connection indefinitely).
      const __SW_RETRY_DELAYS = [50, 150, 400, 900, 2000, 3000, 3500];
      function __sw_dbStatementKind(sql) {
        const match = String(sql).match(/^\s*([A-Za-z]+)/);
        const kind = match ? match[1].toUpperCase() : 'OTHER';
        return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'REPLACE', 'BEGIN', 'COMMIT', 'ROLLBACK'].indexOf(kind) !== -1
          ? kind
          : 'OTHER';
      }
      function __sw_dbTimingMeta(out) {
        const list = Array.isArray(out) ? out : [out];
        let engineMs = 0;
        let engineDurationComplete = list.length > 0;
        let databaseRegion = null;
        for (const item of list) {
          const meta = item && item.meta;
          if (meta && typeof meta.duration === 'number' && Number.isFinite(meta.duration) && meta.duration >= 0) {
            engineMs += meta.duration;
          } else {
            engineDurationComplete = false;
          }
          if (meta && !databaseRegion && typeof meta.served_by_region === 'string') {
            databaseRegion = meta.served_by_region;
          }
        }
        return {
          engineMs: engineDurationComplete ? Math.round(engineMs * 1000) / 1000 : null,
          engineDurationComplete: engineDurationComplete,
          databaseRegion: databaseRegion,
        };
      }
      function __sw_warnDbTiming(event, label, sql, totalMs, timing, retryCount, retryBackoffRequestedMs) {
        const engineMs = timing.engineMs;
        const nonEngineMs = !timing.engineDurationComplete || engineMs === null
          ? null
          : Math.max(0, Math.round((totalMs - engineMs) * 1000) / 1000);
        const edgeRegion = request && request.cf && typeof request.cf.colo === 'string'
          ? request.cf.colo
          : null;
        console.warn('[' + event + '] ' + JSON.stringify({
          event: event,
          operation: label,
          total_ms: totalMs,
          engine_ms: engineMs,
          engine_duration_complete: timing.engineDurationComplete,
          non_engine_ms: nonEngineMs,
          non_engine_includes: 'activation, placement, transport, queueing, binding, and elapsed backoff',
          execution_path: __sw_dbExecutionPath,
          edge_region: edgeRegion,
          database_region: timing.databaseRegion,
          retry_count: retryCount,
          retry_backoff_requested_ms: retryBackoffRequestedMs,
          statement_kind: __sw_dbStatementKind(sql),
        }));
      }
      async function __sw_timedExec(label, sql, runner) {
        const start = Date.now();
        let attempt = 0;
        let retryBackoffRequestedMs = 0;
        for (;;) {
          try {
            const out = await runner();
            const ms = Date.now() - start;
            const isFirstDbQuery = !__sw_hasCompletedDbQuery;
            __sw_hasCompletedDbQuery = true;
            const timing = __sw_dbTimingMeta(out);
            if (isFirstDbQuery && ms >= SW_SLOW_QUERY_MS) {
              __sw_warnDbTiming('SW_DB_FIRST_TOUCH', label, sql, ms, timing, attempt, retryBackoffRequestedMs);
            }
            if (timing.engineDurationComplete && timing.engineMs !== null && timing.engineMs >= SW_SLOW_QUERY_MS) {
              __sw_warnDbTiming('SW_SLOW_SQL', label, sql, ms, timing, attempt, retryBackoffRequestedMs);
            } else if (!isFirstDbQuery && ms >= SW_SLOW_QUERY_MS) {
              __sw_warnDbTiming(
                timing.engineDurationComplete ? 'SW_DB_NON_ENGINE_LATENCY' : 'SW_DB_TOTAL_LATENCY_UNATTRIBUTED',
                label,
                sql,
                ms,
                timing,
                attempt,
                retryBackoffRequestedMs
              );
            }
            return out;
          } catch (err) {
            if (attempt < __SW_RETRY_DELAYS.length && __sw_isRetryable(err)) {
              const retryDelayMs = __SW_RETRY_DELAYS[attempt];
              console.warn('[SW_DB_RETRY] ' + JSON.stringify({
                event: 'SW_DB_RETRY',
                operation: label,
                execution_path: __sw_dbExecutionPath,
                attempt: attempt + 1,
                backoff_requested_ms: retryDelayMs,
                reason: 'database backpressure before execution',
                statement_kind: __sw_dbStatementKind(sql),
              }));
              await new Promise(function (r) { setTimeout(r, retryDelayMs); });
              retryBackoffRequestedMs += retryDelayMs;
              attempt++;
              continue;
            }
            throw __sw_decorateError(label, sql, err);
          }
        }
      }

      // Native binding writes do not pass through /v1/db/query, so forward the
      // provider's post-commit size evidence over the project-bound runtime
      // credential. The server verifies that credential and the exact baked DB
      // id, then applies a timestamp + pointer guard. Failures are deliberately
      // swallowed: a committed customer write remains successful.
      function __sw_deferDbSizeObservation(out) {
        // A draft write is committed only to its disposable clone. It must not
        // update the live project's accounting pointer or emit any other
        // shared post-commit work.
        if (isDraftExecution) return;
        if (__sw_dbExecutionPath !== 'native' || !env.PROJECT_DB_ID) return;
        const list = Array.isArray(out) ? out : [out];
        let sizeAfter = null;
        for (let i = list.length - 1; i >= 0; i--) {
          const raw = list[i] && list[i].meta && list[i].meta.size_after;
          if (raw == null) continue;
          const candidate = Number(raw);
          if (Number.isFinite(candidate) && candidate >= 0) {
            sizeAfter = candidate;
            break;
          }
        }
        if (sizeAfter === null) return;
        const pending = platformFetch('/v1/db/size-observation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ database_id: env.PROJECT_DB_ID, size_after: sizeAfter }),
        }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
        }).catch(function (error) {
          console.warn('[SW_DB_SIZE_OBSERVATION] deferred update failed: ' + ((error && error.message) || String(error)));
        });
        __sw_pendingBackground.push(pending);
      }

      // tsk_5523b9 / tsk_2bf7d327: auto-publish a realtime event after a
      // successful sw.db mutation so clients can subscribe to db:<table>
      // for live updates without polling. Fire-and-forget — wrapped in
      // catch so a realtime hiccup never kills the user's write.
      // Channel name format: 'db:' + lowercased table name. Event
      // payload: { event, table, timestamp, row, rows, row_count,
      // truncated }. `rows` carries the changed row(s) the statement
      // returned (new row on insert/update, old row on delete) so a
      // subscriber doesn't have to refetch on every change; `row` is a
      // convenience alias for rows[0]. It's empty when the statement
      // returned nothing — e.g. a raw INSERT/UPDATE/DELETE without
      // RETURNING — in which case the event still fires (op + table)
      // exactly as before. Payload is bounded by __sw_boundRows so a
      // bulk write or a fat TEXT column can't blow up the message.
      function __sw_boundRows(rows) {
        const MAX_ROWS = 25;
        const MAX_FIELD_CHARS = 1024;
        const MAX_TOTAL_CHARS = 32 * 1024;
        if (!Array.isArray(rows) || rows.length === 0) return { rows: [], truncated: false };
        let truncated = rows.length > MAX_ROWS;
        const out = [];
        for (const row of rows.slice(0, MAX_ROWS)) {
          if (row === null || typeof row !== 'object') { out.push(row); continue; }
          const clean = {};
          for (const k of Object.keys(row)) {
            const v = row[k];
            if (typeof v === 'string' && v.length > MAX_FIELD_CHARS) {
              clean[k] = v.slice(0, MAX_FIELD_CHARS) + '...[+' + (v.length - MAX_FIELD_CHARS) + ' chars]';
              truncated = true;
            } else {
              clean[k] = v;
            }
          }
          out.push(clean);
        }
        // Backstop: if the bounded rows still serialize too large (many
        // columns, big numeric arrays), drop trailing rows until under cap.
        while (out.length > 0) {
          let size;
          try { size = new TextEncoder().encode(JSON.stringify(out)).byteLength; } catch (_) { size = MAX_TOTAL_CHARS + 1; }
          if (size <= MAX_TOTAL_CHARS) break;
          out.pop();
          truncated = true;
        }
        return { rows: out, truncated: truncated };
      }
      function __sw_publishDbMutation(table, op, rows) {
        // Realtime channels are shared project state, not part of the draft
        // database clone. Draft mutations deliberately have no post-commit
        // fan-out; promotion publishes the final artifact, never draft events.
        if (isDraftExecution) return;
        if (!table || (op !== 'insert' && op !== 'update' && op !== 'delete')) return;
        const channel = 'db:' + String(table).toLowerCase();
        const bounded = __sw_boundRows(rows);
        // No await — publish in the background so the response
        // returns immediately.
        platformFetch('/v1/realtime/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            channel: channel,
            event: op,
            data: {
              event: op,
              table: String(table).toLowerCase(),
              timestamp: new Date().toISOString(),
              row: bounded.rows.length ? bounded.rows[0] : null,
              rows: bounded.rows,
              row_count: bounded.rows.length,
              truncated: bounded.truncated,
            },
            from: 'sw.db',
          }),
        }).catch(function () { /* silent — never block the write */ });
      }

      function __sw_liveInvalidation(table) {
        const wanted = String(table || '').toLowerCase();
        for (let i = 0; i < LIVE_MANIFEST.invalidation.length; i++) {
          const entry = LIVE_MANIFEST.invalidation[i];
          if (entry && entry.table === wanted) return entry;
        }
        return null;
      }

      function __sw_liveCandidates(entry, op, writtenColumns) {
        if (!entry) return [];
        if (op === 'insert') return entry.insert || [];
        if (op === 'delete') return entry.delete || [];
        const names = new Set(entry.updateAny || []);
        for (let i = 0; i < writtenColumns.length; i++) {
          const list = entry.updateColumns && entry.updateColumns[String(writtenColumns[i]).toLowerCase()];
          for (let j = 0; list && j < list.length; j++) names.add(list[j]);
        }
        return Array.from(names);
      }

      function __sw_liveSubject(ir, principalId) {
        if (ir.scope.mode === 'user') {
          if (principalId === undefined || principalId === null) return null;
          const id = String(principalId);
          return { kind: /^anon_[a-zA-Z0-9_-]{8,}$/.test(id) ? 'visitor' : 'app_user', id: principalId };
        }
        if (ir.scope.mode === 'unscoped') return { kind: 'shared', id: null };
        return null;
      }

      async function __sw_publishStructuredLiveInvalidation(ir, mutation, principalId) {
        if (isDraftExecution || !env.SW_RELEASE_ID) return null;
        const entry = __sw_liveInvalidation(mutation.table);
        const written = (ir.values || []).map(function (item) { return String(item.column).toLowerCase(); });
        const candidates = __sw_liveCandidates(entry, mutation.op, written);
        if (!candidates.length) return null;
        const subject = __sw_liveSubject(ir, principalId);
        // member() is deliberately not live in this slice. The deploy extractor
        // refuses such a declaration, and the runtime also refuses to invent a
        // group/member fan-out from insufficient write-time evidence.
        if (!subject) return { delivery: 'resync_required', reason: 'LIVE_SCOPE_NOT_SUBSCRIBABLE' };
        const body = {
          projectId: projectId,
          releaseId: env.SW_RELEASE_ID,
          table: String(mutation.table).toLowerCase(),
          op: mutation.op,
          writtenColumns: written,
          subject: subject,
        };
        try {
          const response = await platformFetch('/v1/live/invalidate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          if (!response.ok) return { delivery: 'resync_required', reason: 'DELIVERY_UNAVAILABLE' };
          return { delivery: 'invalidated' };
        } catch (error) {
          console.warn('[SW_LIVE_INVALIDATION] delivery failed: ' + ((error && error.message) || String(error)));
          return { delivery: 'resync_required', reason: 'DELIVERY_UNAVAILABLE' };
        }
      }

      // Detect the (op, table) from a SQL statement. Returns null
      // for SELECT or anything we can't safely parse. Reuses the
      // existing strip / detect / extract helpers. For multi-table
      // mutations (rare in app code, e.g. UPDATE ... FROM joins)
      // returns the FIRST touched table — good enough for the v1
      // event hook; subscribers can dedupe.
      function __sw_mutationOf(sql) {
        try {
          var stripped = __sw_stripStringsAndComments(sql);
          var kind = __sw_detectStmt(stripped);
          if (kind !== 'insert' && kind !== 'update' && kind !== 'delete') return null;
          var tables = __sw_extractTables(sql);
          for (var t of tables) return { op: kind, table: t };
          return null;
        } catch (_) { return null; }
      }

// Reject DDL statements from inside the function runtime
      // (tsk_a9f1fee70, 2026-05-21). A request handler should never
      // ALTER / DROP / CREATE the schema — those operations belong to
      // operator tooling (CLI, MCP db_migrate, dashboard). Without
      // this guard, a buggy handler that takes SQL from the request
      // body (or just hard-codes a destructive query) could destroy
      // the database, and removing sw.db.migrate alone wouldn't help
      // because sw.db.query / batch also speak raw SQL to the same
      // D1 binding. Match the FIRST keyword after stripping leading
      // whitespace + line comments — captures the common shapes
      // without false-positive-ing on data queries that happen to
      // contain "DROP" or "CREATE" in a string literal further in.
      function __sw_assertNoDdl(sql) {
        // NOTE: this source lives inside the PLATFORM_CONTEXT_JS
        // template literal. Every backslash in a regex literal must
        // be doubled here, otherwise the emitted bundle collapses
        // each escape (e.g. backslash-s becomes plain s) and the
        // resulting regex stops matching whitespace + word boundary.
        // Avoid backticks in this comment block — they would close
        // the outer template literal.
        // Strip ALL leading whitespace, line comments (-- ...) AND block
        // comments (/* ... */) before the DDL-prefix test — a leading block
        // comment must not push the DDL keyword off offset 0 and slip the guard
        // (e.g. "/* */ DROP TABLE x"). Use the shared length-preserving stripper
        // then trimStart so the keyword is at the front regardless of comment form.
        const cleaned = __sw_stripStringsAndComments(String(sql)).replace(/^\s+/, '').toUpperCase();
        if (/^(?:ALTER|DROP|CREATE|RENAME|TRUNCATE|PRAGMA|VACUUM|REINDEX|ATTACH|DETACH)\b/.test(cleaned)) {
          const op = (cleaned.match(/^[A-Z]+/) || ['DDL'])[0];
          const err = new Error(
            'sw.db: ' + op + ' statements are not allowed from the function runtime ' +
            '(removed 2026-05-21). Schema changes must run with developer credentials. ' +
            'Use the CLI somewhere fetch /v1/db/migrate, the db_migrate MCP tool, or the ' +
            'dashboard Database tab. Your app code should treat the schema as fixed at ' +
            'runtime; data writes (INSERT, UPDATE, DELETE) are fine.'
          );
          err.code = 'DDL_NOT_ALLOWED_IN_FUNCTION';
          // Surface the message above as a clean 403 instead of letting the
          // shim's catch-all flatten it into an opaque 500 FUNCTION_ERROR.
          // Same treatment as the SCOPE_VIOLATION siblings: this is a
          // developer mistake with a named recovery path, and hiding it leaves
          // exactly the unactionable error this text was written to prevent.
          // Message is product-language only — no infra leak.
          err.status = 403;
          err.__sw_expose = true;
          throw err;
        }
      }

      // D1's prepared-statement binding accepts a SQL string containing more
      // than one statement, so prepare() is not a structural single-statement
      // boundary. Do not deepen the DDL keyword parser to inspect statement 2,
      // 3, etc. Instead, make the customer runtime contract one statement per
      // query/batch entry and detect only whether a real statement follows an
      // unquoted semicolon.
      //
      // Rule 9 rollout: missing/unrecognized policy is warning-only. The stable,
      // query-free marker lets operators measure actual calls for one deploy
      // cycle before rebaking bundles with policy=block. Explicit block mode is
      // covered through both native run_code and deployed-function bundles.
      const __SW_DB_MULTI_STATEMENT_POLICY = env.SW_DB_MULTI_STATEMENT_POLICY === 'block'
        ? 'block'
        : 'warn';

      function __sw_hasSqlAfterSemicolon(sql, start) {
        let i = start;
        while (i < sql.length) {
          const ch = sql[i];
          if (/\s/.test(ch)) { i++; continue; }
          if (ch === '-' && sql[i + 1] === '-') {
            i += 2;
            while (i < sql.length && sql[i] !== '\n') i++;
            continue;
          }
          if (ch === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            if (i < sql.length) i += 2;
            continue;
          }
          return true;
        }
        return false;
      }

      function __sw_hasMultipleSqlStatements(value) {
        const sql = String(value);
        let i = 0;
        while (i < sql.length) {
          const ch = sql[i];
          // SQL strings and quoted identifiers all allow their delimiter to be
          // escaped by doubling it. Semicolons inside them are data, not a
          // statement boundary.
          if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) {
            const quote = ch;
            i++;
            while (i < sql.length) {
              if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue; }
              if (sql[i] === quote) { i++; break; }
              i++;
            }
            continue;
          }
          if (ch === '[') {
            i++;
            while (i < sql.length) {
              if (sql[i] === ']' && sql[i + 1] === ']') { i += 2; continue; }
              if (sql[i] === ']') { i++; break; }
              i++;
            }
            continue;
          }
          if (ch === '-' && sql[i + 1] === '-') {
            i += 2;
            while (i < sql.length && sql[i] !== '\n') i++;
            continue;
          }
          if (ch === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            if (i < sql.length) i += 2;
            continue;
          }
          if (ch === ';' && __sw_hasSqlAfterSemicolon(sql, i + 1)) return true;
          i++;
        }
        return false;
      }

      function __sw_assertSingleStatement(sql) {
        if (!__sw_hasMultipleSqlStatements(sql)) return;
        if (__SW_DB_MULTI_STATEMENT_POLICY !== 'block') {
          // Never log SQL or params: this is a rate signal, not customer data.
          console.warn('[sw.db.multi-statement] WOULD REFUSE code=MULTI_STATEMENT_SQL_NOT_ALLOWED');
          return;
        }
        const err = new Error(
          'sw.db accepts one SQL statement per query. Send independent statements ' +
          'as separate sw.db.query calls or as separate entries in sw.db.batch.'
        );
        err.code = 'MULTI_STATEMENT_SQL_NOT_ALLOWED';
        err.status = 400;
        err.__sw_expose = true;
        throw err;
      }

      // sw.db.scope(table, opts) — declare a table as user-scoped IN-BAND,
      // so a deployed function / run_code setup script can arm per-user row
      // scoping without minting a developer key and curl-ing /v1/db/scopes
      // out of band (the gooddog gap). Routes through the SAME POST
      // /v1/db/scopes the dashboard + MCP use, with the same owner authority:
      // the runtime key is the project owner's, pinned to THIS project by the
      // auth middleware, so a scope can only ever be declared on this project.
      //
      // A scope declaration is table-intent METADATA (tsk_fde5d117): it names
      // the owner column so the structured query builder and deploy gates can
      // consume it. It does NOT arm any raw-SQL enforcement — raw SQL in
      // server functions runs as written. Declarations are baked into the
      // bundle as PROJECT_SCOPES; recording one re-bakes the live bundle with
      // the new scope map (utils/scope-activation.ts), so it DOES take effect
      // on the running deploy — but a change that would re-posture a query a
      // released version still runs is refused (SCOPE_CHANGE_BLOCKED_BY_RELEASE,
      // scope-change-protection.ts). Unlike sw.db.query, failures throw.
      //
      //   await sw.db.scope('bookings', { owner_column: 'user_id' })
      //   await sw.db.scope('audit', { intent: 'shared' })  // intentionally cross-user
      //   await sw.db.scope.list()                           // all declared scopes
      //   await sw.db.scope.get('bookings')                  // one scope, or null
      async function __sw_scopeDeclare(table, opts) {
        if (typeof table !== 'string' || !table) {
          const err = new Error('sw.db.scope(table, opts): table must be a non-empty string.');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        opts = opts || {};
        const body = { project_id: projectId, table: table };
        if (opts.owner_column != null) body.owner_column = opts.owner_column;
        if (opts.sensitive_columns != null) body.sensitive_columns = opts.sensitive_columns;
        if (opts.intent != null) body.intent = opts.intent;
        return platformJSON('/v1/db/scopes', { method: 'POST', body: JSON.stringify(body) });
      }
      __sw_scopeDeclare.list = async function () {
        const d = await platformJSON('/v1/db/scopes?project_id=' + encodeURIComponent(projectId));
        return (d && d.scopes) || [];
      };
      __sw_scopeDeclare.get = async function (table) {
        if (typeof table !== 'string' || !table) {
          const err = new Error('sw.db.scope.get(table): table must be a non-empty string.');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        const lc = table.toLowerCase();
        const d = await platformJSON('/v1/db/scopes?project_id=' + encodeURIComponent(projectId));
        const scopes = (d && d.scopes) || [];
        for (let i = 0; i < scopes.length; i++) {
          if (scopes[i] && String(scopes[i].table).toLowerCase() === lc) return scopes[i];
        }
        return null;
      };

      // ─── Structured query builder (tsk_fde5d117 step 1) ──────────────────
      // The platform composes the query; it never parses a string it did not
      // write. Each verb builds a Query IR (mirrors src/types/query-ir.ts —
      // the runtime cannot import the TS types), renders parameterized SQL
      // from it, and executes through the SAME prep/__sw_timedExec plumbing as
      // sw.db.query. Three single authorities keep the whole surface safe with
      // no per-case guards: (1) ONE identifier chokepoint — __sw_structQuote,
      // called at render (the SQL boundary), so every table/column/order name
      // that reaches SQL is validated + double-quoted in exactly one place;
      // (2) ONE operator authority — __SW_STRUCT_BINOP, a null-prototype map
      // consulted by both the where-walker (acceptance) and the renderer
      // (emission), so a polluted-prototype key can never smuggle a SQL
      // fragment; (3) ONE where-walker that accepts exactly the documented
      // grammar and rejects everything else. The IR carries values/where/order
      // as ordered entries — never a plain object keyed by caller input — so
      // reserved JS keys are inert identifiers, not a vector. EVERY value is a
      // bound ?.

      // THE operator authority (tsk_5db8225a). A NULL-PROTOTYPE map, so a
      // bracket lookup can never resolve an inherited Object.prototype property
      // (a polluted "pwn"/"toString" key) into a SQL fragment — the
      // prototype-pollution injection vector. This ONE map is consulted by BOTH
      // the where-walker (acceptance) and the renderer (emission): a key is a
      // valid binary operator iff __SW_STRUCT_BINOP[key] !== undefined, which on
      // a null-proto object is true only for own keys. Its keys ARE the accepted
      // binary-operator vocabulary — no second copy to drift.
      const __SW_STRUCT_BINOP = __sw_assign(__sw_objCreateNull(), {
        eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'LIKE',
      });
      // The full accepted-operator vocabulary, DERIVED from the one authority:
      // the binary ops (keys above) plus the three structural ops the walker
      // emits directly (in, is_null, not_null). check-structured-builder-op-coverage
      // and the step-2 manifest extractor read THIS frozen list from source and
      // assert set-equality with the matrix's tested ops, so a new operator
      // cannot ship without a render+scope test.
      const __SW_STRUCT_OPS = Object.freeze(__sw_keys(__SW_STRUCT_BINOP).concat(['in', 'is_null', 'not_null', 'contains', 'starts_with', 'ends_with']));
      const __SW_STRUCT_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

      function __sw_structThrow(message) {
        const err = new Error(message);
        err.code = 'VALIDATION_ERROR';
        err.status = 400;
        err.__sw_expose = true;
        throw err;
      }
      function __sw_structThrow403(code, message) {
        const err = new Error(message);
        err.code = code;
        err.status = 403;
        err.__sw_expose = true;
        throw err;
      }

      // THE identifier chokepoint — the SINGLE place an identifier is validated,
      // called at render (the SQL boundary), so each name is validated exactly
      // once. A name is valid iff it is a string matching the SQL identifier
      // regex, at most 64 chars. Because the regex forbids the double-quote,
      // quoting needs no escaping; and because column names never become
      // plain-object keys (the IR carries ordered entries), reserved JS property
      // names like __proto__ are inert quoted identifiers, not a vector.
      function __sw_structQuote(name) {
        if (typeof name !== 'string' || name.length > 64 || !__sw_reMatch(__SW_STRUCT_IDENT_RE, name)) {
          __sw_structThrow('Invalid identifier: names must be 1-64 characters of letters, digits, and underscores, starting with a letter or underscore. Got: ' + JSON.stringify(String(name).slice(0, 40)));
        }
        return '"' + name + '"';
      }

      // A bindable value is a string, number, or boolean (and null where the
      // context allows it — INSERT/UPDATE values may be null, comparison
      // operands may not). Everything else throws.
      function __sw_structAssertBindable(v, allowNull, ctx) {
        if (v === null) {
          if (allowNull) return;
          __sw_structThrow(ctx + ': null is not a valid comparison value (use { column: null } for IS NULL).');
        }
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') return;
        __sw_structThrow(ctx + ': values must be a string, number, boolean' + (allowNull ? ', or null' : '') + ' (got ' + t + ').');
      }

      // THE single-condition compiler: one column form → ONE predicate (or
      // throws). Accepts exactly: scalar (eq), null (is_null), or a
      // single-known-operator object resolved through __SW_STRUCT_BINOP (own-key
      // only). Object.keys yields only own enumerable string keys, so no
      // inherited key reaches an operator decision. Anything else — a nested
      // array, unknown operator, $-smuggling — is a VALIDATION_ERROR. This is
      // the ONE place operator resolution happens; the where-walker calls it for
      // both the plain form AND each element of a range array, so there is a
      // single path through the null-prototype authority — no second lookup to
      // drift or to reopen the inherited-property class.
      function __sw_structCompileCondition(col, cond) {
        if (cond === null) return { op: 'is_null', column: col };
        if (typeof cond !== 'object' || __sw_arrayIsArray(cond)) {
          // A bare scalar → eq. An array here is a NESTED array (the walker
          // already peeled one level for the range case): not bindable → throws.
          __sw_structAssertBindable(cond, false, 'where["' + col + '"]');
          return { op: 'eq', column: col, value: cond };
        }
        const opKeys = __sw_keys(cond);
        if (opKeys.length !== 1) __sw_structThrow('where["' + col + '"] must specify exactly one operator, e.g. { gt: 5 }.');
        const opk = opKeys[0];
        if (opk === 'not') {
          if (cond.not !== null) __sw_structThrow('where["' + col + '"]: { not: ... } is only supported as { not: null } (IS NOT NULL). Use { ne: v } for not-equal.');
          return { op: 'not_null', column: col };
        }
        if (opk === 'in') {
          if (!__sw_arrayIsArray(cond.in)) __sw_structThrow('where["' + col + '"].in must be an array.');
          for (let j = 0; j < cond.in.length; j++) __sw_structAssertBindable(cond.in[j], false, 'where["' + col + '"].in[' + j + ']');
          return { op: 'in', column: col, values: cond.in.slice() };
        }
        // Substring search (tsk_3e9b033c): the PLATFORM composes the LIKE
        // pattern — the caller's string is data, so % and _ in it match
        // literally (escaped at render), never as wildcards. For a
        // caller-authored pattern, use { like } — its value is still a bound
        // param, but its wildcards are the caller's own.
        if (opk === 'contains' || opk === 'startsWith' || opk === 'endsWith') {
          if (typeof cond[opk] !== 'string') {
            __sw_structThrow('where["' + col + '"].' + opk + ' must be a string — the platform composes the search pattern from it (wildcards in the value match literally).');
          }
          const op = opk === 'contains' ? 'contains' : (opk === 'startsWith' ? 'starts_with' : 'ends_with');
          return { op: op, column: col, value: cond[opk] };
        }
        if (__SW_STRUCT_BINOP[opk] !== undefined) {
          __sw_structAssertBindable(cond[opk], false, 'where["' + col + '"].' + opk);
          return { op: opk, column: col, value: cond[opk] };
        }
        __sw_structThrow('where["' + col + '"]: unsupported operator ' + JSON.stringify(opk) + '. Supported: eq, ne, lt, lte, gt, gte, like, in, contains, startsWith, endsWith, and { not: null } or a bare null.');
      }

      // THE where-walker. Accepts per column: a plain condition (scalar | null |
      // {op: ...}), OR an ARRAY of such conditions, each AND-ed — the range
      // form, e.g. { created_at: [{ gte: X }, { lte: Y }] }. AND-only, still
      // single-operator per element, no OR/nesting. Every element goes through
      // the SAME __sw_structCompileCondition, so a nested array or a
      // polluted/inherited operator key dies exactly as it would in the plain
      // form. An empty array contributes zero predicates ("no constraint") — the
      // loop simply doesn't run; no special-case guard. Output is an ordered
      // predicate array, never a plain object keyed by caller input; the IR
      // already carries a predicate LIST per query, so a range is just N
      // predicates for one column — no IR type change.
      function __sw_structCompileWhere(where) {
        if (where === undefined || where === null) return [];
        if (typeof where !== 'object' || __sw_arrayIsArray(where)) __sw_structThrow('where must be an object of { column: condition }.');
        const preds = [];
        const cols = __sw_keys(where);
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          const cond = where[col];
          if (__sw_arrayIsArray(cond)) {
            // Iterate OWN indices only: a range array must be DENSE. A hole
            // (sparse array, or a length that outruns own indices) would read
            // through to an inherited Array.prototype[j] and smuggle a
            // predicate the caller never wrote — reject it loudly instead.
            for (let j = 0; j < cond.length; j++) {
              if (!__sw_own(cond, j)) {
                __sw_structThrow('where["' + col + '"] range array must be dense — element ' + j + ' is missing (sparse/holey arrays are not allowed).');
              }
              preds.push(__sw_structCompileCondition(col, cond[j]));
            }
          } else {
            preds.push(__sw_structCompileCondition(col, cond));
          }
        }
        return preds;
      }

      // order: 'col' | ['col', dir] | [['col', dir], ...]. dir defaults to asc.
      function __sw_structCompileOrder(order) {
        if (order === undefined || order === null) return undefined;
        let tuples;
        if (typeof order === 'string') tuples = [[order]];
        else if (__sw_arrayIsArray(order)) {
          if (order.length === 0) return undefined;
          tuples = typeof order[0] === 'string' ? [order] : order;
        } else __sw_structThrow('order must be a column name, [col, dir], or [[col, dir], ...].');
        const out = [];
        for (let i = 0; i < tuples.length; i++) {
          const t = tuples[i];
          if (!__sw_arrayIsArray(t) || t.length < 1 || t.length > 2) __sw_structThrow('order entries must be [col] or [col, dir].');
          const dir = t[1] === undefined ? 'asc' : t[1];
          if (dir !== 'asc' && dir !== 'desc') __sw_structThrow('order direction must be "asc" or "desc".');
          out.push({ column: t[0], dir: dir });
        }
        return out;
      }

      function __sw_structIntOpt(v, name) {
        if (v === undefined || v === null) return undefined;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) __sw_structThrow(name + ' must be a non-negative integer.');
        return v;
      }

      // insert values / update set → ordered [{ column, value }] entries (the
      // one IR value shape, mirrors src/types/query-ir.ts IRValue). Runs the
      // bindable check (null allowed); the column identifier is validated once at
      // render. Ordered entries — never a plain object keyed by caller input — so
      // a column named __proto__/constructor is inert, not a pollution vector.
      function __sw_structCompileValues(values, api) {
        if (values === undefined || values === null || typeof values !== 'object' || __sw_arrayIsArray(values)) {
          __sw_structThrow(api + ': values must be a plain object of { column: value }.');
        }
        const out = [];
        const cols = __sw_keys(values);
        for (let i = 0; i < cols.length; i++) {
          const v = values[cols[i]];
          if (v !== null && typeof v === 'object') {
            // Object/array values are judged AFTER the table resolves
            // (tsk_bae52569): on a managed json column the platform
            // serializes them; anywhere else __sw_structEnforceSchema
            // throws the exact message this check always threw. Functions,
            // symbols, undefined still die right here as before.
            out.push({ column: cols[i], value: v });
            continue;
          }
          __sw_structAssertBindable(v, true, api + ' value for "' + cols[i] + '"');
          out.push({ column: cols[i], value: v });
        }
        return out;
      }

      // Validate + narrow an options object to a NULL-PROTOTYPE, own-keys-only
      // copy. Callers then read opts.where / opts.columns / spec.set off THIS
      // copy, so an inherited or prototype-polluted key (Object.create({ where:
      // ... }), Object.prototype.where = ...) is neither validated in nor read
      // back out — one chokepoint makes every caller safe. Null-proto is
      // essential: a plain {} copy would still resolve a polluted
      // Object.prototype.where on a missing key.
      function __sw_structReadOpts(opts, allowed, api) {
        if (opts === undefined || opts === null) return __sw_objCreateNull();
        if (typeof opts !== 'object' || __sw_arrayIsArray(opts)) __sw_structThrow(api + ': options must be an object.');
        const keys = __sw_keys(opts);
        const copy = __sw_objCreateNull();
        for (let i = 0; i < keys.length; i++) {
          if (allowed.indexOf(keys[i]) === -1) __sw_structThrow(api + ': unknown option "' + keys[i] + '". Allowed: ' + allowed.join(', ') + '.');
          copy[keys[i]] = opts[keys[i]];
        }
        return copy;
      }

      // SCOPES keys are baked lowercased (scope-enforcement.ts lowercases every
      // table_name before it reaches PROJECT_SCOPES), so ONE lowercased
      // own-property lookup resolves the owner column. Own-property-gated so a
      // polluted Object.prototype cannot inject a phantom owner column for an
      // undeclared table.
      function __sw_structResolveOwnerColumn(table) {
        const lc = __sw_lower(table);
        if (!__sw_own(SCOPES, lc)) return null;
        const v = SCOPES[lc];
        return (typeof v === 'string' && v) ? v : null;
      }

      // The declared intent for a table, own-property-gated against a polluted
      // prototype (same discipline as the owner-column lookup). Returns
      // 'scoped' | 'shared' | 'server_only' | null (null = undeclared).
      function __sw_structResolveIntent(table) {
        const lc = __sw_lower(table);
        if (!__sw_own(TABLE_INTENTS, lc)) return null;
        const v = TABLE_INTENTS[lc];
        return (v === 'scoped' || v === 'shared' || v === 'server_only') ? v : null;
      }

      // ── Managed-table write checks (Managed Database Slice 4, tsk_bae52569) ──
      // ONE chokepoint, run on the compiled IR right before execution. A
      // table with a baked PROJECT_SCHEMA shape gets: unknown-column refusal
      // across values/where/order/columns (with the declared column list),
      // type-mismatch refusal on written values (column + expected type),
      // and required-column-missing refusal on insert. It is also the
      // deferred judge for object/array values the compiler let through: on
      // a managed json column the platform serializes them; anywhere else
      // they fail with the compiler's own long-standing message.
      function __sw_structManagedShape(table) {
        const lc = __sw_lower(table);
        if (!__sw_own(SCHEMA, lc)) return null;
        const v = SCHEMA[lc];
        return (v && typeof v === 'object' && __sw_arrayIsArray(v.columns) && v.columns.length > 0) ? v : null;
      }
      // Membership-join scope spec for a table (Managed Database Slice 7,
      // tsk_f51510eb). It rides INSIDE the baked PROJECT_SCHEMA shape (.member)
      // so it travels every existing bake path. Structurally re-validated here
      // — same-arity group key, string columns, a membership table + user
      // column — so a polluted prototype or a malformed bake reads as "not
      // member-scoped" and fails CLOSED at the scope resolver, never composing
      // a broken join. Keys: g = group columns on this table, m = membership
      // table, u = member-user column, mg = group columns on the membership
      // table (same arity as g; length 1 scalar, ≥2 composite/polymorphic).
      function __sw_structResolveMember(table) {
        const shape = __sw_structManagedShape(table);
        if (!shape || !__sw_own(shape, 'member')) return null;
        const m = shape.member;
        if (!m || typeof m !== 'object') return null;
        if (!__sw_arrayIsArray(m.g) || !__sw_arrayIsArray(m.mg) || m.g.length === 0 || m.g.length !== m.mg.length) return null;
        if (typeof m.m !== 'string' || !m.m || typeof m.u !== 'string' || !m.u) return null;
        for (let i = 0; i < m.g.length; i++) {
          if (typeof m.g[i] !== 'string' || !m.g[i] || typeof m.mg[i] !== 'string' || !m.mg[i]) return null;
        }
        return m;
      }
      // Declared hasMany relation resolver (composed joins, tsk_1186c9a). Rides
      // INSIDE the baked PROJECT_SCHEMA shape (.relations), like member. Every
      // field is re-validated as a safe identifier here so a polluted prototype
      // or malformed bake reads as "relation not declared" and fails CLOSED at
      // the join composer, never composing a join against an unproven key.
      function __sw_structResolveRelation(table, name) {
        const shape = __sw_structManagedShape(table);
        if (!shape || !__sw_own(shape, 'relations')) return null;
        const rels = shape.relations;
        if (!__sw_arrayIsArray(rels)) return null;
        const lc = __sw_lower(name);
        for (let i = 0; i < rels.length; i++) {
          const r = rels[i];
          if (!r || typeof r !== 'object') continue;
          if (typeof r.name !== 'string' || __sw_lower(r.name) !== lc) continue;
          if (typeof r.table !== 'string' || !__sw_reMatch(__SW_STRUCT_IDENT_RE, r.table)) return null;
          if (typeof r.fk !== 'string' || !__sw_reMatch(__SW_STRUCT_IDENT_RE, r.fk)) return null;
          if (typeof r.parentKey !== 'string' || !__sw_reMatch(__SW_STRUCT_IDENT_RE, r.parentKey)) return null;
          return { name: lc, table: __sw_lower(r.table), fk: __sw_lower(r.fk), parentKey: __sw_lower(r.parentKey) };
        }
        return null;
      }
      function __sw_structThrowSchema(code, message) {
        const err = new Error(message);
        err.code = code;
        err.status = 400;
        err.__sw_expose = true;
        throw err;
      }
      function __sw_structFindDeclaredColumn(shape, name) {
        const lc = __sw_lower(name);
        for (let i = 0; i < shape.columns.length; i++) {
          if (shape.columns[i].n === lc) return shape.columns[i];
        }
        return null;
      }
      function __sw_structDeclaredColumnList(shape, ownerColumn) {
        const names = [];
        for (let i = 0; i < shape.columns.length; i++) names.push(shape.columns[i].n);
        let msg = names.join(', ');
        if (ownerColumn) msg += ' — plus "' + ownerColumn + '", which the platform sets from the signed-in user';
        return msg;
      }
      function __sw_structExpectedType(t) {
        if (t === 'integer') return 'a whole number';
        if (t === 'number') return 'a number';
        if (t === 'boolean') return 'true or false';
        if (t === 'text') return 'text (a string)';
        if (t === 'timestamp') return 'an ISO-8601 timestamp string, like "2026-08-07T12:00:00Z"';
        if (t === 'json') return 'JSON: an object or array (stored serialized), or a JSON string';
        return t;
      }
      function __sw_structGotKind(v) {
        if (v === null) return 'null';
        if (__sw_arrayIsArray(v)) return 'a list';
        const t = typeof v;
        if (t === 'string') return 'text';
        if (t === 'number') return 'a number';
        if (t === 'boolean') return (v ? 'true' : 'false');
        if (t === 'object') return 'an object';
        return t;
      }
      // Calendar-date or full ISO-8601 datetime; T or space separator,
      // optional seconds/fraction, optional Z / +-HH:MM zone. The Date.parse
      // gate behind it rejects shapes like 2026-13-45 the regex can't.
      const __SW_STRUCT_ISO_TS_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
      function __sw_structIsIsoTimestamp(v) {
        if (typeof v !== 'string' || !__sw_reMatch(__SW_STRUCT_ISO_TS_RE, v)) return false;
        const parsed = Date.parse(v.replace(' ', 'T'));
        return parsed === parsed; // not NaN
      }
      function __sw_structThrowTypeMismatch(verb, table, col, got) {
        __sw_structThrowSchema('TYPE_MISMATCH',
          'sw.db.' + verb + ' on "' + table + '": the value for "' + col.n + '" must be ' + __sw_structExpectedType(col.t) +
          ' (got ' + got + '). The column types are declared in db/schema.ts.');
      }
      // The exact form for a whole number wider than a JavaScript number:
      // plain digits, optionally signed, exactly as a read returns them.
      const __SW_STRUCT_WHOLE_NUMBER_RE = /^-?\d+$/;
      // Compare that text against the 64-bit range without a numeric
      // conversion, which is the very thing that would lose it.
      function __sw_wholeNumberTextInRange(s) {
        const negative = s.charCodeAt(0) === 45;
        let digits = negative ? s.slice(1) : s;
        while (digits.length > 1 && digits.charCodeAt(0) === 48) digits = digits.slice(1);
        const limit = negative ? '9223372036854775808' : '9223372036854775807';
        if (digits.length !== limit.length) return digits.length < limit.length;
        return digits <= limit;
      }
      // Type-check (and for json: serialize) ONE written value against its
      // declared column. Returns the value to bind.
      function __sw_structCheckWriteValue(verb, table, col, v) {
        if (v === null) {
          if (col.nul === 1) return v;
          __sw_structThrowSchema('TYPE_MISMATCH',
            'sw.db.' + verb + ' on "' + table + '": the column "' + col.n + '" is required and cannot be set to null. It is declared without { nullable: true } in db/schema.ts.');
        }
        if (col.t === 'json') {
          if (typeof v === 'string') {
            try { __sw_jsonParse(v); return v; }
            catch (_) {
              __sw_structThrowSchema('TYPE_MISMATCH',
                'sw.db.' + verb + ' on "' + table + '": the value for "' + col.n + '" must be JSON — pass the object/array itself (the platform stores it serialized), or a valid JSON string. The text given does not parse as JSON.');
            }
          }
          let serialized;
          try { serialized = JSON.stringify(v); }
          catch (_) { serialized = undefined; }
          if (typeof serialized !== 'string') {
            __sw_structThrowSchema('TYPE_MISMATCH',
              'sw.db.' + verb + ' on "' + table + '": the value for "' + col.n + '" cannot be stored as json — it does not serialize (circular reference or unsupported value).');
          }
          return serialized;
        }
        if (typeof v === 'object') __sw_structThrowTypeMismatch(verb, table, col, __sw_structGotKind(v));
        if (col.t === 'integer') {
          // A whole number wider than 9007199254740991 cannot travel as a
          // JavaScript number at all — the language rounds it before this
          // function is reached — so the exact form for those is the same
          // decimal STRING a read returns (tsk_d741c40b). Accepting it here is
          // what makes read -> write back lossless on a managed table; the
          // database converts it on the way in because the column is an
          // integer. Text that is not a whole number keeps the type error it
          // has always had.
          if (typeof v === 'string') {
            if (!__sw_reMatch(__SW_STRUCT_WHOLE_NUMBER_RE, v)) {
              __sw_structThrowTypeMismatch(verb, table, col, 'text that is not a whole number');
            }
            if (!__sw_wholeNumberTextInRange(v)) {
              __sw_structThrowSchema('DATABASE_VALUE_TOO_LARGE',
                'sw.db.' + verb + ' on "' + table + '": the value for "' + col.n + '" is outside the range of whole numbers this database stores ' +
                '(-9223372036854775808 to 9223372036854775807). Keep the value inside that range, or store it as text.');
            }
            return v;
          }
          if (typeof v !== 'number' || v !== v || !Number.isInteger(v)) __sw_structThrowTypeMismatch(verb, table, col, typeof v === 'number' ? 'a number with a fractional part' : __sw_structGotKind(v));
          return v;
        }
        if (col.t === 'number') {
          if (typeof v !== 'number' || !Number.isFinite(v)) __sw_structThrowTypeMismatch(verb, table, col, typeof v === 'number' ? 'a non-finite number' : __sw_structGotKind(v));
          return v;
        }
        if (col.t === 'boolean') {
          if (v !== true && v !== false && v !== 0 && v !== 1) __sw_structThrowTypeMismatch(verb, table, col, __sw_structGotKind(v));
          return v;
        }
        if (col.t === 'text') {
          if (typeof v !== 'string') __sw_structThrowTypeMismatch(verb, table, col, __sw_structGotKind(v));
          return v;
        }
        if (col.t === 'timestamp') {
          if (!__sw_structIsIsoTimestamp(v)) __sw_structThrowTypeMismatch(verb, table, col, typeof v === 'string' ? 'text that is not an ISO-8601 timestamp' : __sw_structGotKind(v));
          return v;
        }
        if (col.t === 'blob') {
          __sw_structThrowSchema('TYPE_MISMATCH',
            'sw.db.' + verb + ' on "' + table + '": "' + col.n + '" is a binary column and cannot be written through this API — write it with raw sw.db.query(sql, params).');
        }
        return v; // unknown declared type: fail open on typing, never on transport
      }
      // Refuse BEFORE the write a whole number the database cannot store as one
      // (tsk_daf4d6d2). Whole numbers are kept as 64-bit values; anything past
      // that range is stored as an approximate decimal and can never be read
      // back exactly, so it must be refused up front rather than discovered
      // after the row has already landed. A column declared as a decimal
      // ('number') is exempt: large decimals are legitimate there.
      function __sw_structAssertStorableWholeNumber(verb, table, column, v, col) {
        if (typeof v !== 'number' || !Number.isInteger(v)) return;
        if (col && col.t === 'number') return;
        if (v < 9223372036854775808 && v >= -9223372036854775808) return;
        __sw_structThrowSchema('DATABASE_VALUE_TOO_LARGE',
          'sw.db.' + verb + ' on "' + table + '": the value for "' + column + '" is outside the range of whole numbers this database stores ' +
          '(-9223372036854775808 to 9223372036854775807). Keep the value inside that range, or store it as text.');
      }
      function __sw_structAssertKnownColumn(verb, table, shape, ownerColumn, name, where) {
        if (ownerColumn && __sw_lower(name) === __sw_lower(ownerColumn)) return;
        if (__sw_structFindDeclaredColumn(shape, name)) return;
        __sw_structThrowSchema('UNKNOWN_COLUMN',
          'sw.db.' + verb + ' on "' + table + '": unknown column "' + name + '"' + (where ? ' (in ' + where + ')' : '') +
          '. This table is managed by db/schema.ts — its declared columns are: ' + __sw_structDeclaredColumnList(shape, ownerColumn) +
          '. To add a column, add it to db/schema.ts and deploy.');
      }
      function __sw_structEnforceSchema(verb, ir) {
        const table = ir.table.name;
        const shape = __sw_structManagedShape(table);
        const isWrite = ir.kind === 'insert' || ir.kind === 'update';
        if (!shape) {
          if (!isWrite) return;
          // Not managed: object/array values keep their long-standing
          // refusal (the compiler's own message, now thrown here).
          for (let i = 0; i < ir.values.length; i++) {
            const v = ir.values[i].value;
            if (v !== null && typeof v === 'object') {
              __sw_structThrow('sw.db.' + verb + ' value for "' + ir.values[i].column + '": values must be a string, number, boolean, or null (got object).');
            }
            __sw_structAssertStorableWholeNumber(verb, table, ir.values[i].column, v, null);
          }
          return;
        }
        const ownerColumn = __sw_structResolveOwnerColumn(table);
        if (isWrite) {
          // Written columns must be declared (the owner column was already
          // refused upstream as not-assignable), then each value must match
          // its declared type. json values serialize IN PLACE so the
          // renderer binds the serialized text.
          for (let i = 0; i < ir.values.length; i++) {
            __sw_structAssertKnownColumn(verb, table, shape, null, ir.values[i].column, verb === 'update' ? 'set' : 'values');
            const col = __sw_structFindDeclaredColumn(shape, ir.values[i].column);
            __sw_structAssertStorableWholeNumber(verb, table, ir.values[i].column, ir.values[i].value, col);
            ir.values[i].value = __sw_structCheckWriteValue(verb, table, col, ir.values[i].value);
          }
        }
        if (ir.kind === 'insert') {
          const missing = [];
          for (let i = 0; i < shape.columns.length; i++) {
            const col = shape.columns[i];
            if (col.d === 1 || col.nul === 1) continue;
            let present = false;
            for (let j = 0; j < ir.values.length; j++) {
              if (__sw_lower(ir.values[j].column) === col.n) { present = true; break; }
            }
            if (!present) missing.push('"' + col.n + '" (' + col.t + ')');
          }
          if (missing.length > 0) {
            __sw_structThrowSchema('REQUIRED_COLUMN_MISSING',
              'sw.db.insert on "' + table + '": missing required column' + (missing.length > 1 ? 's' : '') + ' ' + missing.join(', ') +
              '. Declared required with no default in db/schema.ts — include a value, or give the column a default or { nullable: true } there and deploy.');
          }
        }
        for (let i = 0; i < ir.where.length; i++) {
          __sw_structAssertKnownColumn(verb, table, shape, ownerColumn, ir.where[i].column, 'where');
        }
        if (ir.order) {
          for (let i = 0; i < ir.order.length; i++) {
            __sw_structAssertKnownColumn(verb, table, shape, ownerColumn, ir.order[i].column, 'order');
          }
        }
        if (ir.columns) {
          for (let i = 0; i < ir.columns.length; i++) {
            __sw_structAssertKnownColumn(verb, table, shape, ownerColumn, ir.columns[i], 'columns');
          }
        }
      }

      // THE request identity for structured scoping (tsk_5b91e0e4): resolved
      // lazily through the same path sw.auth.fromRequest uses (the resolver the
      // auth namespace publishes into the context-head slot) against THIS
      // context's own `request`, and memoized for the request — including a
      // null (unauthenticated) or rejected resolution, so every query in a
      // request sees one consistent identity. Nothing PASSED TO sw.db.*
      // participates in the identity: the only input is the closed-over
      // request (L4 — request.params/__sw_fn are writable on that object, so
      // the precise claim is "no sw.db argument influences the principal", not
      // "customer code cannot touch the request"). The identity is the SAME one
      // the rest of the request sees via sw.auth, memoized REQUEST-LOCALLY
      // (sol MED-2, 2026-08-02): repeated lookups within one request share a
      // single /v1/auth/me verification, and nothing crosses requests — a
      // token revoked server-side is re-checked on the next request, always.
      let __sw_structIdentityMemo = null;
      function __sw_structRequestIdentity() {
        // Runtime v2 (sol P0-3): derive from the immutable auth snapshot, not
        // the customer-visible mutable request, so identity can't be downgraded
        // mid-request. (db scoping is already fail-closed on no-identity; this
        // keeps ONE identity source across every surface.)
        if (!__sw_structIdentityMemo) __sw_structIdentityMemo = __sw_authResolveRequest(__sw_authSnapshotRequest);
        return __sw_structIdentityMemo;
      }

      // Ambient visitor identity, memoized per request (tsk_99bec0b4). Resolved
      // ONCE so every owner() query in a request scopes to the SAME visitor id
      // and the Set-Cookie is queued at most once. Only reached on visitor-mode
      // projects when there is no verified user (see __sw_structResolveScope).
      let __sw_structVisitorMemo = null;
      function __sw_structVisitorIdentity() {
        if (!__sw_structVisitorMemo) {
          __sw_structVisitorMemo = __sw_resolveVisitorIdentity ? __sw_resolveVisitorIdentity() : null;
        }
        return __sw_structVisitorMemo;
      }

      // The scope rule — the product contract (tsk_5b91e0e4), not an option.
      // Structured access requires an EXPLICIT table intent; an undeclared
      // (grandfathered) table is refused, never silently run unscoped, so
      // "no decision" can never masquerade as "safe":
      //   scoped   → ALWAYS scoped to the request's verified user; no verified
      //              user → 401 AUTH_REQUIRED before any transport.
      //   shared / server_only → runs unscoped (declared cross-user / server).
      //   undeclared → 403 TABLE_INTENT_REQUIRED before any transport.
      //   scoped-without-owner-column → 403 TABLE_INTENT_INVALID.
      // Cross-user access to a scoped table, and any query on an undeclared
      // table, is raw sw.db.query — the explicit manual-access exception. This
      // is a STATIC table-intent requirement; there is no per-query override.
      //
      // SERVER-MODE (tsk_3e9b033c): { asServer: true } on the READ verbs
      // (from/count) is the sanctioned admin/aggregate path — trusted server
      // code reading cross-user through the builder. It never resolves or
      // impersonates a request principal (scope mode 'server', no identity
      // lookup), and the query is recorded unscoped-marked in SW_QUERY —
      // the builder twin of raw SQL's { unscoped: true } annotation. It does
      // NOT bypass the intent requirement: an undeclared table stays refused.
      // App-user JWTs never reach this surface: the emitted runtime executes
      // only as trusted server code, and the REST structured path denies
      // authMode app_user at the router boundary (routes/db.ts).
      async function __sw_structResolveScope(table, verb, asServer) {
        if (asServer !== undefined && asServer !== true) {
          __sw_structThrow('sw.db.' + verb + ': asServer must be exactly true (boolean) when present — it is the explicit server-mode annotation for intentional cross-user reads. Omit it for user-scoped access.');
        }
        // Validate the table identifier FIRST — before owner/intent lookup —
        // so a hostile or malformed name is a VALIDATION_ERROR, not a
        // confusing "no declared intent" (and so the runtime's error ordering
        // matches the deploy extractor's, which validates the identifier
        // before classifying intent). The render chokepoint re-quotes it.
        if (typeof table !== 'string' || table.length > 64 || !__sw_reMatch(__SW_STRUCT_IDENT_RE, table)) {
          __sw_structThrow('Invalid identifier: table names must be 1-64 characters of letters, digits, and underscores, starting with a letter or underscore. Got: ' + JSON.stringify(String(table).slice(0, 40)));
        }
        // Membership-join scope (Slice 7) resolves BEFORE owner/intent: a member
        // table is proven by the composed join, not by an owner column. asServer
        // is the same sanctioned server-mode bypass owner() has; otherwise the
        // verified request user is required, exactly as for owner scope.
        const member = __sw_structResolveMember(table);
        if (member) {
          if (asServer === true) {
            return { scope: { mode: 'server' }, principalId: undefined };
          }
          const memberIdentity = await __sw_structRequestIdentity();
          const memberId = memberIdentity && memberIdentity.id;
          if (memberId === undefined || memberId === null || (typeof memberId !== 'string' && typeof memberId !== 'number')) {
            const serverHint = (verb === 'from' || verb === 'count')
              ? 'For an intentional server-side cross-user read (admin screens, aggregates, background jobs), pass { asServer: true } — the sanctioned server-mode path, recorded as unscoped — or use raw sw.db.query(sql, params).'
              : 'For intentional cross-user access, use raw sw.db.query(sql, params).';
            const err = new Error('sw.db.' + verb + ' on "' + table + '": this table is shared through membership, so the platform scopes every structured query to the groups the signed-in user belongs to — and this request has no verified user. Send the request signed in (session cookie or Authorization: Bearer token). ' + serverHint);
            err.code = 'AUTH_REQUIRED';
            err.status = 401;
            err.__sw_expose = true;
            throw err;
          }
          return { scope: { mode: 'member', member: member }, principalId: memberId };
        }
        const ownerColumn = __sw_structResolveOwnerColumn(table);
        if (ownerColumn === null) {
          const intent = __sw_structResolveIntent(table);
          if (intent === 'shared' || intent === 'server_only') {
            // Already unscoped by declaration; asServer stays an honest,
            // recorded annotation rather than a silent no-op.
            return { scope: { mode: asServer === true ? 'server' : 'unscoped' }, principalId: undefined };
          }
          if (intent === 'scoped') {
            __sw_structThrow403('TABLE_INTENT_INVALID',
              'sw.db.' + verb + ' on "' + table + '": the table is declared user-owned but its ownership column is missing. Repair the scope declaration (sw.db.scope / db_scope_set), then redeploy.');
          }
          // Name the file AND the step that applies it (tsk_883e3ede). The old
          // message pointed only at sw.db.scope / db_scope_set, so a developer
          // who had already declared the table in db/schema.ts and was running
          // local dev read it as "your schema file does not count" and
          // abandoned the managed API for raw SQL. db/schema.ts is applied on a
          // production deploy only — never from local dev, a preview, or a dry
          // run — so "declared but not yet deployed" is the single most likely
          // reason to be reading this, and the message has to say so.
          __sw_structThrow403('TABLE_INTENT_REQUIRED',
            'sw.db.' + verb + ' on "' + table + '": this table has no declared intent, so the platform cannot prove how to access it safely. ' +
            'Declare it in db/schema.ts — table({ ... }, { scope: owner() }) for per-user rows, shared() for intentional cross-user access, serverOnly() for trusted server access — then run `somewhere deploy`, which is the step that applies db/schema.ts. ' +
            'Already declared it there? It needs that one production deploy: local dev, previews and dry runs do not apply the schema file, so the table still reads as undeclared here. ' +
            'Not using a schema file? sw.db.scope / db_scope_set declares a table immediately. For manual access, use raw sw.db.query(sql, params).');
        }
        if (asServer === true) {
          // Trusted server code reading cross-user, explicitly. No principal
          // is resolved — server mode never impersonates a request user.
          return { scope: { mode: 'server' }, principalId: undefined };
        }
        const identity = await __sw_structRequestIdentity();
        let id = identity && identity.id;
        // Ambient owner() (tsk_99bec0b4): on a visitor-mode project, a request
        // with no verified user scopes to a stable anonymous visitor instead of
        // being refused — so owner() works with no login. On 'authenticated'
        // (existing projects) this branch is skipped and the 401 below stands.
        if ((id === undefined || id === null || (typeof id !== 'string' && typeof id !== 'number'))
            && OWNER_IDENTITY_MODE === 'visitor') {
          const visitor = __sw_structVisitorIdentity();
          id = visitor && visitor.id;
        }
        if (id === undefined || id === null || (typeof id !== 'string' && typeof id !== 'number')) {
          const serverHint = (verb === 'from' || verb === 'count')
            ? 'For an intentional server-side cross-user read (admin screens, aggregates, background jobs), pass { asServer: true } — the sanctioned server-mode path, recorded as unscoped — or use raw sw.db.query(sql, params).'
            : 'For intentional cross-user access, use raw sw.db.query(sql, params).';
          const err = new Error('sw.db.' + verb + ' on "' + table + '": this table is user-owned, so the platform scopes every structured query to the signed-in user — and this request has no verified user. Send the request signed in (session cookie or Authorization: Bearer token). ' + serverHint);
          err.code = 'AUTH_REQUIRED';
          err.status = 401;
          err.__sw_expose = true;
          throw err;
        }
        return { scope: { mode: 'user', ownerColumn: ownerColumn }, principalId: id };
      }

      // The scope argument is GONE (tsk_5b91e0e4): scoping is automatic and
      // mandatory, so a leftover third argument fails loudly rather than
      // silently meaning something different than it used to.
      function __sw_structNoScopeArg(arg, verb) {
        if (arg === undefined) return;
        const err = new Error('sw.db.' + verb + ' no longer takes a scope argument: user-owned tables are always scoped to the signed-in request user automatically, and other tables run as written. Remove the extra argument. For an intentional server-side cross-user read, pass { asServer: true } to sw.db.from/count; for anything else cross-user, use raw sw.db.query(sql, params).');
        err.code = 'SCOPE_ARGUMENT_REMOVED';
        err.status = 400;
        err.__sw_expose = true;
        throw err;
      }

      function __sw_structAssertNotOwnerColumn(cols, ownerColumn, verb) {
        const oc = __sw_lower(ownerColumn);
        for (let i = 0; i < cols.length; i++) {
          if (__sw_lower(cols[i].column) === oc) {
            __sw_structThrow403('OWNER_COLUMN_NOT_ASSIGNABLE',
              'sw.db.' + verb + ' does not accept the ownership column "' + ownerColumn + '": the platform ' + (verb === 'insert' ? 'sets it from the signed-in user.' : 'owns it and never lets it be reassigned.'));
          }
        }
      }

      // Member-write guards (Slice 7). INSERT must carry the group columns so the
      // platform can verify membership against the value the caller supplied — it
      // cannot inject one (a user may belong to many groups). UPDATE must not
      // touch a group column: moving a row between groups would cross the access
      // boundary, so it is refused (the clean cut, mirroring the not-assignable
      // owner column) rather than re-checked.
      function __sw_structAssertMemberGroupPresent(cols, member, verb) {
        for (let i = 0; i < member.g.length; i++) {
          const gc = __sw_lower(member.g[i]);
          let present = false;
          for (let j = 0; j < cols.length; j++) {
            if (__sw_lower(cols[j].column) === gc) { present = true; break; }
          }
          if (!present) {
            __sw_structThrow('sw.db.' + verb + ' on a membership-scoped table needs the group column "' + member.g[i] + '" so the platform can verify you belong to that group. Include it in the values.');
          }
        }
      }
      function __sw_structAssertNotMemberGroupColumn(cols, member, verb) {
        for (let i = 0; i < cols.length; i++) {
          const lc = __sw_lower(cols[i].column);
          for (let j = 0; j < member.g.length; j++) {
            if (lc === __sw_lower(member.g[j])) {
              __sw_structThrow403('MEMBER_GROUP_NOT_ASSIGNABLE',
                'sw.db.' + verb + ' cannot change the group column "' + member.g[j] + '" on a membership-scoped table: moving a row between groups would cross the access boundary. Remove it from the update.');
            }
          }
        }
      }

      // ── Whole-number fidelity on the affected-row RETURNING read (tsk_daf4d6d2) ──
      // The database stores whole numbers as 64-bit values; a JavaScript number
      // is only exact to 9007199254740991. On a READ the platform recovers the
      // exact value by re-running the SELECT with a cast-to-text projection
      // (db-result-fidelity.ts). A WRITE cannot be re-run, so the same guard has
      // to be INSIDE the statement: the platform composes the RETURNING list
      // itself and casts any out-of-range whole number to text there, so the
      // affected row comes back exactly as the read path would return it.
      // Before this, a write whose affected row held a 64-bit id COMMITTED and
      // THEN threw DATABASE_VALUE_TOO_LARGE from the read-back — a successful
      // write reported as a failure, and no structured update to such a row was
      // possible even when it did not touch that column.
      //
      // Column names come from the declared schema when the table is managed
      // (free) and otherwise from ONE table-shape read, cached for this request.
      // If the shape cannot be read, or carries a name this builder would not
      // quote, the statement keeps its long-standing RETURNING * (rule 9: the
      // fidelity guard must never turn a working write into a failing one).
      const __sw_returningShapeCache = new Map();

      // The column list RETURNING must project, or null to keep RETURNING *.
      async function __sw_structReturningColumns(label, table) {
        const key = __sw_lower(table);
        if (__sw_returningShapeCache.has(key)) return __sw_returningShapeCache.get(key);
        let cols = null;
        const shape = __sw_structManagedShape(table);
        if (shape) {
          cols = [];
          for (let i = 0; i < shape.columns.length; i++) {
            cols.push({ n: shape.columns[i].n, guard: shape.columns[i].t === 'integer' });
          }
          const ownerColumn = __sw_structResolveOwnerColumn(table);
          if (ownerColumn) {
            let present = false;
            for (let i = 0; i < cols.length; i++) if (cols[i].n === __sw_lower(ownerColumn)) present = true;
            if (!present) cols.push({ n: __sw_lower(ownerColumn), guard: false });
          }
        } else if (!__sw_quotableColumnName(table)) {
          // Unreachable through the builder (the renderer quotes and validates
          // the table first), and the only place a table name is spelled into
          // SQL text rather than bound, so it is checked here on its own.
          cols = null;
        } else {
          // hidden = 1 is a virtual table's hidden column, which SELECT * and
          // RETURNING * both omit; generated columns (2/3) are included by both.
          const shapeSql = "SELECT name, type, hidden FROM pragma_table_xinfo('" + table + "')";
          try {
            const r = await __sw_execOne(label, DB, shapeSql, []);
            const rows = (r && r.results) || [];
            const out = [];
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row || typeof row !== 'object') { out.length = 0; break; }
              if (Number(row.hidden) === 1) continue;
              out.push({ n: row.name, guard: __sw_integerCapableAffinity(row.type) });
            }
            cols = out.length > 0 ? out : null;
          } catch (_) {
            cols = null;
          }
        }
        if (cols) {
          for (let i = 0; i < cols.length; i++) {
            if (!__sw_quotableColumnName(cols[i].n)) { cols = null; break; }
          }
        }
        __sw_returningShapeCache.set(key, cols);
        return cols;
      }

      // THE renderer: a pure function of (IR, principalId, returning). Identifiers
      // are validated + double-quoted; every value — including LIMIT/OFFSET — is a
      // bound ?. For 'user' scope it appends "ownerColumn" = ? (and, for
      // INSERT, adds the owner column + value itself). The owner predicate is
      // NEVER in ir.where; the renderer owns it. The 'returning' argument is the
      // write-path column list resolved above (null keeps RETURNING *).
      function __sw_renderIR(ir, principalId, returning) {
        // Only the 'project' table arm is renderable today. The IR reserves a
        // 'primitive' arm for future platform primitives (users/calendar/inbox/
        // files) that arrive pre-scoped — but the runtime must REJECT it
        // explicitly rather than silently rendering it as a project table (a
        // false affordance). Keep the type arm; refuse it here until supported.
        if (!ir.table || ir.table.kind !== 'project') {
          const err = new Error('sw.db: table kind "' + (ir.table && ir.table.kind) + '" is not yet supported — the structured builder renders project tables only.');
          err.code = 'TABLE_KIND_NOT_SUPPORTED';
          err.status = 400;
          err.__sw_expose = true;
          throw err;
        }
        const params = [];
        const q = __sw_structQuote;
        const tableSql = q(ir.table.name);
        // qualifier is undefined for the single outer table (byte-identical to
        // every pre-join render) and set to the child table name inside a
        // relation EXISTS subquery, where columns must be qualified so a child
        // column never accidentally correlates to the outer root.
        function renderPredicate(p, qualifier) {
          const col = qualifier ? q(qualifier) + '.' + q(p.column) : q(p.column);
          if (p.op === 'is_null') return col + ' IS NULL';
          if (p.op === 'not_null') return col + ' IS NOT NULL';
          if (p.op === 'contains' || p.op === 'starts_with' || p.op === 'ends_with') {
            // The platform composes the pattern: escape the LIKE specials in
            // the caller's string (backslash first, then % and _), wrap with
            // the wildcards the OPERATOR means, and bind the result. The
            // ESCAPE character is platform-authored SQL; the value is a bound
            // ? — a caller % / _ / backslash can only ever match literally.
            // (Backslash via charCode: this source is emitted through a
            // template literal, where escape sequences would collapse.)
            const bs = String.fromCharCode(92);
            const esc = p.value.split(bs).join(bs + bs).split('%').join(bs + '%').split('_').join(bs + '_');
            params.push(p.op === 'contains' ? '%' + esc + '%' : (p.op === 'starts_with' ? esc + '%' : '%' + esc));
            return col + " LIKE ? ESCAPE '" + bs + "'";
          }
          if (p.op === 'in') {
            // Empty IN matches nothing (documented): a constant-false predicate,
            // authored by us, binds no user value. Mirrors mature query builders
            // and spares every caller an empty-array guard.
            if (p.values.length === 0) return '0';
            const marks = [];
            for (let i = 0; i < p.values.length; i++) { marks.push('?'); params.push(p.values[i]); }
            return col + ' IN (' + marks.join(', ') + ')';
          }
          params.push(p.value);
          return col + ' ' + __SW_STRUCT_BINOP[p.op] + ' ?';
        }
        // Relation-existence predicate (composed joins, tsk_1186c9a): the root row
        // survives iff ≥1 child row matches. SQL WE compose — a closed, correlated
        // EXISTS whose WHERE is (child.fk = root.parentKey) AND child preds AND the
        // child's OWN scope predicate. The scope predicate is the SAME owner filter
        // a standalone child query gets, bound to the SAME verified principal:
        // the join key restricts SHAPE, the owner filter restricts ACCESS, never
        // conflated. member() children are refused before this point.
        function relationExistsSql(rf) {
          const childT = q(rf.table);
          // Always alias the child. This is load-bearing for a self relation:
          // without an alias, both nodes.parent_id and nodes.id inside the
          // subquery resolve to the INNER nodes table and the EXISTS stops being
          // correlated to the outer root row.
          const childAliasName = '__sw_rel';
          const childAlias = q(childAliasName);
          const frags = [childAlias + '.' + q(rf.fk) + ' = ' + tableSql + '.' + q(rf.parentKey)];
          for (let i = 0; i < rf.where.length; i++) frags.push(renderPredicate(rf.where[i], childAliasName));
          if (rf.scope.mode === 'user') { frags.push(childAlias + '.' + q(rf.scope.ownerColumn) + ' = ?'); params.push(principalId); }
          // unscoped / server child → no owner predicate (declared cross-user).
          return 'EXISTS (SELECT 1 FROM ' + childT + ' AS ' + childAlias + ' WHERE ' + frags.join(' AND ') + ')';
        }
        // The membership-join predicate (Slice 7): the row's group key must be
        // one the verified user belongs to. SQL WE compose (wall rules hold) —
        // the ONLY bound value is the principal, at the subquery's single ?.
        // Scalar key → "g" IN (SELECT "mg" ...); composite/polymorphic key →
        // row-value ("g1","g2") IN (SELECT "mg1","mg2" ...), which SQLite
        // evaluates element-wise. NEVER placed inside ir.where; the renderer
        // owns it, exactly like the owner predicate.
        function memberPredicate(m) {
          const sub = 'SELECT ' + m.mg.map(q).join(', ') + ' FROM ' + q(m.m) + ' WHERE ' + q(m.u) + ' = ?';
          params.push(principalId);
          const lhs = m.g.length === 1 ? q(m.g[0]) : '(' + m.g.map(q).join(', ') + ')';
          return lhs + ' IN (' + sub + ')';
        }
        function whereSql() {
          const frags = [];
          for (let i = 0; i < ir.where.length; i++) frags.push(renderPredicate(ir.where[i]));
          // Relation-existence filters render BEFORE the root scope predicate so
          // the bound-param order matches the SQL text. Present only on
          // select/count IRs that declared a has filter (rule 9: absent means no
          // change to the composed SQL or its params).
          if (ir.relationWhere) for (let i = 0; i < ir.relationWhere.length; i++) frags.push(relationExistsSql(ir.relationWhere[i]));
          if (ir.scope.mode === 'user') { frags.push(q(ir.scope.ownerColumn) + ' = ?'); params.push(principalId); }
          else if (ir.scope.mode === 'member') { frags.push(memberPredicate(ir.scope.member)); }
          return frags.length ? ' WHERE ' + frags.join(' AND ') : '';
        }
        let sql;
        if (ir.kind === 'select') {
          const cols = (ir.columns && ir.columns.length) ? ir.columns.map(q).join(', ') : '*';
          sql = 'SELECT ' + cols + ' FROM ' + tableSql + whereSql();
          if (ir.order && ir.order.length) {
            sql += ' ORDER BY ' + ir.order.map(function (o) { return q(o.column) + ' ' + (o.dir === 'desc' ? 'DESC' : 'ASC'); }).join(', ');
          }
          // OFFSET requires a preceding LIMIT in SQLite; bind -1 (no limit) when
          // only an offset is asked for. Both operands stay bound.
          if (ir.limit !== undefined) { sql += ' LIMIT ?'; params.push(ir.limit); }
          else if (ir.offset !== undefined) { sql += ' LIMIT ?'; params.push(-1); }
          if (ir.offset !== undefined) { sql += ' OFFSET ?'; params.push(ir.offset); }
        } else if (ir.kind === 'count') {
          sql = 'SELECT COUNT(*) AS count FROM ' + tableSql + whereSql();
        } else if (ir.kind === 'insert') {
          // ir.values is the ordered [{ column, value }] array from the compiler —
          // never a plain object enumerated here, so a caller column key is
          // never an object-key hazard.
          const allCols = ir.values.map(function (e) { return e.column; });
          const ivals = ir.values.map(function (e) { return e.value; });
          if (ir.scope.mode === 'user') { allCols.push(ir.scope.ownerColumn); ivals.push(principalId); }
          if (allCols.length === 0) __sw_structThrow('sw.db.insert requires at least one column value.');
          if (ir.scope.mode === 'member') {
            // Guarded insert: the row lands ONLY if the group it targets is one
            // the verified user belongs to. INSERT … SELECT … WHERE EXISTS keeps
            // it a single composed, atomic statement — no read-then-write race.
            // Zero rows inserted ⇒ the user is not a member of that group; the
            // executor turns the empty RETURNING into a 403. onConflict is
            // refused upstream for member tables, so no ON CONFLICT clause here.
            const m = ir.scope.member;
            const colList = allCols.map(q).join(', ');
            const placeholders = allCols.map(function () { return '?'; }).join(', ');
            for (let i = 0; i < ivals.length; i++) params.push(ivals[i]);
            let existsSql = 'SELECT 1 FROM ' + q(m.m) + ' WHERE ' + q(m.u) + ' = ?';
            params.push(principalId);
            for (let i = 0; i < m.g.length; i++) {
              // The group value the caller supplied for scoped column g[i] is
              // matched against membership column mg[i]. Presence is asserted in
              // __sw_structInsert, so the lookup always resolves.
              let gv = null;
              for (let j = 0; j < ir.values.length; j++) {
                if (__sw_lower(ir.values[j].column) === __sw_lower(m.g[i])) { gv = ir.values[j].value; break; }
              }
              existsSql += ' AND ' + q(m.mg[i]) + ' = ?';
              params.push(gv);
            }
            sql = 'INSERT INTO ' + tableSql + ' (' + colList + ') SELECT ' + placeholders + ' WHERE EXISTS (' + existsSql + ')' + __sw_returningSql(returning);
            return { sql: sql, params: params };
          }
          sql = 'INSERT INTO ' + tableSql + ' (' + allCols.map(q).join(', ') + ') VALUES (' + allCols.map(function () { return '?'; }).join(', ') + ')';
          for (let i = 0; i < ivals.length; i++) params.push(ivals[i]);
          // Upsert (tsk_3e9b033c): targetless ON CONFLICT — the conflict
          // target is whatever PK/unique set the table declares; no arbitrary
          // caller targets in v1. The DO UPDATE SET list is EXACTLY the
          // caller's value columns via excluded.* — the platform-injected
          // owner column is never in it, and on a user-scoped table the
          // platform appends WHERE "owner" = ? so a unique-collision with
          // ANOTHER user's row is a no-op, never a cross-user overwrite.
          if (ir.onConflict === 'ignore') {
            sql += ' ON CONFLICT DO NOTHING';
          } else if (ir.onConflict === 'update') {
            const sets = ir.values.map(function (e) { return q(e.column) + ' = excluded.' + q(e.column); });
            sql += ' ON CONFLICT DO UPDATE SET ' + sets.join(', ');
            if (ir.scope.mode === 'user') { sql += ' WHERE ' + q(ir.scope.ownerColumn) + ' = ?'; params.push(principalId); }
          }
          sql += __sw_returningSql(returning);
        } else if (ir.kind === 'update') {
          if (ir.values.length === 0) __sw_structThrow('sw.db.update requires a non-empty set.');
          const assigns = ir.values.map(function (e) { params.push(e.value); return q(e.column) + ' = ?'; });
          sql = 'UPDATE ' + tableSql + ' SET ' + assigns.join(', ') + whereSql() + __sw_returningSql(returning);
        } else {
          sql = 'DELETE FROM ' + tableSql + whereSql() + __sw_returningSql(returning);
        }
        return { sql: sql, params: params };
      }

      // ── Structured-query instrumentation (tsk_5b91e0e4) ──────────────
      // One bounded JSON line per structured execution: value-free shape
      // fingerprint, deployed operation, table, duration, rows
      // returned/affected, and outcome. NEVER parameter values, NEVER row
      // data. This is the access-map BYPRODUCT of the builder — the platform
      // composed the query, so it records the shape without reading source.
      // The fingerprint mirrors utils/query-manifest.ts EXACTLY (fnv1a64 over
      // the canonical shape string); check-query-instrumentation pins the parity.
      function __sw_fnv1a64Hex(s) {
        let h = 0xcbf29ce484222325n;
        const prime = 0x100000001b3n;
        const mask = 0xffffffffffffffffn;
        for (let i = 0; i < s.length; i++) {
          h ^= BigInt(s.charCodeAt(i));
          h = (h * prime) & mask;
        }
        return h.toString(16).padStart(16, '0');
      }
      // Shared join-segment builder for the shape fingerprint. Mirrors the copy
      // in verify/contracts/query-manifest.ts byte-for-byte.
      function __sw_structRelScopeStr(scope) {
        return scope.mode === 'user' ? 'user.' + __sw_lower(scope.ownerColumn)
          : (scope.mode === 'member' ? 'mem.' + __sw_lower(scope.member.m)
          : (scope.mode === 'server' ? 'srv' : 'un'));
      }
      function __sw_structJoinSeg(ir) {
        const inc = ir.include || [];
        const rw = ir.relationWhere || [];
        if (!inc.length && !rw.length) return '';
        const lc = function (x) { return __sw_lower(x); };
        const incStr = inc.map(function (r) {
          return lc(r.name) + '>' + lc(r.table) + '.' + lc(r.fk) + '.' + lc(r.parentKey) + '.' + __sw_structRelScopeStr(r.scope);
        }).slice().sort().join(';');
        const rwStr = rw.map(function (r) {
          return lc(r.name) + '>' + lc(r.table) + '.' + lc(r.fk) + '.' + lc(r.parentKey) + '.' + __sw_structRelScopeStr(r.scope) +
            ':' + (r.where || []).map(function (p) { return lc(p.column) + '.' + p.op; }).join(',');
        }).slice().sort().join(';');
        return '|j:i=' + incStr + ';w=' + rwStr;
      }
      function __sw_structShapeCanonical(ir) {
        const lc = function (x) { return __sw_lower(x); };
        const sel = ir.kind === 'select' && ir.columns && ir.columns.length ? ir.columns.map(lc).join(';') : '*';
        const flt = (ir.where || []).map(function (p) { return lc(p.column) + '.' + p.op; }).join(';');
        const ord = (ir.order || []).map(function (o) { return lc(o.column) + '.' + o.dir; }).join(';');
        const wr = (ir.values || []).map(function (e) { return lc(e.column); }).join(';');
        // 'srv' = explicit server-mode (asServer) — distinct from 'un'
        // (declared shared/server_only) so telemetry can see sanctioned
        // cross-user reads on owner tables. |oc: appends ONLY when an
        // upsert clause is present, so every pre-existing shape keeps its
        // exact fingerprint.
        const sc = ir.scope.mode === 'user' ? 'user.' + lc(ir.scope.ownerColumn)
          : (ir.scope.mode === 'member' ? 'mem.' + lc(ir.scope.member.m)
          : (ir.scope.mode === 'server' ? 'srv' : 'un'));
        // Composed-join segment (tsk_1186c9a). Appended ONLY when include /
        // relationWhere are present, so every pre-join shape keeps its exact
        // fingerprint (rule 9). Sorted by relation name so declaration order
        // does not change a view's identity. Mirrors queryShapeCanonical in
        // verify/contracts/query-manifest.ts EXACTLY.
        return 'v2|' + ir.kind + '|' + lc(ir.table.name) + '|s:' + sel + '|f:' + flt + '|o:' + ord +
          '|l:' + (ir.limit !== undefined ? '1' : '0') + '|of:' + (ir.offset !== undefined ? '1' : '0') +
          '|w:' + wr + '|sc:' + sc + (ir.onConflict ? '|oc:' + ir.onConflict : '') + __sw_structJoinSeg(ir);
      }
      const __sw_structFpMemo = new Map();
      function __sw_structFingerprint(ir) {
        const canonical = __sw_structShapeCanonical(ir);
        let fp = __sw_structFpMemo.get(canonical);
        if (!fp) {
          fp = __sw_fnv1a64Hex(canonical);
          if (__sw_structFpMemo.size < 256) __sw_structFpMemo.set(canonical, fp);
        }
        return fp;
      }
      // WALL RULE 3 (types/query-ir.ts): the platform records what it
      // composed. This emission IS the record — a byproduct of composition,
      // never a reconstruction from reading code. Do not remove it as
      // "just logging"; the persistence sink consumes it. NB: no backticks
      // in this file — it is emitted inside a template literal.
      function __sw_emitQueryEvent(ir, ms, rows, ok, code) {
        try {
          const fp = __sw_structFingerprint(ir);
          const fn = (request && request.__sw_fn) || null;
          console.log(JSON.stringify({
            event: 'SW_QUERY', fp: fp, op: ir.kind,
            table: lcTable(ir), fn: fn, ms: ms, rows: rows, ok: ok,
            code: code || undefined,
            // Server-mode reads are unscoped-marked — the same honest
            // cross-user annotation raw { unscoped: true } carries.
            unscoped: ir.scope.mode === 'server' ? true : undefined,
          }));
          __sw_bufferQueryObservation(fp, ir.kind, lcTable(ir), fn, ms, rows, ok);
        } catch (_) { /* instrumentation must never affect the query */ }
        function lcTable(x) { return __sw_lower((x.table && x.table.name) || '').slice(0, 64); }
      }

      // WALL RULE 3 sink (tsk_7bcfbdbe): the record above PERSISTS. Events
      // aggregate into a bounded per-request buffer (shape metadata only —
      // fingerprint, op, table, fn, counts, latency; NEVER parameter values
      // or row contents) and flush fire-and-forget over the project runtime
      // credential — the same transport idiom as the size observation. The
      // sink can never block, slow, or fail the query path: buffering runs
      // inside the emit try/catch, the flush rides __sw_pendingBackground,
      // and a flush failure is swallowed after a console.warn.
      function __sw_bufferQueryObservation(fp, op, table, fn, ms, rows, ok) {
        if (isDraftExecution) return; // draft traffic must not pollute live observations
        if (!request || typeof request !== 'object') return;
        let buf = request.__sw_queryObs;
        if (!buf) {
          buf = { byFp: Object.create(null), fps: 0, dropped: 0, scheduled: false };
          request.__sw_queryObs = buf;
        }
        let agg = buf.byFp[fp];
        if (!agg) {
          if (buf.fps >= 64) { buf.dropped++; __sw_scheduleQueryObsFlush(buf); return; }
          buf.fps++;
          agg = buf.byFp[fp] = { fp: fp, op: op, table: table, fn: fn, n: 0, err: 0, ms_sum: 0, ms_max: 0, rows_sum: 0 };
        }
        agg.n++;
        if (!ok) agg.err++;
        if (ms > 0) { agg.ms_sum += ms; if (ms > agg.ms_max) agg.ms_max = ms; }
        if (rows > 0) agg.rows_sum += rows;
        __sw_scheduleQueryObsFlush(buf);
      }
      function __sw_scheduleQueryObsFlush(buf) {
        if (buf.scheduled) return;
        buf.scheduled = true;
        const flush = new Promise(function (resolve) { setTimeout(resolve, 20); }).then(function () {
          buf.scheduled = false;
          const list = [];
          for (const key in buf.byFp) list.push(buf.byFp[key]);
          const dropped = buf.dropped;
          buf.byFp = Object.create(null); buf.fps = 0; buf.dropped = 0;
          if (list.length === 0 && dropped === 0) return;
          return platformFetch('/v1/db/query-observations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ observations: list, dropped: dropped }),
          }).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
          });
        }).catch(function (error) {
          console.warn('[SW_QUERY_OBSERVATIONS] deferred flush failed: ' + ((error && error.message) || String(error)));
        });
        __sw_pendingBackground.push(flush);
      }

      function __sw_liveSafeCopy(value) {
        try { return __sw_jsonParse(JSON.stringify(value)); } catch (_) { return null; }
      }

      function __sw_liveViewByName(name) {
        for (let i = 0; i < LIVE_MANIFEST.liveViews.length; i++) {
          const view = LIVE_MANIFEST.liveViews[i];
          if (view && view.name === name) return view;
        }
        return null;
      }

      async function __sw_liveDeclare(name, read) {
        const result = await read;
        if (typeof name !== 'string' || !name || arguments.length !== 2) {
          __sw_structThrow('sw.db.live takes exactly (name, read).');
        }
        const view = __sw_liveViewByName(name);
        if (!view) {
          __sw_structThrow403('LIVE_VIEW_NOT_DECLARED', 'sw.db.live("' + name + '") is not declared by this release. Declare the exact composed read directly in sw.db.live(name, sw.db.from(...)) and deploy.');
        }
        const brand = result && typeof result === 'object' ? __sw_liveReadBrands.get(result) : null;
        if (!brand || brand.fingerprint !== view.fingerprint) {
          __sw_structThrow403('LIVE_READ_NOT_COMPOSED', 'sw.db.live requires the exact successful sw.db.from result declared for this name. A raw query, cloned result, failed read, or different composed shape cannot mint a subscription.');
        }
        const dependency = view.dependencies && view.dependencies.find(function (item) { return item.kind === 'rows'; });
        if (!dependency || dependency.scope.mode === 'member') {
          __sw_structThrow403('LIVE_VIEW_MEMBER_SCOPE_UNSUPPORTED', 'sw.db.live does not subscribe member() scoped tables yet. Use owner() or shared() for a named live view.');
        }
        const subject = __sw_liveSubject(brand.ir, brand.principalId);
        if (!subject) {
          __sw_structThrow403('LIVE_SCOPE_NOT_SUBSCRIBABLE', 'This composed read scope cannot mint a live subscription.');
        }
        let response;
        try {
          response = await platformFetch('/v1/live/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId: projectId,
              releaseId: env.SW_RELEASE_ID || '',
              name: name,
              fingerprint: brand.fingerprint,
              subject: subject,
              ir: brand.ir,
            }),
          });
        } catch (_) { response = null; }
        let payload = null;
        try { payload = response ? await response.json() : null; } catch (_) { payload = null; }
        if (!response || !response.ok || !payload || !payload.ok || !payload.data || !payload.data.subscribe_path) {
          return Object.assign({}, result, {
            live: { name: name, state: 'resync_required', reason: (payload && (payload.error || payload.code)) || 'REGISTRATION_UNAVAILABLE' },
          });
        }
        const subscribeTarget = new URL(payload.data.subscribe_path, request.url);
        subscribeTarget.protocol = subscribeTarget.protocol === 'https:' ? 'wss:' : 'ws:';
        return Object.assign({}, result, {
          live: {
            name: name,
            state: 'ready',
            release_id: env.SW_RELEASE_ID,
            fingerprint: brand.fingerprint,
            subscribe_url: subscribeTarget.toString(),
            expires_at: payload.data.expires_at,
          },
        });
      }

      async function __sw_structExec(label, ir, principalId, mutation) {
        ensureBinding();
        const __sw_t0 = Date.now();
        let rendered;
        try {
          rendered = __sw_renderIR(ir, principalId, null);
        } catch (err) {
          __sw_emitQueryEvent(ir, Date.now() - __sw_t0, 0, false, err && err.code);
          throw err;
        }
        // Writes project their affected row through a fidelity-guarded
        // RETURNING list (tsk_daf4d6d2). Resolved AFTER the render above so a
        // rejected call still reaches zero transport, and re-rendered rather
        // than patched — the renderer is a pure function, so the second pass
        // produces the same statement with the guarded projection and the
        // identical bound params. Reads never take this path: same call, same
        // SQL, same params as before.
        if (ir.kind === 'insert' || ir.kind === 'update' || ir.kind === 'delete') {
          const returning = await __sw_structReturningColumns(label, ir.table.name);
          if (returning) rendered = __sw_renderIR(ir, principalId, returning);
        }
        let r;
        const liveReadFingerprint = ir.kind === 'select' ? __sw_structFingerprint(ir) : null;
        const liveReadDeclared = !!liveReadFingerprint && LIVE_MANIFEST.liveViews.some(function (view) {
          return view && view.fingerprint === liveReadFingerprint;
        });
        try {
          r = await __sw_execOne(label, DB, rendered.sql, rendered.params);
        } catch (err) {
          __sw_emitQueryEvent(ir, Date.now() - __sw_t0, 0, false, (err && err.code) || 'DB_ERROR');
          throw err;
        }
        const rows = r.results || [];
        __sw_emitQueryEvent(ir, Date.now() - __sw_t0, mutation ? ((r.meta && r.meta.changes) || rows.length) : rows.length, true, null);
        // Member-scoped insert is guarded (INSERT … WHERE EXISTS membership).
        // Zero rows back means the EXISTS was false: the verified user does not
        // belong to the group this row targets. Surface it as an explicit 403
        // BEFORE any realtime publish — the row never landed.
        if (ir.kind === 'insert' && ir.scope.mode === 'member' && rows.length === 0) {
          __sw_structThrow403('MEMBERSHIP_REQUIRED',
            'sw.db.insert on "' + ir.table.name + '": you can only add rows to a group you belong to, and the signed-in user is not a member of the group named in this row. Add the user to the group first, or write to a group they belong to.');
        }
        if (ir.kind === 'count') {
          // count() returns exactly { data, error } — data holds the scalar
          // aggregate. NO .count key: elsewhere in the builder .count means ROWS
          // RETURNED, so re-using it for the aggregate would overload a word
          // that already has a meaning. No last_row_id/changes noise either.
          const n = rows.length ? Number(rows[0].count) : 0;
          return { data: Number.isFinite(n) ? n : 0, error: null };
        }
        let liveDelivery = null;
        if (mutation) {
          // The structured path KNOWS the table + op — publish realtime and
          // record size directly, never round-tripping through the SQL parser.
          __sw_deferDbSizeObservation(r);
          __sw_publishDbMutation(mutation.table, mutation.op, rows);
          // Invalidation contains no row data and is never an authoritative
          // delta. A failure cannot undo the committed write; clients repair
          // through their mandatory function refresh policy.
          liveDelivery = await __sw_publishStructuredLiveInvalidation(ir, mutation, principalId);
        }
        const result = {
          data: rows,
          error: null,
          count: rows.length,
          last_row_id: (r.meta && r.meta.last_row_id) || null,
          changes: (r.meta && r.meta.changes) || 0,
        };
        if (ir.kind === 'select' && liveReadDeclared) {
          const copiedIr = __sw_liveSafeCopy(ir);
          if (copiedIr) {
            __sw_liveReadBrands.set(result, {
              ir: copiedIr,
              principalId: principalId,
              fingerprint: liveReadFingerprint,
            });
          }
        }
        if (liveDelivery) result.live_delivery = liveDelivery;
        return result;
      }

      // ── Composed joins (tsk_1186c9a) ─────────────────────────────────────
      // THE SCOPE-COMPOSITION INVARIANT: a relation key shapes the relationship;
      // it is NEVER trusted for access. Every participating table independently
      // carries its OWN owner predicate, bound to the ONE runtime-verified
      // principal, resolved by the SAME __sw_structResolveScope a standalone
      // query uses. So user↔user is the same subject BY CONSTRUCTION; member()
      // participants are refused, never silently joined.
      function __sw_structThrowJoinMember(where) {
        __sw_structThrow403('JOIN_MEMBER_SCOPE_UNSUPPORTED',
          'sw.db.from: ' + where + ' is membership-scoped, and composed joins do not support member() tables yet. A membership join is refused rather than mixed into another scope — read it in a separate query, or declare the table owner()/shared().');
      }
      // Refuse joins on a membership-scoped ROOT. Checked by the table's DECLARED
      // member spec (not the resolved mode) so a member table stays refused even
      // under asServer, where it would otherwise resolve to 'server' — member
      // tables simply do not participate in a composed join in this slice.
      function __sw_structAssertJoinRootScope(rootTable, present) {
        if (present && __sw_structResolveMember(rootTable)) __sw_structThrowJoinMember('the table "' + rootTable + '"');
      }
      // Refuse every DECLARED member participant before resolving any request
      // identity. This makes JOIN_MEMBER_SCOPE_UNSUPPORTED a true zero-transport
      // refusal: neither the root nor a child can trigger auth verification (or
      // a database statement) before the runtime rejects the join.
      function __sw_structPreflightJoinMembers(rootTable, includeOpt, hasOpt) {
        const includePresent = includeOpt !== undefined && includeOpt !== null
          && (!__sw_arrayIsArray(includeOpt) || includeOpt.length > 0);
        const hasPresent = hasOpt !== undefined && hasOpt !== null
          && (typeof hasOpt !== 'object' || __sw_arrayIsArray(hasOpt) || __sw_keys(hasOpt).length > 0);
        if (!includePresent && !hasPresent) return;
        __sw_structAssertJoinRootScope(rootTable, true);
        if (__sw_arrayIsArray(includeOpt)) {
          for (let i = 0; i < includeOpt.length; i++) {
            if (typeof includeOpt[i] !== 'string') continue;
            const rel = __sw_structResolveRelation(rootTable, includeOpt[i]);
            if (rel && __sw_structResolveMember(rel.table)) {
              __sw_structThrowJoinMember('relation "' + rel.name + '" (table "' + rel.table + '")');
            }
          }
        }
        if (hasOpt && typeof hasOpt === 'object' && !__sw_arrayIsArray(hasOpt)) {
          const keys = __sw_keys(hasOpt);
          for (let i = 0; i < keys.length; i++) {
            const rel = __sw_structResolveRelation(rootTable, keys[i]);
            if (rel && __sw_structResolveMember(rel.table)) {
              __sw_structThrowJoinMember('relation "' + rel.name + '" (table "' + rel.table + '")');
            }
          }
        }
      }
      // Resolve a relation CHILD's own scope via the standalone resolver — its
      // access posture cannot drift from its single-table posture. member() is
      // refused up front (before auth resolution) so it is a clear
      // JOIN_MEMBER_SCOPE_UNSUPPORTED regardless of sign-in state.
      async function __sw_structResolveRelationScope(rel, asServer) {
        if (__sw_structResolveMember(rel.table)) {
          __sw_structThrowJoinMember('relation "' + rel.name + '" (table "' + rel.table + '")');
        }
        const decided = await __sw_structResolveScope(rel.table, 'from', asServer);
        // member is handled above; only user | unscoped | server reach here.
        return decided;
      }
      // Validate a relation predicate's columns against the CHILD's managed
      // shape (unmanaged child → no column list, same as a single-table read).
      function __sw_structAssertRelationPredicateColumns(childTable, preds) {
        const shape = __sw_structManagedShape(childTable);
        if (!shape) return;
        const ownerColumn = __sw_structResolveOwnerColumn(childTable);
        for (let i = 0; i < preds.length; i++) {
          __sw_structAssertKnownColumn('from', childTable, shape, ownerColumn, preds[i].column, 'has["' + childTable + '"]');
        }
      }
      async function __sw_structCompileInclude(rootTable, includeOpt, columns, asServer) {
        if (includeOpt === undefined || includeOpt === null) return [];
        if (!__sw_arrayIsArray(includeOpt)) __sw_structThrow('sw.db.from: include must be an array of declared relation names.');
        __sw_structAssertJoinRootScope(rootTable, includeOpt.length > 0);
        const out = [];
        const seen = __sw_objCreateNull();
        for (let i = 0; i < includeOpt.length; i++) {
          const name = includeOpt[i];
          if (typeof name !== 'string' || !name) __sw_structThrow('sw.db.from: include entries must be relation names (strings).');
          const rel = __sw_structResolveRelation(rootTable, name);
          if (!rel) __sw_structThrow403('RELATION_NOT_DECLARED', 'sw.db.from on "' + rootTable + '": relation "' + name + '" is not declared. Declare it in db/schema.ts with relations: { ' + __sw_lower(name) + ': hasMany("child_table", "foreign_key") } and then deploy.');
          if (seen[rel.name]) __sw_structThrow('sw.db.from: relation "' + name + '" is included more than once.');
          seen[rel.name] = true;
          const decided = await __sw_structResolveRelationScope(rel, asServer);
          out.push({
            ref: { name: rel.name, table: rel.table, fk: rel.fk, parentKey: rel.parentKey, scope: decided.scope },
            principalId: decided.principalId,
          });
        }
        // Stitching matches child.fk to root.parentKey, so the parent key must be
        // in the projected columns. Require it explicitly rather than silently
        // widening the projection (which would change the returned row shape).
        if (out.length && columns) {
          for (let i = 0; i < out.length; i++) {
            const pk = out[i].ref.parentKey;
            let present = false;
            for (let j = 0; j < columns.length; j++) { if (__sw_lower(columns[j]) === pk) { present = true; break; } }
            if (!present) __sw_structThrow('sw.db.from: include needs the key column "' + pk + '" among columns so each row can be matched to its related rows — add "' + pk + '" to columns, or omit columns to select all.');
          }
        }
        return out;
      }
      async function __sw_structCompileHas(rootTable, hasOpt, asServer) {
        if (hasOpt === undefined || hasOpt === null) return [];
        if (typeof hasOpt !== 'object' || __sw_arrayIsArray(hasOpt)) __sw_structThrow('sw.db.from: has must be an object of { relationName: { …child conditions } }.');
        const keys = __sw_keys(hasOpt);
        __sw_structAssertJoinRootScope(rootTable, keys.length > 0);
        const out = [];
        for (let i = 0; i < keys.length; i++) {
          const name = keys[i];
          const rel = __sw_structResolveRelation(rootTable, name);
          if (!rel) __sw_structThrow403('RELATION_NOT_DECLARED', 'sw.db.from on "' + rootTable + '": relation "' + name + '" is not declared. Declare it in db/schema.ts with relations: { ' + __sw_lower(name) + ': hasMany("child_table", "foreign_key") } and then deploy.');
          // The value is the child WHERE (same grammar). Quantifier is implicitly
          // 'some' (EXISTS ≥1 matching child); none/every are not in this slice.
          const childPreds = __sw_structCompileWhere(hasOpt[name]);
          __sw_structAssertRelationPredicateColumns(rel.table, childPreds);
          const decided = await __sw_structResolveRelationScope(rel, asServer);
          out.push({
            ref: { name: rel.name, table: rel.table, fk: rel.fk, parentKey: rel.parentKey, scope: decided.scope, quantifier: 'some', where: childPreds },
            principalId: decided.principalId,
          });
        }
        return out;
      }
      // A join can have an unscoped root and an owner()-scoped child. In that
      // shape the root has no principal of its own, so keep the principal the
      // CHILD resolver verified instead of accidentally binding undefined.
      // Multiple owner() participants must resolve to the exact same request
      // principal; the request-local identity memo makes that true by
      // construction, and this assertion fails closed if that ever regresses.
      function __sw_structJoinPrincipal(rootDecision, includeCompiled, hasCompiled) {
        // Preserve the existing standalone member() principal too. A member
        // JOIN cannot reach here (the preflight above refuses it), but an
        // ordinary relation-free member read still uses this execution path.
        let principalId = (rootDecision.scope.mode === 'user' || rootDecision.scope.mode === 'member')
          ? rootDecision.principalId : undefined;
        const all = includeCompiled.concat(hasCompiled);
        for (let i = 0; i < all.length; i++) {
          if (all[i].ref.scope.mode !== 'user') continue;
          const childId = all[i].principalId;
          if (principalId === undefined) principalId = childId;
          else if (principalId !== childId) {
            __sw_structThrow403('JOIN_SCOPE_MISMATCH',
              'sw.db.from: the participating owner()-scoped tables did not resolve to one request principal, so the join was refused.');
          }
        }
        return principalId;
      }
      // Root-plus-child stitch for include: the root rows are already fetched;
      // for each relation, fetch the children INDEPENDENTLY SCOPED (child.owner
      // = principal is composed by the standard renderer, never by the join
      // key) with fk IN (root keys), then attach them by key. Small reads use one
      // child fetch; large key sets use bounded child batches. Every child fetch
      // is its own composed IR — independently rendered, scoped, and instrumented.
      async function __sw_structAttachIncludes(result, includeRefs, principalId) {
        const rows = (result && result.data) || [];
        for (let r = 0; r < includeRefs.length; r++) {
          const rel = includeRefs[r];
          const ids = [];
          const seenId = __sw_objCreateNull();
          for (let i = 0; i < rows.length; i++) {
            const key = rows[i] ? rows[i][rel.parentKey] : undefined;
            if (key === undefined || key === null) continue;
            const sk = typeof key + ':' + String(key);
            if (seenId[sk]) continue;
            seenId[sk] = true;
            ids.push(key);
          }
          const grouped = __sw_objCreateNull();
          if (ids.length) {
            // The database accepts at most 100 bound parameters per statement.
            // An owner()-scoped child needs one bind for its principal, so batch
            // parent keys at 99. Small includes stay the ordinary two-query
            // stitch; large includes remain complete instead of failing at the
            // transport's bind ceiling.
            const maxKeys = 99;
            for (let start = 0; start < ids.length; start += maxKeys) {
              const childIr = {
                v: 1, kind: 'select', table: { kind: 'project', name: rel.table },
                columns: undefined, where: [{ op: 'in', column: rel.fk, values: ids.slice(start, start + maxKeys) }],
                scope: rel.scope,
              };
              const childResult = await __sw_structExec('sw.db.from', childIr, principalId, null);
              const childRows = (childResult && childResult.data) || [];
              for (let i = 0; i < childRows.length; i++) {
                const fkVal = childRows[i] ? childRows[i][rel.fk] : undefined;
                if (fkVal === undefined || fkVal === null) continue;
                const gk = typeof fkVal + ':' + String(fkVal);
                (grouped[gk] || (grouped[gk] = [])).push(childRows[i]);
              }
            }
          }
          for (let i = 0; i < rows.length; i++) {
            if (!rows[i] || typeof rows[i] !== 'object') continue;
            const key = rows[i][rel.parentKey];
            const gk = (key === undefined || key === null) ? null : typeof key + ':' + String(key);
            rows[i][rel.name] = (gk !== null && grouped[gk]) ? grouped[gk] : [];
          }
        }
      }

      async function __sw_structFrom(table, opts) {
        opts = __sw_structReadOpts(opts, ['where', 'order', 'limit', 'offset', 'columns', 'asServer', 'include', 'has'], 'sw.db.from');
        let columns;
        if (opts.columns !== undefined && opts.columns !== null) {
          if (!__sw_arrayIsArray(opts.columns)) __sw_structThrow('sw.db.from: columns must be an array of column names.');
          columns = opts.columns.slice();
        }
        __sw_structPreflightJoinMembers(table, opts.include, opts.has);
        const decided = await __sw_structResolveScope(table, 'from', opts.asServer);
        // Composed joins (tsk_1186c9a): resolve declared relations. Both absent →
        // ir.include / ir.relationWhere stay unset and the IR (and its shape
        // fingerprint) is byte-identical to a pre-join single-table read (rule 9).
        const includeCompiled = await __sw_structCompileInclude(table, opts.include, columns, opts.asServer);
        const hasCompiled = await __sw_structCompileHas(table, opts.has, opts.asServer);
        const includeRefs = includeCompiled.map(function (entry) { return entry.ref; });
        const relationWhere = hasCompiled.map(function (entry) { return entry.ref; });
        const joinPrincipalId = __sw_structJoinPrincipal(decided, includeCompiled, hasCompiled);
        const ir = {
          v: 1, kind: 'select', table: { kind: 'project', name: table },
          columns: columns, where: __sw_structCompileWhere(opts.where),
          order: __sw_structCompileOrder(opts.order),
          limit: __sw_structIntOpt(opts.limit, 'limit'), offset: __sw_structIntOpt(opts.offset, 'offset'),
          scope: decided.scope,
        };
        if (includeRefs.length) ir.include = includeRefs;
        if (relationWhere.length) ir.relationWhere = relationWhere;
        __sw_structEnforceSchema('from', ir);
        const result = await __sw_structExec('sw.db.from', ir, joinPrincipalId, null);
        if (includeRefs.length) await __sw_structAttachIncludes(result, includeRefs, joinPrincipalId);
        return result;
      }

      async function __sw_structCount(table, opts) {
        opts = __sw_structReadOpts(opts, ['where', 'asServer'], 'sw.db.count');
        const decided = await __sw_structResolveScope(table, 'count', opts.asServer);
        const ir = { v: 1, kind: 'count', table: { kind: 'project', name: table }, where: __sw_structCompileWhere(opts.where), scope: decided.scope };
        __sw_structEnforceSchema('count', ir);
        return __sw_structExec('sw.db.count', ir, decided.principalId, null);
      }

      async function __sw_structInsert(table, values, opts) {
        opts = __sw_structReadOpts(opts, ['onConflict'], 'sw.db.insert');
        let onConflict;
        if (opts.onConflict !== undefined && opts.onConflict !== null) {
          if (opts.onConflict !== 'ignore' && opts.onConflict !== 'update') {
            __sw_structThrow('sw.db.insert: onConflict must be "ignore" (keep the existing row) or "update" (update it with these values).');
          }
          onConflict = opts.onConflict;
        }
        const cols = __sw_structCompileValues(values, 'sw.db.insert');
        const decided = await __sw_structResolveScope(table, 'insert');
        if (decided.scope.mode === 'user') __sw_structAssertNotOwnerColumn(cols, decided.scope.ownerColumn, 'insert');
        if (decided.scope.mode === 'member') {
          if (onConflict !== undefined) {
            __sw_structThrow('sw.db.insert on "' + table + '": onConflict is not supported on membership-scoped tables yet. Insert without onConflict.');
          }
          __sw_structAssertMemberGroupPresent(cols, decided.scope.member, 'insert');
        }
        if (cols.length === 0 && decided.scope.mode !== 'user') __sw_structThrow('sw.db.insert requires at least one column value.');
        if (onConflict === 'update' && cols.length === 0) {
          __sw_structThrow('sw.db.insert with { onConflict: "update" } needs at least one column value to update on conflict — use { onConflict: "ignore" } to leave the existing row as-is.');
        }
        const ir = { v: 1, kind: 'insert', table: { kind: 'project', name: table }, where: [], values: cols, onConflict: onConflict, scope: decided.scope };
        __sw_structEnforceSchema('insert', ir);
        return __sw_structExec('sw.db.insert', ir, decided.principalId, { op: 'insert', table: table });
      }

      async function __sw_structUpdate(table, spec) {
        spec = __sw_structReadOpts(spec, ['set', 'where'], 'sw.db.update');
        const cols = __sw_structCompileValues(spec.set, 'sw.db.update');
        if (cols.length === 0) __sw_structThrow('sw.db.update requires a non-empty set.');
        const decided = await __sw_structResolveScope(table, 'update');
        if (decided.scope.mode === 'user') __sw_structAssertNotOwnerColumn(cols, decided.scope.ownerColumn, 'update');
        if (decided.scope.mode === 'member') __sw_structAssertNotMemberGroupColumn(cols, decided.scope.member, 'update');
        const ir = { v: 1, kind: 'update', table: { kind: 'project', name: table }, where: __sw_structCompileWhere(spec.where), values: cols, scope: decided.scope };
        __sw_structEnforceSchema('update', ir);
        return __sw_structExec('sw.db.update', ir, decided.principalId, { op: 'update', table: table });
      }

      async function __sw_structRemove(table, spec) {
        spec = __sw_structReadOpts(spec, ['where'], 'sw.db.remove');
        const decided = await __sw_structResolveScope(table, 'remove');
        const ir = { v: 1, kind: 'delete', table: { kind: 'project', name: table }, where: __sw_structCompileWhere(spec.where), scope: decided.scope };
        __sw_structEnforceSchema('remove', ir);
        return __sw_structExec('sw.db.remove', ir, decided.principalId, { op: 'delete', table: table });
      }

      return {
        async query(sql, params, options) {
          ensureBinding();
          __sw_assertSingleStatement(sql);
          __sw_assertNoDdl(sql);
          options = options || {};
          // { user } is retired (tsk_fde5d117): the platform never rewrites
          // raw SQL to inject an owner filter. THROW — never silently run the
          // SQL unscoped, which would turn every previously scoped call into
          // a full-table read. This check runs BEFORE any transport is
          // touched, so a { user } call never reaches the database.
          if (__sw_own(options, 'user')) {
            __sw_throwRawSqlCannotBePlatformScoped('sw.db.query');
          }
          // { unscoped: true } stays accepted as a no-op annotation: an honest
          // marker of intentional cross-user access (recorded in release
          // manifests). Raw SQL is trusted server code and runs as written.
          // Managed mode: execute on the read-only capability so a raw write
          // cannot commit (the provider refuses it → MANAGED_RAW_WRITE_FORBIDDEN);
          // reads pass through. sql mode: the write-capable binding, unchanged.
          const r = await __sw_execOne('sw.db.query', rawSqlDb(), sql, params);
          const rows = r.results || [];
          // tsk_5523b9: auto-publish a realtime event for mutations.
          // tsk_2bf7d327: include any returned row(s) (when RETURNING).
          const mut = __sw_mutationOf(sql);
          if (mut) {
            __sw_deferDbSizeObservation(r);
            __sw_publishDbMutation(mut.table, mut.op, rows);
          }
          // Writes return meta.last_row_id (INSERT rowid) and meta.changes
          // (rows touched by INSERT/UPDATE/DELETE). Surface both so callers
          // can grab the auto-increment id without a follow-up SELECT.
          return {
            data: rows,
            error: null,
            count: rows.length,
            last_row_id: (r.meta && r.meta.last_row_id) || null,
            changes: (r.meta && r.meta.changes) || 0,
          };
        },
        async batch(statements, options) {
          ensureBinding();
          if (!Array.isArray(statements) || statements.length === 0) {
            const err = new Error('sw.db.batch requires a non-empty array of { sql, params }.');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          for (const s of statements) {
            __sw_assertSingleStatement(s.sql);
            __sw_assertNoDdl(s.sql);
          }
          options = options || {};
          // { user } is retired here too (tsk_fde5d117) — same loud fail as
          // sw.db.query, before any transport is touched. { unscoped: true }
          // remains an accepted no-op annotation.
          if (__sw_own(options, 'user')) {
            __sw_throwRawSqlCannotBePlatformScoped('sw.db.batch');
          }
          // Managed mode: the read-only capability serves an all-reads batch and
          // refuses any write (MANAGED_RAW_WRITE_FORBIDDEN) — nothing commits.
          // sql mode: the write-capable binding, atomic as before.
          const rawDb = rawSqlDb();
          const results = await __sw_execBatch('sw.db.batch', rawDb, statements);
          if (statements.some(function(s) { return !!__sw_mutationOf(s.sql); })) {
            __sw_deferDbSizeObservation(results);
          }
          // tsk_5523b9: one realtime publish per mutating statement.
          // Batches are atomic at the DB layer so it's safe to fire
          // the events after the batch resolves — by definition every
          // statement either committed or none did.
          // tsk_2bf7d327: include that statement's returned row(s),
          // index-aligned with the batch result set.
          for (let i = 0; i < statements.length; i++) {
            const mut = __sw_mutationOf(statements[i].sql);
            if (mut) __sw_publishDbMutation(mut.table, mut.op, (results[i] && results[i].results) || []);
          }
          return results.map((r) => ({
            data: r.results || [],
            changes: (r.meta && r.meta.changes) || 0,
            last_row_id: (r.meta && r.meta.last_row_id) || null,
          }));
        },
        async migrate(_sql) {
          // sw.db.migrate was removed from the function runtime
          // 2026-05-21 (tsk_a9f1fee70). Schema changes must run with
          // developer credentials so a public handler can't ALTER /
          // DROP at request time. Same shape of error as the DDL
          // guard so call sites get a consistent recovery message.
          const err = new Error(
            'sw.db.migrate was removed from the function runtime (2026-05-21). ' +
            'Run schema changes with developer credentials: use the CLI ' +
            'somewhere fetch /v1/db/migrate, the db_migrate MCP tool, or the ' +
            'dashboard Database tab.'
          );
          err.code = 'DDL_NOT_ALLOWED_IN_FUNCTION';
          // Same as the raw-SQL DDL guard above: expose as 403 so the recovery
          // message reaches the developer instead of a 500 FUNCTION_ERROR.
          err.status = 403;
          err.__sw_expose = true;
          throw err;
        },
        async tables() {
          ensureBinding();
          // Hide platform-reserved tables: leading-underscore (fts index,
          // cf internal) and sqlite_ system tables.
          const r = await DB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'sqlite_%'"
          ).all();
          return (r.results || []).map((row) => row.name);
        },
        scope: __sw_scopeDeclare,
        // Structured query builder (tsk_5b91e0e4). The platform composes,
        // renders, and scopes these — see the __sw_struct* helpers above.
        // sw.db.delete is a trivial alias of sw.db.remove (both call the same
        // composer). The retired scope argument fails loudly, never silently.
        from(table, opts, legacyScope) { __sw_structNoScopeArg(legacyScope, 'from'); return __sw_structFrom(table, opts); },
        live(name, read) {
          if (arguments.length !== 2) __sw_structThrow('sw.db.live takes exactly (name, read).');
          return __sw_liveDeclare(name, read);
        },
        count(table, opts, legacyScope) { __sw_structNoScopeArg(legacyScope, 'count'); return __sw_structCount(table, opts); },
        // insert's third argument is the OPTIONS object ({ onConflict } —
        // tsk_3e9b033c). The retired scope-argument shapes ({ user }, {
        // unscoped }) still fail loudly as before: they used to change
        // semantics, so they must never be read as options.
        insert(table, values, opts) {
          if (opts !== undefined && opts !== null && typeof opts === 'object' && !__sw_arrayIsArray(opts) && (__sw_own(opts, 'user') || __sw_own(opts, 'unscoped'))) {
            __sw_structNoScopeArg(opts, 'insert');
          }
          return __sw_structInsert(table, values, opts);
        },
        update(table, spec, legacyScope) { __sw_structNoScopeArg(legacyScope, 'update'); return __sw_structUpdate(table, spec); },
        remove(table, spec, legacyScope) { __sw_structNoScopeArg(legacyScope, 'remove'); return __sw_structRemove(table, spec); },
        delete(table, spec, legacyScope) { __sw_structNoScopeArg(legacyScope, 'delete'); return __sw_structRemove(table, spec); },
        async dump() {
          // sw.db.dump is developer-only and is NOT callable from a
          // deployed function. A full-database export must run with
          // developer credentials — a public request handler must not be
          // able to siphon the entire database at request time. Same
          // immediate-throw shape as sw.db.migrate (tsk_a9f1fee70): the
          // dev-only db-dump route only ever answered the runtime key
          // with an opaque 403, so short-circuit with a clear, actionable
          // error instead of a confusing round-trip (tsk_ccaadf9dd832).
          const err = new Error(
            'sw.db.dump is not available inside a deployed function — ' +
            'exporting the whole database is a developer-only operation. ' +
            'Run it with developer credentials instead: the db_dump tool ' +
            'from your coding agent, or the Database tab in the dashboard.'
          );
          err.code = 'DEV_ONLY_IN_FUNCTION';
          throw err;
        },
        onchange: (function () {
          // sw.db.onchange manages a database-change webhook — developer-
          // only, NOT callable from a deployed function. A public request
          // handler must not be able to point change notifications at an
          // arbitrary URL at request time. Like sw.db.dump / sw.db.migrate,
          // the dev-only db-webhook route only ever returned the runtime
          // key an opaque 403, so each method throws a clear, actionable
          // error instead (tsk_ccaadf9dd832).
          function deny() {
            const err = new Error(
              'sw.db.onchange is not available inside a deployed function — ' +
              'managing a database-change webhook is a developer-only ' +
              'operation. Set it up with developer credentials instead: the ' +
              'db_webhook_set / db_webhook_get / db_webhook_delete tools ' +
              'from your coding agent, or the Database tab in the dashboard.'
            );
            err.code = 'DEV_ONLY_IN_FUNCTION';
            return err;
          }
          return {
            async set(_url, _opts) { throw deny(); },
            async get() { throw deny(); },
            async delete() { throw deny(); },
          };
        })(),
      };
      function __sw_unsafeIntegerResultColumn(result) {
        const maxSafeInteger = 9007199254740991;
        const rows = result && __sw_arrayIsArray(result.results) ? result.results : [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!row || typeof row !== 'object' || __sw_arrayIsArray(row)) continue;
          const columns = __sw_keys(row);
          for (let j = 0; j < columns.length; j++) {
            const value = row[columns[j]];
            if (typeof value === 'number' && value % 1 === 0 &&
                (value > maxSafeInteger || value < -maxSafeInteger)) {
              return columns[j];
            }
          }
        }
        return null;
      }

      function __sw_quoteResultColumn(column) {
        return '"' + String(column).replace(/"/g, '""') + '"';
      }

      function __sw_exactIntegerReadError(column) {
        const err = new Error(
          'Database result column ' + JSON.stringify(String(column)) + " contains an integer outside JavaScript's exact number range. " +
          'Read it with CAST(' + __sw_quoteResultColumn(column) + ' AS TEXT) or store it as text.'
        );
        err.code = 'DATABASE_VALUE_TOO_LARGE';
        err.status = 400;
        err.__sw_expose = true;
        return err;
      }

      // The same failure on a statement that has ALREADY RUN. Saying so is the
      // whole point: a caller that reads 'failed' off a committed INSERT retries
      // it and writes the row twice (tsk_daf4d6d2). Raw SQL is run exactly as
      // written, so the platform cannot add the cast for the caller here — the
      // composed writers (sw.db.insert / update / remove) do it themselves.
      function __sw_exactIntegerWriteError(column) {
        const err = new Error(
          'The statement ran and its changes were applied, but the row it returned holds an integer outside ' +
          "JavaScript's exact number range in column " + JSON.stringify(String(column)) + ', which cannot be read ' +
          'back exactly afterwards. Do not retry the statement. Select the column as CAST(' +
          __sw_quoteResultColumn(column) + ' AS TEXT) in the RETURNING list, or write through sw.db.insert / ' +
          'sw.db.update / sw.db.remove, which compose that cast for you.'
        );
        err.code = 'DATABASE_VALUE_TOO_LARGE';
        err.status = 400;
        err.__sw_expose = true;
        return err;
      }

      function __sw_dbStatementApplied(sql) {
        const kind = __sw_dbStatementKind(sql);
        return kind === 'INSERT' || kind === 'UPDATE' || kind === 'DELETE' || kind === 'REPLACE';
      }

      // THE result-row decoding chokepoint for every sw.db transport and shape:
      // native binding, REST fallback, raw query, structured query, and batch
      // statement results all pass here before customer code can observe them.
      // The native binding has already materialized an out-of-range INTEGER as
      // an inexact Number, but that Number is still detectably unsafe. Replay a
      // read-only SELECT through SQLite with a per-column CAST-to-TEXT guard to
      // recover the exact stored integer. If replay is unsafe (non-SELECT) or
      // cannot produce an exact value, fail loudly instead of returning a lie.
      async function __sw_decodeDbResult(database, sql, params, result) {
        const unsafeColumn = __sw_unsafeIntegerResultColumn(result);
        if (!unsafeColumn) return result;
        if (__sw_dbStatementKind(sql) !== 'SELECT') {
          throw __sw_dbStatementApplied(sql)
            ? __sw_exactIntegerWriteError(unsafeColumn)
            : __sw_exactIntegerReadError(unsafeColumn);
        }

        const first = result.results && result.results[0];
        if (!first || typeof first !== 'object' || __sw_arrayIsArray(first)) {
          throw __sw_exactIntegerReadError(unsafeColumn);
        }
        const columns = __sw_keys(first);
        const projection = columns.map(function (column) {
          const name = __sw_quoteResultColumn(column);
          return 'CASE WHEN typeof(' + name + ") = 'integer' AND (" + name + ' > 9007199254740991' +
            ' OR ' + name + ' < -9007199254740991) THEN CAST(' + name + ' AS TEXT) ELSE ' + name + ' END AS ' + name;
        }).join(', ');
        const sourceSql = String(sql).trim().replace(/;s*$/, '');
        const exactSql = 'SELECT ' + projection + ' FROM (' + sourceSql + ') AS "__sw_exact_integer_rows"';
        let exact;
        try {
          exact = await __sw_prepOn(database, exactSql, params).all();
        } catch (_) {
          throw __sw_exactIntegerReadError(unsafeColumn);
        }
        if (__sw_unsafeIntegerResultColumn(exact)) throw __sw_exactIntegerReadError(unsafeColumn);
        return exact;
      }

      // SQLite column affinity, from the declared type. Only INTEGER, NUMERIC
      // and BLOB/none affinity can hold a whole number out of exact range —
      // TEXT affinity stores it as text and REAL affinity as a decimal, neither
      // of which the read path ever flags. Guarding only these keeps the
      // composed RETURNING list short on wide tables.
      function __sw_integerCapableAffinity(declaredType) {
        const t = __sw_lower(String(declaredType == null ? '' : declaredType));
        if (t.indexOf('int') !== -1) return true;
        if (t.indexOf('char') !== -1 || t.indexOf('clob') !== -1 || t.indexOf('text') !== -1) return false;
        if (t === '' || t.indexOf('blob') !== -1) return true;
        if (t.indexOf('real') !== -1 || t.indexOf('floa') !== -1 || t.indexOf('doub') !== -1) return false;
        return true;
      }

      function __sw_quotableColumnName(name) {
        return typeof name === 'string' && name.length > 0 && name.length <= 64 &&
          __sw_reMatch(__SW_STRUCT_IDENT_RE, name);
      }

      function __sw_returningSql(cols) {
        if (!cols || cols.length === 0) return ' RETURNING *';
        const parts = [];
        for (let i = 0; i < cols.length; i++) {
          const name = __sw_structQuote(cols[i].n);
          parts.push(cols[i].guard
            ? 'CASE WHEN typeof(' + name + ") = 'integer' AND (" + name + ' > 9007199254740991 OR ' +
              name + ' < -9007199254740991) THEN CAST(' + name + ' AS TEXT) ELSE ' + name + ' END AS ' + name
            : name);
        }
        return ' RETURNING ' + parts.join(', ');
      }

      function __sw_execOne(label, database, sql, params) {
        return __sw_timedExec(label, sql, async function () {
          const result = await __sw_prepOn(database, sql, params).all();
          return __sw_decodeDbResult(database, sql, params, result);
        });
      }

      function __sw_execBatch(label, database, statements) {
        const sqlPreview = statements.map(function (statement) { return statement.sql; }).join(' ; ').slice(0, 200);
        return __sw_timedExec(label, sqlPreview, async function () {
          const prepared = statements.map(function (statement) {
            return __sw_prepOn(database, statement.sql, statement.params);
          });
          const results = await database.batch(prepared);
          for (let i = 0; i < results.length; i++) {
            results[i] = await __sw_decodeDbResult(database, statements[i].sql, statements[i].params, results[i]);
          }
          return results;
        });
      }
    })(),
    fs: (function () {
      function __sw_fsDevOnly(op) {
        const err = new Error('sw.fs.' + op + ' is a project-wide scanner, not a per-user operation, so it is not on the default user-facing sw.fs (tsk_327fe8a4). It runs with project authority in run_code (sw.fs.dev.' + op + ') — a developer-authenticated context — not in a request, cron, queue, or job handler. Per-user ' + op + ' is not offered — model per-user data in sw.db, or filter results yourself.');
        err.code = 'FS_DEV_ONLY';
        err.status = 400;
        return __sw_markExpected(err);
      }
      function __sw_makeFs(__sw_fsActor, __sw_fsIsDev) {
        return {
      async read(path, opts) {
        path = __sw_fsPath(path);
        opts = opts || {};
        // Runtime v2 (tsk_327fe8a4): the acting end-user is DERIVED from the
        // request's verified principal, never a caller { user }/as_user claim
        // (a claim would let function code read any user's private file). With
        // a verified app-user the read is ACL-scoped to them; in a server/
        // developer context (no app-user on the request) there is no as_user
        // and the project/developer read capability is preserved — a
        // project-owned asset reads as before. Omission is the absence of a
        // credential, never a widening the caller can request.
        const asUser = await __sw_fsActor();
        const userQ = asUser ? 'as_user=' + encodeURIComponent(asUser) : '';
        // Line-range mode: return the parsed JSON envelope so user code
        // gets { content, lines, total_lines } directly. No lines option
        // preserves the legacy behavior (raw Response).
        if (opts.lines) {
          const range = Array.isArray(opts.lines)
            ? opts.lines[0] + '-' + opts.lines[1]
            : String(opts.lines);
          const q = 'lines=' + encodeURIComponent(range) + (userQ ? '&' + userQ : '');
          return platformJSON('/v1/fs/' + projectId + path + '?' + q);
        }
        const r = await platformFetch('/v1/fs/' + projectId + path + (userQ ? '?' + userQ : ''));
        return r;
      },
      async write(path, body, opts) {
        path = __sw_fsPath(path);
        opts = opts || {};
        // Accept both camelCase and snake_case so docs that say
        // content_type and SDKs that pass contentType both work. Without
        // this, snake_case was silently dropped — the file would land
        // with application/octet-stream and browsers refused to play it.
        const ct = opts.contentType || opts.content_type || 'application/octet-stream';
        // Honor visibility:'public' (or public:true). The PUT route decides
        // visibility solely from the X-Visibility header; without it every
        // function write landed PRIVATE regardless of the option (the MCP
        // fs_write path worked, the in-function shim silently dropped it).
        const headers = { 'Content-Type': ct };
        if (opts.visibility === 'public' || opts.public === true) headers['X-Visibility'] = 'public';
        // Opt-in conditional write: { if_match: <version> } pins the version
        // this writer last read (write/stat/versions all return it). If the
        // file changed since, the platform refuses with FS_VERSION_CONFLICT
        // instead of silently last-write-wins. Omit for today's behavior.
        const ifMatch = opts.ifMatch ?? opts.if_match;
        if (ifMatch !== undefined && ifMatch !== null) headers['If-Match'] = String(ifMatch);
        // Runtime v2 #2: forward the DERIVED acting end-user so a write made in
        // a user's request is owned by them (sw.fs.dev omits it → project-owned).
        const asUser = await __sw_fsActor();
        const userQ = asUser ? '?as_user=' + encodeURIComponent(asUser) : '';
        const r = await platformFetch('/v1/fs/' + projectId + path + userQ, {
          method: 'PUT',
          headers,
          body,
        });
        if (r.status === 412) {
          const conflict = await r.json().catch(() => null);
          const err = new Error('FS_VERSION_CONFLICT: ' + (conflict && conflict.message
            ? conflict.message
            : 'the file changed since it was read — re-read it and retry with the current version'));
          err.code = 'FS_VERSION_CONFLICT';
          if (conflict && conflict.data) err.current_version = conflict.data.current_version;
          throw err;
        }
        if (!r.ok) throw new Error('fs.write failed: ' + r.status);
        return r.json();
      },
      async delete(path) {
        const asUser = await __sw_fsActor();
        const userQ = asUser ? '?as_user=' + encodeURIComponent(asUser) : '';
        return platformFetch('/v1/fs/' + projectId + __sw_fsPath(path) + userQ, { method: 'DELETE' }).then(r => r.json());
      },
      async move(from, to, opts) {
        const body = { from: __sw_fsPath(from), to: __sw_fsPath(to) };
        if (opts && opts.overwrite === true) body.overwrite = true;
        const asUser = await __sw_fsActor();
        if (asUser) body.as_user = asUser;
        return platformJSON('/v1/fs/' + projectId + '/move', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      async copy(from, to) {
        const body = { from: __sw_fsPath(from), to: __sw_fsPath(to) };
        const asUser = await __sw_fsActor();
        if (asUser) body.as_user = asUser;
        return platformJSON('/v1/fs/' + projectId + '/copy', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      async restore(path, version) {
        const body = { path: __sw_fsPath(path), version };
        const asUser = await __sw_fsActor();
        if (asUser) body.as_user = asUser;
        return platformJSON('/v1/fs/' + projectId + '/restore', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      // Runtime v2 #2 (tsk_327fe8a4, sol P0-1): every ownership-bearing fs op —
      // including the read-scanners — DERIVES the acting end-user and forwards
      // as_user so the route ACL-scopes it. Without this these ops ran
      // project-wide from any user context (search leaked cross-file snippets,
      // publicUrl flipped visibility on files the caller did not own). The dev
      // view (sw.fs.dev.*) forwards no as_user → project-wide, by design.
      async stat(path) {
        const asUser = await __sw_fsActor();
        const userQ = asUser ? '?as_user=' + encodeURIComponent(asUser) : '';
        return platformJSON('/v1/fs/' + projectId + '/stat' + __sw_fsPath(path) + userQ);
      },
      async versions(path) {
        const asUser = await __sw_fsActor();
        const userQ = asUser ? '?as_user=' + encodeURIComponent(asUser) : '';
        return platformJSON('/v1/fs/' + projectId + '/versions' + __sw_fsPath(path) + userQ);
      },
      async list(path, opts) {
        opts = opts || {};
        const query = [];
        if (opts.recursive) query.push('recursive=1');
        if (opts.depth) query.push('depth=' + Number(opts.depth));
        const asUser = await __sw_fsActor();
        if (asUser) query.push('as_user=' + encodeURIComponent(asUser));
        const qs = query.length ? '?' + query.join('&') : '';
        if (path) path = __sw_fsPath(path);
        const dirPath = path && path !== '/' && !path.endsWith('/') ? path + '/' : (path || '/');
        return platformJSON('/v1/fs/' + projectId + dirPath + qs);
      },
      // diff / glob / search — CUT from the default user-facing sw.fs (sol
      // P0-1). Per-user file diff/glob/search is a niche capability we won't
      // bolt ownership-derivation + route ACL onto; it lives ONLY under
      // sw.fs.dev.* with project authority. Model per-user data in sw.db.
      diff(path, opts) {
        if (!__sw_fsIsDev) throw __sw_fsDevOnly('diff');
        opts = opts || {};
        const body = { path: __sw_fsPath(path) };
        if (typeof opts.version === 'number') body.version = opts.version;
        return platformJSON('/v1/fs/' + projectId + '/diff', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      glob(pattern, opts) {
        if (!__sw_fsIsDev) throw __sw_fsDevOnly('glob');
        opts = opts || {};
        return platformJSON('/v1/fs/' + projectId + '/glob', {
          method: 'POST',
          body: JSON.stringify({ pattern, limit: opts.limit }),
        });
      },
      search(opts) {
        if (!__sw_fsIsDev) throw __sw_fsDevOnly('search');
        opts = opts || {};
        return platformJSON('/v1/fs/' + projectId + '/search', {
          method: 'POST',
          body: JSON.stringify({
            path: opts.path ? __sw_fsPath(opts.path) : '/',
            query: opts.query,
            limit: opts.limit,
            max_files: opts.max_files,
          }),
        });
      },
      async replace(opts) {
        const asUser = await __sw_fsActor();
        const bodyObj = {
          path: __sw_fsPath(opts.path),
          find: opts.find,
          replace: opts.replace,
        };
        if (asUser) bodyObj.as_user = asUser;
        return platformJSON('/v1/fs/' + projectId + '/replace', {
          method: 'POST',
          body: JSON.stringify(bodyObj),
        });
      },
      // sw.fs.uploadUrl({ path, maxSize?, contentType?, expiresIn? })
      // → { url, path, expires_at, max_size, content_type,
      //     owner_subject_type, owner_subject_id }
      // Mints a short-lived signed URL the browser can PUT bytes to
      // directly. The browser does NOT need a platform key.
      async uploadUrl(opts) {
        opts = opts || {};
        // Runtime v2: upload URLs are ownership-bearing writes too. Derive the
        // actor from the verified request exactly like write(); caller identity
        // fields are not copied from opts. The explicit sw.fs.dev view and
        // server/background contexts derive no actor and remain project-owned.
        const asUser = await __sw_fsActor();
        const body = {
          project_id: projectId,
          path: __sw_fsPath(opts.path),
          max_size: opts.maxSize ?? opts.max_size,
          content_type: opts.contentType ?? opts.content_type,
          expires_in: opts.expiresIn ?? opts.expires_in,
        };
        if (asUser) body.as_user = asUser;
        return platformJSON('/v1/fs/upload-url', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      // sw.fs.signedUrl(path, { expiresIn? })
      //   → { url, token, path, expires_at, expires_in }
      // Mints a short-lived signed URL anyone can GET to download the
      // file. No platform key required for the recipient. Default 1h,
      // max 7d. Common for email attachments, image previews, share
      // links.
      async signedUrl(path, opts) {
        opts = opts || {};
        // Runtime v2 (tsk_327fe8a4): the owner is DERIVED from the request's
        // verified principal, never a caller { user }/as_user claim. With a
        // verified app-user the link is minted only if that end-user owns the
        // file; in a server/developer context (no app-user) as_user is omitted
        // and full backend access is preserved.
        const asUser = await __sw_fsActor();
        const body = {
          path: __sw_fsPath(path),
          expires_in: opts.expiresIn ?? opts.expires_in,
        };
        if (asUser) body.as_user = asUser;
        return platformJSON('/v1/fs/' + projectId + '/sign', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      // sw.fs.public_url(path, opts?) → { path, public_url, content_type, size_bytes, visibility }
      // Returns a file's permanent, unauthenticated public URL.
      // SECURITY (tsk_bc8f2887): asking for the URL no longer silently makes a
      // PRIVATE file world-readable. For an already-public file it just returns
      // the URL. For a private file you must opt in to publishing:
      //   sw.fs.public_url(path, { makePublic: true })
      // Without the opt-in a private file throws FILE_PRIVATE and stays private.
      // For a time-limited link to a private file WITHOUT exposing it, use
      // sw.fs.signedUrl(path) instead.
      // public_url / publicUrl — user-scoped in the default sw.fs (sol round 5
      // carve-out). makePublic FLIPS visibility (a mutation); the DERIVED owner
      // is forwarded and the route enforces authorizeFileMutation (owner-only)
      // on the flip, so an end-user can only publish a file THEY own. This is
      // the correct fix for the original round-1 finding (not hiding it behind
      // dev). In sw.fs.dev.* the actor is null → project-wide, as with the other
      // dev ops.
      async public_url(path, opts) {
        opts = opts || {};
        const makePublic = opts.makePublic === true || opts.make_public === true || opts.public === true;
        const asUser = await __sw_fsActor();
        const userQ = asUser ? '&as_user=' + encodeURIComponent(asUser) : '';
        return platformJSON('/v1/fs/' + projectId + '/public-url?path=' + encodeURIComponent(__sw_fsPath(path)) +
          (makePublic ? '&make_public=1' : '') + userQ);
      },
      publicUrl(path, opts) {
        return this.public_url(path, opts);
      },
      // sw.fs.setOwner(path, user)
      //   → { path, owner_subject_type, owner_subject_id }
      // Assigns (or transfers) a PRIVATE file to a single end-user so only that
      // app_user can read it — via sw.fs.read(path, { user }) /
      // sw.fs.signedUrl(path, { user }). Pass null to reset ownership back to
      // the project. The ACL applies to private files only.
      async setOwner(path, user) {
        let owner = user ?? null;
        if (owner && typeof owner === 'object' && typeof owner.id === 'string') {
          owner = owner.id;
        }
        if (owner !== null && typeof owner !== 'string') {
          const err = new Error('owner must be a user object with a string id, a string id, or null.');
          err.code = 'VALIDATION_ERROR';
          err.status = 400;
          throw __sw_markExpected(err);
        }
        // Ownership transfer is project authority, not an end-user file
        // mutation. Forward the derived actor so user requests fail closed;
        // the route permits only a harmless same-owner no-op used by the
        // generated upload scaffold. Server/background contexts derive no
        // actor and keep the trusted project-level operation.
        const asUser = await __sw_fsActor();
        const body = { path: __sw_fsPath(path), owner };
        if (asUser) body.as_user = asUser;
        return platformJSON('/v1/fs/' + projectId + '/owner', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      // sw.fs.uploadFromRequest(req, { path, maxBytes?, allowedTypes?, fieldName?, public? })
      //   → { url, path, size, contentType, visibility }
      //
      // One-call multipart upload handler. Parses multipart/form-data
      // from the request, validates against the optional limits, writes
      // to the given path, returns a URL the browser can fetch.
      // The file is PRIVATE by default — in that case url is a
      // short-lived signed URL (anyone with the link can GET it until it
      // expires, the file itself stays private). Pass { public: true } to
      // store the file world-readable; only then is url a permanent
      // public /storage URL. Earlier this always returned a /storage URL
      // even for the private default, so the link 404'd / 403'd — the
      // bytes were never world-readable.
      // Throws on every failure mode with a stable error code in the
      // message so the caller can map → HTTP status.
      async uploadFromRequest(req, opts) {
        opts = opts || {};
        const path = opts.path;
        if (!path || typeof path !== 'string') {
          throw new Error('UPLOAD_PATH_REQUIRED: opts.path is required');
        }
        const fieldName = opts.fieldName || opts.field_name || 'file';
        const reqCt = (req.headers.get('content-type') || '').toLowerCase();
        if (!reqCt.includes('multipart/form-data')) {
          throw new Error('UPLOAD_NOT_MULTIPART: request Content-Type must be multipart/form-data');
        }
        let form;
        try {
          form = await req.formData();
        } catch (err) {
          throw new Error('UPLOAD_PARSE_FAILED: ' + (err && err.message ? err.message : String(err)));
        }
        const file = form.get(fieldName);
        if (!file || typeof file === 'string') {
          throw new Error('UPLOAD_FIELD_MISSING: no file in form field "' + fieldName + '"');
        }
        const fileType = (file.type || 'application/octet-stream').toLowerCase();
        if (Array.isArray(opts.allowedTypes) && opts.allowedTypes.length > 0) {
          const allowed = opts.allowedTypes.map((t) => String(t).toLowerCase());
          if (!allowed.includes(fileType)) {
            throw new Error('UPLOAD_TYPE_NOT_ALLOWED: ' + fileType + ' is not in allowedTypes (' + allowed.join(', ') + ')');
          }
        }
        const bytes = await file.arrayBuffer();
        const size = bytes.byteLength;
        if (size === 0) {
          throw new Error('UPLOAD_FILE_EMPTY: uploaded file has zero bytes');
        }
        const max = Number(opts.maxBytes ?? opts.max_bytes ?? 0);
        if (max > 0 && size > max) {
          throw new Error('UPLOAD_TOO_LARGE: file is ' + size + ' bytes, limit is ' + max);
        }
        const makePublic = opts.public === true || opts.visibility === 'public';
        await this.write(path, bytes, { contentType: fileType, public: makePublic });
        const normalizedPath = path.startsWith('/') ? path : '/' + path;
        if (makePublic) {
          // World-readable: the permanent public URL actually serves the bytes.
          return {
            url: '/storage' + normalizedPath,
            path: normalizedPath,
            size,
            contentType: fileType,
            visibility: 'public',
          };
        }
        // Private (default): a bare /storage URL would NOT serve this file, so
        // hand back a short-lived signed URL the caller can use / share until
        // it expires. The file itself stays private.
        const signed = await this.signedUrl(normalizedPath);
        return {
          url: signed && signed.url ? signed.url : null,
          path: normalizedPath,
          size,
          contentType: fileType,
          visibility: 'private',
        };
      },
        };
      }
      const __sw_fs = __sw_makeFs(function () { return __sw_optionalSubject(); }, false);
      // The explicit project/developer capability — as_user always omitted, and
      // the project-authority scanners (search/diff/glob/public_url) live ONLY
      // here, never on the default user-facing sw.fs (sol P0-1: cut, not guard).
      // sol round 6: .dev is attached ONLY when the ENTRYPOINT is structurally
      // allowed to have it — run_code, which passes devFsEnabled=true. Every
      // HTTP-reached context (fetch handlers, and cron/queue/job delivered to
      // them over HTTP) constructs sw WITHOUT the flag, so .dev is simply never
      // present — no header is inspected and there is nothing to replay. A
      // cron/job still writes through the DEFAULT sw.fs, which derives no
      // app-user and therefore writes project-owned; only the project-wide
      // scanners move to run_code (FS_DEV_NOT_IN_REQUEST names it).
      if (devFsEnabled) __sw_fs.dev = __sw_makeFs(function () { return null; }, true);
      return __sw_fs;
    })(),

    storage: (function () {
      // sw.storage.* was removed when sw.fs replaced the legacy storage
      // API — the old storage route now returns 410 GONE (see
      // worker/src/index.ts). The old shim forwarded to that dead route,
      // so get()/delete() failed SILENTLY (the 410 response was handed
      // back as if it were file data) and put() threw an opaque
      // "storage.put failed: 410". sw.fs is a different, versioned file
      // store under a different key space, so a silent redirect would
      // read the WRONG location and miss data written via the old API.
      // Each method throws one clear, actionable error instead — the
      // same immediate-throw shape as the sw.db dev-only shim.
      // (tsk_8192b820)
      function deny() {
        const err = new Error(
          'sw.storage is removed — use sw.fs instead. ' +
          'Upload: sw.fs.write(path, body, { contentType }). ' +
          'Download: sw.fs.read(path). ' +
          'Remove: sw.fs.delete(path). ' +
          'Note: sw.fs paths start with "/" (e.g. sw.fs.write("/avatars/me.png", bytes)).'
        );
        err.code = 'STORAGE_REMOVED';
        return err;
      }
      return {
        async get(_key) { throw deny(); },
        async put(_key, _body, _opts) { throw deny(); },
        async delete(_key) { throw deny(); },
      };
    })(),

    email: {
      send(opts) {
        return platformJSON('/v1/email/send', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      history(opts) {
        opts = opts || {};
        const q = new URLSearchParams({ project_id: projectId });
        if (opts.limit) q.set('limit', String(opts.limit));
        if (opts.offset) q.set('offset', String(opts.offset));
        return platformJSON('/v1/email/history?' + q.toString());
      },
      status(id) {
        const q = new URLSearchParams({ project_id: projectId, id: String(id || '') });
        return platformJSON('/v1/email/managed-status?' + q.toString());
      },
      // Scrub before you send: has this ONE address bounced or complained?
      // → { address, suppressed, status, last_at, occurrences }. (tsk_f108058c)
      checkSuppression(address) {
        const q = new URLSearchParams({ project_id: projectId, address: String(address || '') });
        return platformJSON('/v1/email/suppression?' + q.toString());
      },
      // The dead-address list (bounced/complained) to scrub a mailing list in
      // one call → { bounces: [{ address, last_status, last_at, occurrences }] }.
      bounces(opts) {
        opts = opts || {};
        const q = new URLSearchParams({ project_id: projectId });
        if (opts.days) q.set('days', String(opts.days));
        if (opts.limit) q.set('limit', String(opts.limit));
        return platformJSON('/v1/email/bounces?' + q.toString());
      },
    },
    contacts: {
      upsert(opts) {
        return platformJSON('/v1/email/contacts', {
          method: 'POST',
          body: JSON.stringify({ ...(opts || {}), project_id: projectId }),
        });
      },
      get(idOrEmail) {
        const q = new URLSearchParams({ project_id: projectId });
        return platformJSON('/v1/email/contacts/' + encodeURIComponent(String(idOrEmail || '')) + '?' + q.toString());
      },
      list(opts) {
        opts = opts || {};
        const q = new URLSearchParams({ project_id: projectId });
        if (opts.limit) q.set('limit', String(opts.limit));
        if (opts.offset) q.set('offset', String(opts.offset));
        return platformJSON('/v1/email/contacts?' + q.toString());
      },
    },

    ai: (function () {
      // Direct DB binding for sw.ai surfaces that read/write the
      // project DB (catalogTool, userMemory, notifications bell).
      // Mirrors the sw.db IIFE's "const DB = env.PROJECT_DB;" — kept
      // separate per-closure so each surface fails loud with a
      // helpful error rather than throwing on undefined.
      const DB = env.PROJECT_DB;

      // hideCost (tsk_e628155a #2): keep per-call cost ACCESSIBLE to the dev
      // (r.cost.total_cents) but NON-ENUMERABLE, so a naive Response.json(result)
      // or {...result} does NOT forward the owner's retail price to end users.
      // Explicit reads + destructuring still work; nothing breaks for devs who
      // read it on purpose.
      function hideCost(r) {
        if (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'cost')) {
          try { Object.defineProperty(r, 'cost', { value: r.cost, enumerable: false, writable: true, configurable: true }); } catch (e) { /* noop */ }
        }
        return r;
      }

      // Runtime v2 (tsk_327fe8a4, sol P0-2 round 2): identity NEVER travels
      // through the caller-supplied options object in ANY form — not a
      // subject_id field, not an internal marker read off the same object (that
      // was the forge). The outbound body is built from an ALLOWLIST of intended
      // fields (everything else dropped), and the subject is applied SEPARATELY
      // from a source the customer cannot reach: either a boundSubject passed
      // OUT OF BAND by sw.ai.scoped/forUser (their closure), or — by default —
      // the request's verified principal derived at the chokepoint.
      const __SW_CHAT_FIELDS = [
        'messages', 'model', 'provider', 'system', 'max_tokens', 'temperature',
        'top_p', 'top_k', 'stop_sequences', 'tools', 'tool_choice',
        'response_schema', 'stream', 'conversation_id', 'compaction',
        'history_max_messages', 'history_max_tokens', 'idempotency_key',
        'service_tier', 'metadata', 'thinking', 'cache_control',
      ];
      async function __sw_chatImpl(opts, boundSubject) {
        opts = opts || {};
        const body = { project_id: projectId };
        // ALLOWLIST: copy ONLY intended fields (drops any subject_id /
        // subject_type / marker / project_id the caller tried to smuggle).
        for (const k of __SW_CHAT_FIELDS) {
          if (__sw_own(opts, k) && opts[k] !== undefined) body[k] = opts[k];
        }
        // Identity, from an internal source ONLY, after the allowlist.
        if (boundSubject && boundSubject.id) {
          body.subject_type = boundSubject.type || 'app_user';
          body.subject_id = String(boundSubject.id);
        } else {
          const uid = await __sw_optionalSubject();
          if (uid) { body.subject_type = 'app_user'; body.subject_id = uid; }
        }
        if (body.stream === true) {
          const r = await platformFetch('/v1/ai/complete', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          if (!r.ok) {
            let data;
            try { data = await r.json(); } catch { data = null; }
            const code = (data && (data.code || data.error)) || 'PLATFORM_ERROR';
            const msg = (r.status === 402 && (code === 'INSUFFICIENT_BALANCE' || code === 'PAID_API_NOT_ACTIVATED' || code === 'PAID_AI_DISABLED'))
              ? 'This AI feature is temporarily unavailable. Please try again later.'
              : ((data && data.message) || ('Platform call failed: ' + r.status));
            const err = new Error(msg);
            err.code = code;
            err.status = r.status;
            if (data && data.retry_after_ms !== undefined) err.retry_after_ms = data.retry_after_ms;
            if (data && data.retry !== undefined) err.retry = data.retry;
            throw err;
          }
          return r.body;
        }
        return hideCost(await platformJSON('/v1/ai/complete', {
          method: 'POST',
          body: JSON.stringify(body),
        }));
      }
      // Default surface — derives the request principal; never scoped by opts.
      function chat(opts) { return __sw_chatImpl(opts, null); }
      async function __sw_aiMediaHeaders() {
        const subject = await __sw_optionalSubject();
        return subject ? { 'X-Somewhere-Acting-Subject': String(subject) } : {};
      }
      async function transcribe(opts) {
        return hideCost(await platformJSON('/v1/ai/transcribe', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        }));
      }
      // tts returns binary audio (Response) when no storage opt is set,
      // and a JSON envelope { storage_path, ... } when storage is set.
      // Mirrors sw.render.* — keep raw Response so callers can stream.
      async function tts(opts) {
        opts = opts || {};
        const body = JSON.stringify({ ...opts, project_id: projectId });
        const headers = await __sw_aiMediaHeaders();
        if (opts.storage) {
          return hideCost(await platformJSON('/v1/ai/tts', { method: 'POST', headers, body }));
        }
        const r = await platformFetch('/v1/ai/tts', { method: 'POST', headers, body });
        if (!r.ok) {
          let msg = 'tts failed: ' + r.status;
          let code;
          try { const j = await r.json(); if (j && j.error) code = j.error; if (j && j.message) msg = j.message; } catch { /* noop */ }
          // A 402 INSUFFICIENT_BALANCE is end-user-triggerable and apps
          // echo err.message to end users — never leak the owner billing
          // prose. Keep the real code/status for the dev's own logging.
          if (r.status === 402 && (code === 'INSUFFICIENT_BALANCE' || code === 'PAID_API_NOT_ACTIVATED' || code === 'PAID_AI_DISABLED')) {
            msg = 'This AI feature is temporarily unavailable. Please try again later.';
          }
          const err = new Error(msg); if (code) err.code = code; err.status = r.status; throw err;
        }
        return r;
      }
      async function generateImage(opts) {
        opts = opts || {};
        const body = JSON.stringify({ ...opts, project_id: projectId });
        const headers = await __sw_aiMediaHeaders();
        if (opts.storage) {
          return hideCost(await platformJSON('/v1/ai/generate-image', { method: 'POST', headers, body }));
        }
        const r = await platformFetch('/v1/ai/generate-image', { method: 'POST', headers, body });
        if (!r.ok) {
          let msg = 'generate-image failed: ' + r.status;
          let code;
          try { const j = await r.json(); if (j && j.error) code = j.error; if (j && j.message) msg = j.message; } catch { /* noop */ }
          // 402 INSUFFICIENT_BALANCE is end-user-triggerable — keep the
          // real code/status for logging but neutralize the message.
          if (r.status === 402 && (code === 'INSUFFICIENT_BALANCE' || code === 'PAID_API_NOT_ACTIVATED' || code === 'PAID_AI_DISABLED')) {
            msg = 'This AI feature is temporarily unavailable. Please try again later.';
          }
          const err = new Error(msg); if (code) err.code = code; err.status = r.status; throw err;
        }
        return r;
      }
      async function removeBackground(opts) {
        opts = opts || {};
        const body = JSON.stringify({ ...opts, project_id: projectId });
        const headers = await __sw_aiMediaHeaders();
        if (opts.storage) {
          return hideCost(await platformJSON('/v1/ai/remove-background', { method: 'POST', headers, body }));
        }
        const r = await platformFetch('/v1/ai/remove-background', { method: 'POST', headers, body });
        if (!r.ok) {
          let msg = 'remove-background failed: ' + r.status;
          let code;
          try { const j = await r.json(); if (j && j.error) code = j.error; if (j && j.message) msg = j.message; } catch { /* noop */ }
          // 402 INSUFFICIENT_BALANCE is end-user-triggerable — keep the
          // real code/status for logging but neutralize the message.
          if (r.status === 402 && (code === 'INSUFFICIENT_BALANCE' || code === 'PAID_API_NOT_ACTIVATED' || code === 'PAID_AI_DISABLED')) {
            msg = 'This AI feature is temporarily unavailable. Please try again later.';
          }
          const err = new Error(msg); if (code) err.code = code; err.status = r.status; throw err;
        }
        return r;
      }
      async function embeddings(opts) {
        return hideCost(await platformJSON('/v1/ai/embeddings', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        }));
      }
      function moderate(text) {
        return platformJSON('/v1/ai/moderate', {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, text }),
        });
      }
      function catalog() {
        return platformJSON('/v1/ai/catalog');
      }
      // Conversation listing / fetching / deletion — needed by chat
      // apps that want a Claude.ai-style sidebar of prior conversations
      // (tsk_ba27a4b6). Same endpoints the MCP ai_conversation_* tools
      // hit; sw.ai.conversations.* mirrors that surface inside a
      // deployed function so the UI can render previews + handle
      // "new chat" / "delete" without round-tripping to MCP.
      function conversationsList(opts) {
        opts = opts || {};
        const q = new URLSearchParams({ project_id: projectId });
        if (opts.subject_id)   q.set('subject_id',   String(opts.subject_id));
        if (opts.subject_type) q.set('subject_type', String(opts.subject_type));
        if (typeof opts.limit === 'number') q.set('limit', String(opts.limit));
        return platformJSON('/v1/ai/conversations?' + q.toString());
      }
      function conversationGet(id, opts) {
        opts = opts || {};
        const q = new URLSearchParams({ project_id: projectId });
        if (opts.include) q.set('include', String(opts.include));
        if (opts.subject_id)   q.set('subject_id',   String(opts.subject_id));
        if (opts.subject_type) q.set('subject_type', String(opts.subject_type));
        return platformJSON('/v1/ai/conversations/' + encodeURIComponent(id) + '?' + q.toString());
      }
      function conversationDelete(id, opts) {
        opts = opts || {};
        const q = new URLSearchParams({ project_id: projectId });
        if (opts.subject_id)   q.set('subject_id',   String(opts.subject_id));
        if (opts.subject_type) q.set('subject_type', String(opts.subject_type));
        return platformJSON('/v1/ai/conversations/' + encodeURIComponent(id) + '?' + q.toString(), {
          method: 'DELETE',
        });
      }
      // fork(sourceId, newId, opts?) — branch a conversation under a
      // fresh id without losing the original. Use for "regenerate
      // from this point" / "what if I asked X differently" UIs.
      // opts.upToMessageId truncates the copy at that message id
      // (inclusive); omit to copy the full history.
      function conversationFork(sourceId, newId, opts) {
        opts = opts || {};
        const body = { project_id: projectId, new_conversation_id: newId };
        if (typeof opts.upToMessageId === 'number') body.up_to_message_id = opts.upToMessageId;
        if (opts.subject_id)   body.subject_id = String(opts.subject_id);
        if (opts.subject_type) body.subject_type = String(opts.subject_type);
        return platformJSON('/v1/ai/conversations/' + encodeURIComponent(sourceId) + '/fork', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      // Runtime v2 (tsk_327fe8a4): the DEFAULT accessor is the request's own
      // conversations — the app_user subject is DERIVED, never a caller
      // subject_id/subject_type claim (which is why a conversation-id alone can
      // never fetch another user's messages: every call carries the verified
      // subject). Each op fails closed without a verified user. forUser(userId)
      // is the EXPLICIT developer capability for another end-user's / a
      // project-or-session-scoped history — cross-subject, named, running under
      // the project's developer authority; not reachable via app-user identity.
      const conversations = {
        async list(opts) {
          const uid = await __sw_requireSubject('sw.ai.conversations.list');
          return conversationsList({ ...(opts || {}), subject_type: 'app_user', subject_id: uid });
        },
        async get(id, opts) {
          const uid = await __sw_requireSubject('sw.ai.conversations.get');
          return conversationGet(id, { ...(opts || {}), subject_type: 'app_user', subject_id: uid });
        },
        async delete(id) {
          const uid = await __sw_requireSubject('sw.ai.conversations.delete');
          return conversationDelete(id, { subject_type: 'app_user', subject_id: uid });
        },
        async fork(sourceId, newId, opts) {
          const uid = await __sw_requireSubject('sw.ai.conversations.fork');
          return conversationFork(sourceId, newId, { ...(opts || {}), subject_type: 'app_user', subject_id: uid });
        },
        forUser(userId) {
          return {
            list(opts) { return conversationsList({ ...(opts || {}), subject_type: 'app_user', subject_id: String(userId) }); },
            get(id, opts) { return conversationGet(id, { ...(opts || {}), subject_type: 'app_user', subject_id: String(userId) }); },
            delete(id) { return conversationDelete(id, { subject_type: 'app_user', subject_id: String(userId) }); },
            fork(sourceId, newId, opts) { return conversationFork(sourceId, newId, { ...(opts || {}), subject_type: 'app_user', subject_id: String(userId) }); },
          };
        },
      };

      // Backward-compatible adapter. sw.agent owns the one model/tool step
      // engine; keeping this forwarding surface avoids a second loop drifting
      // away from durable execution again.
      // chatWithTools — the agent drives the model/tool loop and issues the
      // chat calls. A caller CANNOT supply the bound-chat hook (sol P0-2): the
      // default strips __sw_boundChat, so the agent's steps go through sw.ai.chat
      // and DERIVE the request principal. sw.ai.scoped(id).chatWithTools re-sets
      // __sw_boundChat to a closure-bound chat AFTER the strip (below), so its
      // steps persist under the explicitly-named subject — out of band, never
      // from opts.
      async function chatWithTools(opts) {
        const o = { ...(opts || {}) };
        delete o.__sw_boundChat;
        return sw.agent.run({ ...o, __surface: 'sw.ai.chatWithTools' });
      }
      function __sw_scopedChatWithTools(opts, boundSubject) {
        const o = { ...(opts || {}) };
        delete o.__sw_boundChat;
        return sw.agent.run({
          ...o,
          __surface: 'sw.ai.chatWithTools',
          __sw_boundChat: function (co) { return __sw_chatImpl(co, boundSubject); },
        });
      }

      // sw.ai.userMemory — per-user structured memory blob with
      // auto-compaction (tsk_293ae3fd item 2). Every chat app
      // reinvents this — Nibble has nibble_memory, RailTime would
      // have railtime_memory, etc. One table, three calls.
      //
      //   const m = await sw.ai.userMemory.get();            // subject derived
      //   await sw.ai.userMemory.update({ preferred_line: 'Northern' });
      //   // After N turns, fold history into the structured blob:
      //   await sw.ai.userMemory.compact({
      //     type: 'object',
      //     properties: {
      //       preferred_line: { type: 'string' },
      //       commute_time: { type: 'string' },
      //       last_seen_disruptions: { type: 'array', items: { type: 'string' } },
      //     },
      //   }, { conversation_id: 'railtime:me' });
      //   // Runtime v2 (tsk_327fe8a4): the user is the request's verified
      //   // principal; these calls take no user id and require a signed-in user.
      //
      // Storage is in the project's own database under
      // _ai_user_memory — _-prefixed so it's hidden from db_browse /
      // db_describe like the other platform tables.
      const memoryTableSql = "CREATE TABLE IF NOT EXISTS _ai_user_memory (user_id TEXT PRIMARY KEY, blob_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)";
      let memoryEnsured = false;
      async function ensureMemoryTable() {
        if (memoryEnsured) return;
        if (!DB || typeof DB.prepare !== 'function') return;
        try {
          await DB.prepare(memoryTableSql).run();
          memoryEnsured = true;
        } catch (err) {
          console.error('sw.ai.userMemory: ensureTable failed:', err && err.message ? err.message : err);
        }
      }
      // sw.ai.userMemory — Runtime v2 (tsk_327fe8a4): the subject is DERIVED
      // from the request's verified principal, never a caller-passed id. Each
      // op fails closed (AUTH_REQUIRED) without a verified user, before any DB
      // read or write. One user reads/writes only their own memory blob.
      const userMemory = {
        async get() {
          const userId = await __sw_requireSubject('sw.ai.userMemory.get');
          await ensureMemoryTable();
          const r = await DB.prepare(
            'SELECT blob_json, updated_at FROM _ai_user_memory WHERE user_id = ?'
          ).bind(String(userId)).first();
          if (!r) return {};
          try { return JSON.parse(r.blob_json); } catch { return {}; }
        },
        async update(patch) {
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            const err = new Error('sw.ai.userMemory.update: patch must be a plain object'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          const userId = await __sw_requireSubject('sw.ai.userMemory.update');
          await ensureMemoryTable();
          const current = await this.get();
          const merged = { ...current, ...patch };
          const now = Date.now();
          await DB.prepare(
            'INSERT INTO _ai_user_memory (user_id, blob_json, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(user_id) DO UPDATE SET blob_json = excluded.blob_json, updated_at = excluded.updated_at'
          ).bind(String(userId), JSON.stringify(merged), now).run();
          return merged;
        },
        async clear() {
          const userId = await __sw_requireSubject('sw.ai.userMemory.clear');
          await ensureMemoryTable();
          await DB.prepare('DELETE FROM _ai_user_memory WHERE user_id = ?').bind(String(userId)).run();
          return { cleared: true };
        },
        // compact(userId, schema, opts?) — feeds recent conversation
        // turns to a cheap model with the schema as a response_schema,
        // merges the structured output into the existing blob. Returns
        // the new blob. Use after N conversation turns or as a periodic
        // cron task. Cost: one ai.chat call against the cheapest model.
        async compact(schema, opts) {
          opts = opts || {};
          if (!schema || typeof schema !== 'object') {
            const err = new Error('sw.ai.userMemory.compact: schema (JSON Schema object) is required'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          const userId = await __sw_requireSubject('sw.ai.userMemory.compact');
          // Pull recent turns from the user's conversation, if one was
          // named. Without a conversation_id we still extract from any
          // history the dev pre-loads as opts.history.
          let recentText = '';
          if (opts.conversation_id) {
            try {
              // Runtime v2 (sol P0-2b): fetch THROUGH the derived conversations
              // accessor — it scopes to the request's verified subject, so a
              // conversation-id alone can never pull another user's messages
              // into this user's memory blob. (No hand-built subject predicate.)
              const full = await conversations.get(opts.conversation_id, { include: 'messages' });
              const msgs = Array.isArray(full && full.messages) ? full.messages : [];
              const lastN = msgs.slice(-Number(opts.windowMessages) || -20);
              recentText = lastN.map((m) => {
                const c = typeof m.content === 'string'
                  ? m.content
                  : Array.isArray(m.content)
                    ? m.content.map((b) => (b && b.type === 'text' ? b.text : '')).filter(Boolean).join(' ')
                    : '';
                return m.role + ': ' + c;
              }).join('\n');
            } catch (err) {
              console.error('sw.ai.userMemory.compact: history load failed:', err && err.message ? err.message : err);
            }
          } else if (typeof opts.history === 'string') {
            recentText = opts.history;
          }
          if (!recentText) {
            return this.get();
          }

          const current = await this.get();
          const sys = "You are a memory-compaction agent. Read the conversation transcript below and produce the user's structured memory blob according to the supplied schema. Carry forward any fields from the existing memory that the transcript does NOT contradict. Be terse — record durable facts, preferences, and goals; skip transient state.";
          const userMsg = 'Existing memory:\n' + JSON.stringify(current, null, 2) +
            '\n\nRecent transcript:\n' + recentText;
          const r = await platformJSON('/v1/ai/complete', {
            method: 'POST',
            body: JSON.stringify({
              project_id: projectId,
              provider: opts.provider || 'anthropic',
              model: opts.model || 'claude-haiku-4-5',
              system: sys,
              messages: [{ role: 'user', content: userMsg }],
              response_schema: schema,
              max_tokens: Number(opts.maxTokens) || 1024,
            }),
          });
          if (r && r.parsed && typeof r.parsed === 'object') {
            await DB.prepare(
              'INSERT INTO _ai_user_memory (user_id, blob_json, updated_at) VALUES (?, ?, ?) ' +
              'ON CONFLICT(user_id) DO UPDATE SET blob_json = excluded.blob_json, updated_at = excluded.updated_at'
            ).bind(String(userId), JSON.stringify(r.parsed), Date.now()).run();
            return r.parsed;
          }
          return current;
        },
      };

      // sw.ai.catalogTool — RETIRED from the customer runtime (Runtime v2,
      // tsk_327fe8a4, #4). It auto-assembled a SELECT/LIKE tool from a table +
      // column list; that inference-driven surface is being replaced by the
      // additive AI DB tool built on the declared table-intent manifest, not
      // retrofitted with per-call authority. Cut, don't harden — the method is
      // kept as a tombstone so callers get a clear error rather than
      // "undefined is not a function". Build the tool explicitly with
      // sw.db + sw.ai.chatWithTools, or use the manifest-based tool when it lands.
      function catalogTool() {
        const err = new Error('sw.ai.catalogTool has been retired. Assemble the search tool explicitly from sw.db + sw.ai.chatWithTools, or use the manifest-based AI DB tool. See the platform docs (ai) for the migration.');
        err.code = 'CATALOG_TOOL_RETIRED';
        err.status = 400;
        throw __sw_markExpected(err);
      }

      return {
        chat,
        complete: chat,
        chatWithTools,
        catalogTool,
        userMemory,
        conversations,
        scoped(subjectId, subjectType) {
          if (!subjectId) {
            const err = new Error('sw.ai.scoped: subjectId is required');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          const sType = subjectType || 'app_user';
          // The bound subject lives in THIS closure — never in the caller's
          // opts object — so it cannot be forged by customer code (sol P0-2).
          const boundSubject = { type: sType, id: String(subjectId) };
          return {
            chat(opts) { return __sw_chatImpl(opts, boundSubject); },
            complete(opts) { return __sw_chatImpl(opts, boundSubject); },
            chatWithTools(opts) { return __sw_scopedChatWithTools(opts, boundSubject); },
            conversations: {
              list(opts) { return conversationsList({ ...(opts || {}), subject_type: sType, subject_id: String(subjectId) }); },
              get(id, opts) { return conversationGet(id, { ...(opts || {}), subject_type: sType, subject_id: String(subjectId) }); },
              delete(id) { return conversationDelete(id, { subject_type: sType, subject_id: String(subjectId) }); },
              fork(sourceId, newId, opts) { return conversationFork(sourceId, newId, { ...(opts || {}), subject_type: sType, subject_id: String(subjectId) }); },
            },
          };
        },
        forUser(userId) {
          return this.scoped(userId, 'app_user');
        },
        transcribe,
        tts,
        generateImage,
        removeBackground,
        embeddings,
        moderate,
        catalog,
      };
    })(),

    agent: (function () {
      let invocationBodyPromise = null;

      function surfaceName(opts) {
        return opts && opts.__surface === 'sw.ai.chatWithTools' ? 'sw.ai.chatWithTools' : 'sw.agent';
      }

      function validationError(message, opts) {
        const err = new Error(surfaceName(opts) + ': ' + message);
        err.code = 'VALIDATION_ERROR';
        if (surfaceName(opts) !== 'sw.ai.chatWithTools') err.status = 400;
        return err;
      }

      function callbackError(code, label, cause, state, opts) {
        const message = cause && cause.message ? cause.message : String(cause);
        const err = new Error(surfaceName(opts) + ': ' + label + ' failed: ' + message);
        err.code = code;
        err.status = 422;
        err.metrics = metricsFromState(state);
        attachPrivate(err.metrics, 'steps', state.steps.slice());
        attachPrivate(err.metrics, 'total_cost_cents', state.total_cost_cents);
        return err;
      }

      function attachPrivate(target, key, value) {
        if (!target || typeof target !== 'object') return target;
        try { Object.defineProperty(target, key, { value, enumerable: false, writable: true, configurable: true }); }
        catch (_) { target[key] = value; }
        return target;
      }

      function normalizeTools(input, opts) {
        const rows = Array.isArray(input)
          ? input
          : (input && typeof input === 'object'
            ? Object.entries(input).map(([name, value]) => ({ name, ...(value || {}) }))
            : []);
        const names = new Set();
        return rows.map((row) => {
          if (!row || typeof row !== 'object') throw validationError('every tool must be an object.', opts);
          const name = typeof row.name === 'string' ? row.name.trim() : '';
          if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw validationError('tool names must start with a letter and contain only letters, numbers, _ or -.', opts);
          if (names.has(name)) throw validationError('tool names must be unique.', opts);
          names.add(name);
          if (typeof row.execute !== 'function' && typeof opts.executeTools !== 'function') {
            throw validationError('tool "' + name + '" needs an execute function.', opts);
          }
          const inputSchema = row.inputSchema || row.input_schema || { type: 'object', properties: {} };
          if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) throw validationError('tool "' + name + '" needs an object inputSchema.', opts);
          return {
            name,
            description: typeof row.description === 'string' ? row.description : '',
            input_schema: inputSchema,
            execute: row.execute,
          };
        });
      }

      function jsonSafe(value, label, maxChars, opts) {
        let text;
        try { text = JSON.stringify(value === undefined ? null : value); }
        catch (_) { throw validationError(label + ' must be JSON-serializable.', opts); }
        if (text.length > maxChars) throw validationError(label + ' is too large (max ' + maxChars + ' serialized characters).', opts);
        return JSON.parse(text);
      }

      async function readInvocation() {
        if (!__sw_agentInvocationRequest) return null;
        if (!invocationBodyPromise) {
          invocationBodyPromise = (async () => {
            const req = __sw_agentInvocationRequest;
            const body = await req.clone().text();
            const source = req.headers.get('X-Somewhere-Invocation-Source') || 'job';
            const invocationId = req.headers.get('X-Somewhere-Job-Id') || '';
            const timestamp = req.headers.get('X-Somewhere-Invocation-Timestamp') || '';
            const bodySha256 = req.headers.get('X-Somewhere-Body-SHA256') || '';
            const signature = req.headers.get('X-Somewhere-Signature') || '';
            const verified = await platformJSON('/v1/jobs/verify-invocation', {
              method: 'POST',
              body: JSON.stringify({ project_id: projectId, source, invocation_id: invocationId, target_method: req.method, target_path: new URL(req.url).pathname, timestamp, body, body_sha256: bodySha256, signature }),
            });
            if (!verified || !verified.valid) throw validationError('workflow callback signature is invalid.');
            let parsed;
            try { parsed = JSON.parse(body); } catch (_) { throw validationError('workflow callback body is not JSON.'); }
            if (!parsed || parsed.__sw_agent_invocation !== true || parsed.agent_id !== invocationId) {
              throw validationError('workflow callback envelope is invalid.');
            }
            return parsed;
          })();
        }
        return invocationBodyPromise;
      }

      function deployedVersion() {
        return env.SW_RELEASE_ID || env.SW_FN_BUNDLE_HASH || env.SW_RUNTIME_VERSION || null;
      }

      function maxStepsFor(opts, fallback) {
        if (opts.__surface === 'sw.ai.chatWithTools' && opts.maxSteps === undefined && opts.maxTurns === undefined) {
          return Math.max(1, Math.min(20, Number(opts.maxIterations) || fallback));
        }
        const raw = opts.maxSteps !== undefined ? opts.maxSteps
          : (opts.maxIterations !== undefined ? opts.maxIterations
            : (opts.maxTurns !== undefined ? opts.maxTurns : fallback));
        const value = Math.trunc(Number(raw));
        if (!Number.isFinite(value) || value < 1 || value > 20) {
          const label = opts.maxSteps !== undefined ? 'maxSteps' : (opts.maxIterations !== undefined ? 'maxIterations' : 'maxTurns');
          throw validationError(label + ' must be an integer from 1 to 20.', opts);
        }
        return value;
      }

      function initialMessages(opts, allowEmpty) {
        let messages;
        if (Array.isArray(opts.messages) && (allowEmpty || opts.messages.length)) messages = opts.messages;
        else {
          const prompt = typeof opts.prompt === 'string' ? opts.prompt : (typeof opts.input === 'string' ? opts.input : '');
          if (!allowEmpty && !prompt.trim()) throw validationError('prompt, input, or a non-empty messages array is required.', opts);
          messages = prompt ? [{ role: 'user', content: prompt }] : [];
        }
        return jsonSafe(messages, 'messages', 128 * 1024, opts);
      }

      function createState(messages, version) {
        return {
          messages,
          steps: [],
          turns: 0,
          iterations: 0,
          tool_calls: 0,
          tool_calls_made: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_cents: 0,
          output: null,
          stop_reason: null,
          completion_reason: null,
          last_response: null,
          deployment_versions: version ? [version] : [],
        };
      }

      function normalizeState(raw, opts) {
        if (!raw || !Array.isArray(raw.messages) || !Array.isArray(raw.steps)) {
          throw validationError('workflow checkpoint is invalid.', opts);
        }
        const state = {
          ...createState(raw.messages, null),
          ...raw,
          turns: Number(raw.turns || raw.iterations || 0),
          iterations: Number(raw.iterations || raw.turns || 0),
          tool_calls: Number(raw.tool_calls || raw.tool_calls_made || 0),
          tool_calls_made: Number(raw.tool_calls_made || raw.tool_calls || 0),
          total_input_tokens: Number(raw.total_input_tokens || 0),
          total_output_tokens: Number(raw.total_output_tokens || 0),
          total_cost_cents: Number(raw.total_cost_cents || 0),
          deployment_versions: Array.isArray(raw.deployment_versions) ? raw.deployment_versions : [],
        };
        const version = deployedVersion();
        if (version && !state.deployment_versions.includes(version)) state.deployment_versions.push(version);
        return state;
      }

      function metricsFromState(state) {
        return {
          iterations: state.iterations,
          tool_calls_made: state.tool_calls_made,
          total_input_tokens: state.total_input_tokens,
          total_output_tokens: state.total_output_tokens,
        };
      }

      function chatOptions(opts, messages, definitions) {
        const out = { ...opts, messages };
        const remove = [
          'executeTools', 'maxIterations', 'maxSteps', 'maxTurns', 'maxSpendCents',
          'prepareStep', 'stopWhen', 'onStepFinish', 'onStep', 'prompt', 'input',
          'systemPrompt', 'serviceTier', 'maxTokens', '__surface', '__sw_boundChat',
        ];
        for (const key of remove) delete out[key];
        if (typeof opts.systemPrompt === 'string' && out.system === undefined) out.system = opts.systemPrompt;
        if (typeof opts.serviceTier === 'string' && out.service_tier === undefined) out.service_tier = opts.serviceTier;
        if (typeof opts.maxTokens === 'number' && out.max_tokens === undefined) out.max_tokens = opts.maxTokens;
        out.tools = definitions;
        if (definitions.length && out.tool_choice === undefined) out.tool_choice = { type: 'auto' };
        if (!definitions.length) {
          delete out.tools;
          delete out.tool_choice;
        }
        return out;
      }

      async function runToolCalls(toolUses, tools, opts, context) {
        if (typeof opts.executeTools === 'function') {
          let rows;
          try {
            rows = await opts.executeTools(toolUses.map((block) => ({ id: block.id, name: block.name, input: block.input })));
          } catch (error) {
            rows = toolUses.map((block) => ({
              tool_use_id: block.id,
              content: 'Tool runner threw: ' + (error && error.message ? error.message : String(error)),
              is_error: true,
            }));
          }
          if (!Array.isArray(rows)) throw validationError('executeTools must return an array of tool_result objects.', opts);
          return rows;
        }

        const rows = [];
        for (let index = 0; index < toolUses.length; index++) {
          const call = toolUses[index];
          const tool = tools.find((candidate) => candidate.name === call.name);
          if (!tool || typeof tool.execute !== 'function') {
            rows.push({ tool_use_id: call.id, content: 'Tool "' + call.name + '" is not registered in this agent.', is_error: true });
            continue;
          }
          try {
            const result = await tool.execute(call.input && typeof call.input === 'object' ? call.input : {}, {
              agentId: context.agentId,
              turn: context.turn,
              toolCallId: context.agentId
                ? context.agentId + ':' + context.turn + ':' + index
                : call.id,
            });
            rows.push({ tool_use_id: call.id, content: result });
          } catch (error) {
            rows.push({ tool_use_id: call.id, content: error && error.message ? error.message : String(error), is_error: true });
          }
        }
        return rows;
      }

      function orderToolResults(toolUses, rows) {
        const byId = new Map();
        for (const row of rows) if (row && typeof row.tool_use_id === 'string') byId.set(row.tool_use_id, row);
        return toolUses.map((call) => {
          const row = byId.get(call.id);
          if (!row) return { type: 'tool_result', tool_use_id: call.id, content: 'No result returned for this tool call.', is_error: true };
          let content;
          try { content = typeof row.content === 'string' ? row.content : JSON.stringify(row.content === undefined ? null : row.content); }
          catch (_) { content = 'Tool result was not JSON-serializable.'; return { type: 'tool_result', tool_use_id: call.id, content, is_error: true }; }
          if (content.length > 24000) content = content.slice(0, 24000) + '\n...[truncated; narrow the tool result]';
          return { type: 'tool_result', tool_use_id: call.id, content, ...(row.is_error ? { is_error: true } : {}) };
        });
      }

      async function executeStep(opts, tools, state, context) {
        const stepNumber = state.steps.length;
        const definitions = tools.map(({ execute: _execute, ...definition }) => definition);
        let callOpts = chatOptions(opts, state.messages, definitions);

        if (opts.prepareStep !== undefined && typeof opts.prepareStep !== 'function') throw validationError('prepareStep must be a function.', opts);
        if (opts.stopWhen !== undefined && typeof opts.stopWhen !== 'function') throw validationError('stopWhen must be a function.', opts);
        if (opts.onStepFinish !== undefined && typeof opts.onStepFinish !== 'function') throw validationError('onStepFinish must be a function.', opts);
        if (opts.prepareStep) {
          let prepared;
          try {
            prepared = await opts.prepareStep({
              stepNumber,
              steps: state.steps.slice(),
              messages: state.messages.slice(),
              provider: callOpts.provider,
              model: callOpts.model,
              system: callOpts.system,
              tools: callOpts.tools,
              toolChoice: callOpts.tool_choice,
              maxTokens: callOpts.max_tokens,
            });
          } catch (error) { throw callbackError('AI_PREPARE_STEP_FAILED', 'prepareStep', error, state, opts); }
          if (prepared !== undefined && prepared !== null) {
            if (typeof prepared !== 'object' || Array.isArray(prepared)) {
              throw callbackError('AI_PREPARE_STEP_FAILED', 'prepareStep', new Error('return value must be an object, null, or undefined'), state, opts);
            }
            if (prepared.messages !== undefined) {
              if (!Array.isArray(prepared.messages)) throw callbackError('AI_PREPARE_STEP_FAILED', 'prepareStep', new Error('messages override must be an array'), state, opts);
              state.messages = prepared.messages.slice();
              callOpts.messages = state.messages;
            }
            if (prepared.provider !== undefined) callOpts.provider = prepared.provider;
            if (prepared.model !== undefined) callOpts.model = prepared.model;
            if (prepared.system !== undefined) callOpts.system = prepared.system;
            if (prepared.tools !== undefined) {
              if (!Array.isArray(prepared.tools)) throw callbackError('AI_PREPARE_STEP_FAILED', 'prepareStep', new Error('tools override must be an array'), state, opts);
              callOpts.tools = prepared.tools;
              if (prepared.tools.length === 0 && prepared.toolChoice === undefined) delete callOpts.tool_choice;
            }
            if (prepared.toolChoice !== undefined) callOpts.tool_choice = prepared.toolChoice;
            if (prepared.maxTokens !== undefined) {
              if (typeof prepared.maxTokens !== 'number' || !Number.isFinite(prepared.maxTokens) || prepared.maxTokens <= 0) {
                throw callbackError('AI_PREPARE_STEP_FAILED', 'prepareStep', new Error('maxTokens override must be a positive number'), state, opts);
              }
              callOpts.max_tokens = prepared.maxTokens;
            }
          }
        }

        const startedAt = Date.now();
        // Runtime v2 (sol P0-2): sw.ai.scoped(id).chatWithTools binds a subject
        // by passing a closure-bound chat OUT OF BAND via __sw_boundChat (the
        // customer cannot construct one — __sw_chatImpl is unexposed). Default
        // agents have none and go through sw.ai.chat, which derives the request
        // principal. chatOptions has already stripped __sw_boundChat from the
        // outbound body, so it never reaches the route.
        const __sw_chatFn = (opts && typeof opts.__sw_boundChat === 'function')
          ? opts.__sw_boundChat
          : sw.ai.chat;
        const response = await __sw_chatFn(callOpts);
        const durationMs = Date.now() - startedAt;
        const blocks = Array.isArray(response && response.content) ? response.content : [];
        const toolUses = blocks.filter((block) => block && block.type === 'tool_use');
        const truncated = response && (response.stop_reason === 'max_tokens' || response.stop_reason === 'length');
        const inputTokens = Number(response && response.usage && response.usage.input_tokens) || 0;
        const outputTokens = Number(response && response.usage && response.usage.output_tokens) || 0;
        const costCents = Number(response && response.cost && response.cost.total_cents) || 0;
        state.total_input_tokens += inputTokens;
        state.total_output_tokens += outputTokens;
        state.total_cost_cents += costCents;
        state.iterations = stepNumber + 1;
        state.turns = state.iterations;
        state.last_response = jsonSafe(response, 'model response', 512 * 1024, opts);
        if (typeof opts.maxSpendCents === 'number' && opts.maxSpendCents > 0 && state.total_cost_cents > opts.maxSpendCents) {
          const err = new Error(surfaceName(opts) + ': maxSpendCents (' + opts.maxSpendCents + '¢) exceeded at iteration ' + stepNumber + '.');
          err.code = 'AI_SPEND_CAP_EXCEEDED';
          err.status = 402;
          err.metrics = metricsFromState(state);
          attachPrivate(err.metrics, 'steps', state.steps.slice());
          attachPrivate(err.metrics, 'total_cost_cents', state.total_cost_cents);
          throw err;
        }

        let orderedResults = [];
        let completionReason = 'model_done';
        if (!truncated && response.stop_reason === 'tool_use' && toolUses.length) {
          state.tool_calls_made += toolUses.length;
          state.tool_calls = state.tool_calls_made;
          const rows = await runToolCalls(toolUses, tools, opts, context);
          orderedResults = orderToolResults(toolUses, rows);
          completionReason = 'tool_use';
        }
        const responseText = typeof response.text === 'string'
          ? response.text
          : blocks.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
        if (truncated) completionReason = 'output_truncated';
        const step = {
          step_number: stepNumber,
          turn: context.turn,
          provider: response.provider || callOpts.provider || null,
          model: response.model || callOpts.model || null,
          content: blocks,
          text: responseText,
          output: responseText || null,
          stop_reason: response.stop_reason || null,
          tool_calls: truncated ? [] : toolUses.map((block, index) => ({
            id: block.id,
            name: block.name,
            input: block.input,
            is_error: !!orderedResults[index]?.is_error,
          })),
          tool_results: orderedResults,
          usage: response.usage || null,
          started_at: startedAt,
          duration_ms: durationMs,
          completion_reason: completionReason,
        };
        attachPrivate(step, 'cost_cents', costCents);
        state.steps.push(step);

        if (opts.onStepFinish) {
          try { await opts.onStepFinish({ step, steps: state.steps.slice() }); }
          catch (error) { throw callbackError('AI_STEP_HOOK_FAILED', 'onStepFinish', error, state, opts); }
        }

        let done = false;
        if (completionReason === 'model_done' || completionReason === 'output_truncated') {
          state.stop_reason = completionReason;
          state.completion_reason = completionReason;
          done = true;
        }

        if (!done && opts.stopWhen) {
          let shouldStop;
          try { shouldStop = await opts.stopWhen({ step, steps: state.steps.slice() }); }
          catch (error) { throw callbackError('AI_STOP_CONDITION_FAILED', 'stopWhen', error, state, opts); }
          if (shouldStop) {
            const reason = typeof shouldStop === 'string' && shouldStop.trim() ? shouldStop.trim() : 'stop_when';
            state.stop_reason = reason;
            state.completion_reason = reason;
            done = true;
          }
        }

        if (!done && context.turn >= context.maxSteps) {
          const reason = opts.__surface === 'sw.ai.chatWithTools'
            ? 'max_iterations'
            : (opts.maxTurns !== undefined && opts.maxSteps === undefined && opts.maxIterations === undefined ? 'max_turns' : 'max_steps');
          state.stop_reason = reason;
          state.completion_reason = reason;
          done = true;
        }

        if (opts.conversation_id) {
          if (orderedResults.length) state.messages = [{ role: 'user', content: orderedResults }];
        } else {
          state.messages.push({ role: 'assistant', content: blocks });
          if (orderedResults.length) state.messages.push({ role: 'user', content: orderedResults });
        }
        state.output = step.text || state.output || null;

        if (typeof opts.onStep === 'function') {
          const legacyEvent = {
            agentId: context.agentId,
            turn: context.turn,
            maxTurns: context.maxSteps,
            output: step.text || null,
            toolCalls: step.tool_calls.map((call, index) => ({ id: call.id, name: call.name, is_error: !!orderedResults[index]?.is_error })),
            done,
            stopReason: done ? state.stop_reason : null,
          };
          const onStepResult = await opts.onStep(legacyEvent);
          const safeResult = jsonSafe(onStepResult, 'onStep result', 32000, opts);
          if (safeResult !== null) step.on_step = safeResult;
        }
        return { state, response, done };
      }

      function terminalResult(state, response, completionReason) {
        const out = {
          ...(response || {}),
          ...metricsFromState(state),
          completion_reason: completionReason,
        };
        attachPrivate(out, 'steps', state.steps.slice());
        attachPrivate(out, 'total_cost_cents', state.total_cost_cents);
        return out;
      }

      async function run(opts) {
        opts = opts || {};
        if (opts.__surface === 'sw.ai.chatWithTools' && typeof opts.executeTools !== 'function') {
          throw validationError('executeTools function is required', opts);
        }
        const tools = normalizeTools(opts.tools || [], opts);
        const maxSteps = maxStepsFor(opts, opts.__surface === 'sw.ai.chatWithTools' ? 5 : 8);
        let state = createState(initialMessages(opts, opts.__surface === 'sw.ai.chatWithTools'), deployedVersion());
        let response = null;
        for (let index = 0; index < maxSteps; index++) {
          const next = await executeStep(opts, tools, state, { agentId: null, turn: index + 1, maxSteps });
          state = next.state;
          response = next.response;
          if (next.done) {
            if (opts.__surface !== 'sw.ai.chatWithTools' || state.completion_reason !== 'max_iterations') {
              return terminalResult(state, response, state.completion_reason);
            }
            break;
          }
        }
        if (opts.__surface === 'sw.ai.chatWithTools') {
          const err = new Error('sw.ai.chatWithTools: maxIterations (' + maxSteps + ') reached without a final answer.');
          err.code = 'AI_MAX_ITERATIONS';
          err.status = 422;
          err.metrics = { ...metricsFromState(state), last_response: response };
          attachPrivate(err.metrics, 'steps', state.steps.slice());
          attachPrivate(err.metrics, 'total_cost_cents', state.total_cost_cents);
          throw err;
        }
        return terminalResult(state, response, state.completion_reason || 'max_steps');
      }

      async function executeDurableStep(opts, tools, invocation) {
        const turn = Number(invocation.turn);
        const maxSteps = Number(invocation.max_steps || invocation.max_turns);
        if (!Number.isInteger(turn) || turn < 1 || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 20) {
          throw validationError('workflow step bounds are invalid.', opts);
        }
        let state = normalizeState(invocation.state, opts);
        const next = await executeStep(opts, tools, state, { agentId: invocation.agent_id, turn, maxSteps });
        state = next.state;
        const safeState = jsonSafe(state, 'agent checkpoint', 1024 * 1024, opts);
        return { __sw_agent_turn: true, state: safeState, done: next.done };
      }

      async function start(opts, legacyAlias) {
        opts = opts || {};
        if (!opts.model || typeof opts.model !== 'string') throw validationError('model is required.', opts);
        normalizeTools(opts.tools || [], opts);
        const invocation = await readInvocation();
        if (invocation) return executeDurableStep(opts, normalizeTools(opts.tools || [], opts), invocation);

        const maxSteps = maxStepsFor(opts, 8);
        const messages = initialMessages(opts, false);
        const version = deployedVersion();
        const created = await platformJSON('/v1/jobs', {
          method: 'POST',
          headers: await __sw_runtimeSubjectHeaders('X-Somewhere-Jobs-Authority', 'project_runtime'),
          body: JSON.stringify({
            project_id: projectId,
            handler: request.url,
            payload: { messages },
            timeout_seconds: 1800,
            priority: 'low',
            agent: legacyAlias
              ? { messages, max_turns: maxSteps }
              : { messages, max_turns: maxSteps, max_steps: maxSteps, ...(version ? { deployment_version: version } : {}) },
          }),
        });
        return legacyAlias
          ? { agent_id: created.job_id, status: created.status, max_turns: maxSteps }
          : { agent_id: created.job_id, status: created.status, max_steps: maxSteps };
      }

      async function agent(opts) {
        return start(opts, true);
      }
      agent.run = run;
      agent.start = function (opts) { return start(opts, false); };
      agent.status = async function (agentId) {
        if (!agentId || typeof agentId !== 'string') throw validationError('agent id is required.');
        const row = await platformJSON('/v1/jobs/' + encodeURIComponent(agentId), {
          headers: await __sw_runtimeSubjectHeaders('X-Somewhere-Jobs-Authority', 'project_runtime'),
        });
        return { ...row, agent_id: row.job_id || agentId };
      };
      agent.cancel = async function (agentId) {
        if (!agentId || typeof agentId !== 'string') throw validationError('agent id is required.');
        const row = await platformJSON('/v1/jobs/' + encodeURIComponent(agentId) + '/cancel', {
          method: 'POST', headers: await __sw_runtimeSubjectHeaders('X-Somewhere-Jobs-Authority', 'project_runtime'),
        });
        return { ...row, agent_id: row.job_id || agentId };
      };
      return agent;
    })(),

    image: (function () {
      // Image transformations — URL builder. Returns a string URL that
      // points at Cloudflare's image resizer on the project's domain.
      // Stick the URL in <img src="..."> or fetch it server-side. No
      // API call is made by this helper; transformation happens at the
      // edge when the URL is fetched.
      const PROJECT_HOST = env.SUBDOMAIN && env.TENANT_DOMAIN
        ? env.SUBDOMAIN + '.' + env.TENANT_DOMAIN
        : null;

      function buildOpts(opts) {
        opts = opts || {};
        const parts = [];
        const allowed = [
          'width', 'height', 'fit', 'format', 'quality', 'dpr', 'gravity',
          'background', 'blur', 'sharpen', 'rotate', 'trim', 'metadata',
          'anim', 'brightness', 'contrast', 'gamma', 'border',
        ];
        for (const k of allowed) {
          const v = opts[k];
          if (v === undefined || v === null) continue;
          parts.push(k + '=' + String(v));
        }
        return parts.length > 0 ? parts.join(',') : 'format=auto';
      }

      function resize(source, opts) {
        if (typeof source !== 'string' || source.length === 0) {
          throw new Error('sw.image.resize: source must be a non-empty URL or path string');
        }
        const optStr = buildOpts(opts);
        // Absolute URL: use as-is for the source. The cdn-cgi prefix
        // still needs a host with Image Transformations enabled — we
        // use the project's own subdomain.
        // NOTE: this regex lives inside a template literal; \/ here
        // emits / in the bundle, which is what V8 needs to keep the
        // regex literal valid. A bare / collapses to / and breaks
        // every customer's bundle (incident: 2026-05-09).
        if (/^https?:\/\//i.test(source)) {
          if (!PROJECT_HOST) {
            throw new Error('sw.image.resize: project subdomain not available; cannot build transform URL');
          }
          return 'https://' + PROJECT_HOST + '/cdn-cgi/image/' + optStr + '/' + source;
        }
        // Relative path: assume project subdomain.
        if (!PROJECT_HOST) {
          throw new Error('sw.image.resize: project subdomain not available; pass an absolute URL instead');
        }
        const path = source.startsWith('/') ? source : '/' + source;
        return 'https://' + PROJECT_HOST + '/cdn-cgi/image/' + optStr + path;
      }

      return { resize };
    })(),

    auth: (function () {
      // Direct D1 binding — same one sw.db uses. Needed by migrateAnon
      // so a single call can rewrite anon→user rows in one place
      // instead of fanning out HTTP requests.
      const DB = env.PROJECT_DB;

      // Forward an end-user JWT (app_user) directly as the Authorization
      // header — used for routes that require an app_user JWT (verify
      // email, update password, profile, /me). The smt_ developer key is
      // skipped for these calls because the route handlers explicitly
      // reject developer mode.
      async function userTokenJSON(path, token, opts) {
        opts = opts || {};
        const headers = {
          'Authorization': 'Bearer ' + token,
          ...(opts.headers || {}),
        };
        // Bind the token to THIS function's project (tsk_1c0eb7d9) — the same
        // cross-project binding sw.auth.me stamps. Without it, every helper
        // built on userTokenJSON (updateProfile / updatePassword / deleteUser /
        // verify-email / resend) accepted a JWT minted by ANOTHER project and
        // mutated THAT project's user. The route rejects (401) when the token's
        // project_id differs from this header — same enforcement /v1/auth/me uses.
        if (projectId && !headers['X-Sw-Executing-Project']) {
          headers['X-Sw-Executing-Project'] = projectId;
        }
        if (opts.body && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        const r = await __sw_runtimeFetch(platformBase + path, {
          method: opts.method || 'GET',
          headers,
          body: opts.body,
        });
        let data;
        try { data = await r.json(); } catch { data = null; }
        const newAccess = r.headers.get('X-New-Access-Token') || r.headers.get('x-new-access-token');
        const newRefresh = r.headers.get('X-New-Refresh-Token') || r.headers.get('x-new-refresh-token');
        if (newAccess && newRefresh) {
          __sw_pendingRefresh.access = newAccess;
          __sw_pendingRefresh.refresh = newRefresh;
        }
        if (!r.ok || !data || data.ok === false) {
          const msg = (data && data.message) || ('Auth call failed: ' + r.status);
          const err = new Error(msg);
          err.code = (data && data.error) || 'AUTH_ERROR';
          err.status = r.status;
          throw err;
        }
        return data.data;
      }

      function cookieSessionAuth(method, req) {
        if (!req || !req.headers || typeof req.headers.get !== 'function') {
          const err = new Error('sw.auth.' + method + ': request is required.');
          err.code = 'VALIDATION_ERROR';
          err.status = 400;
          throw __sw_markExpected(err);
        }
        const cookieHeader = req.headers.get('cookie') || req.headers.get('Cookie') || '';
        __sw_expireLegacyAuthCookiesIfPresent(cookieHeader, req.url);
        // NULL PROTOTYPE, deliberately. Both the membership test below
        // ("k in jar") and every "jar[name]" read traverse the prototype
        // chain. With a plain {}, a polluted Object.prototype.token — set by
        // app code, a dependency, or an earlier request in this warm isolate
        // — is read as this request's credential even when the request
        // carried no cookie at all; it also makes the membership test treat a
        // real cookie as already-present and DROP it. A null-prototype jar
        // inherits nothing, so both reads can only ever see keys this cookie
        // header actually supplied. Fixed at the jar rather than by guarding
        // each read, so a fifth read cannot reintroduce it. (tsk_180fc3d9)
        // NB: this file is emitted as a template literal — no backticks.
        const jar = __sw_objCreateNull();
        for (const part of cookieHeader.split(';')) {
          const eq = part.indexOf('=');
          if (eq < 0) continue;
          const k = part.slice(0, eq).trim();
          if (k && !(k in jar)) {
            const raw = part.slice(eq + 1).trim();
            try { jar[k] = decodeURIComponent(raw); } catch (_) { jar[k] = raw; }
          }
        }
        let token = null;
        let fromCookie = false;
        for (const name of ['__Host-token', '__Host-auth_token', '__Host-session']) {
          const v = jar[name];
          if (v) { token = v; fromCookie = true; break; }
        }
        if (!token) {
          token = __sw_readBearer(req.headers.get('Authorization') || req.headers.get('authorization'));
        }
        if (!token) {
          const err = new Error('Sign in required.');
          err.code = 'AUTH_REQUIRED';
          err.status = 401;
          throw __sw_markExpected(err);
        }
        if (fromCookie) {
          __sw_enforceCookieCsrf(req);
        }

        let refreshToken = null;
        const optOut = req.headers.get('X-No-Auto-Refresh') || req.headers.get('x-no-auto-refresh');
        if (optOut !== '1') {
          refreshToken = req.headers.get('X-Refresh-Token') || req.headers.get('x-refresh-token');
          if (!refreshToken) {
            for (const name of ['__Host-refresh_token', '__Host-sw_refresh_token']) {
              const v = jar[name];
              if (v) { refreshToken = v; break; }
            }
          }
        }
        if (fromCookie && __sw_pendingRefresh.access) {
          token = __sw_pendingRefresh.access;
          if (__sw_pendingRefresh.refresh) refreshToken = __sw_pendingRefresh.refresh;
        }
        return { token, refreshToken, fromCookie };
      }

      // A shallow clone of an auth payload that also clones a nested .user. The
      // me() cache stores a PRIVATE snapshot and hands out only clones of it, so
      // every caller gets a fresh object: mutating a previously-returned payload
      // can never corrupt the snapshot or any later caller's copy — which is
      // also what makes id/role read off a fresh me() result authoritative.
      function __sw_cloneAuthPayload(payload) {
        if (!payload || typeof payload !== 'object') return payload;
        if (payload.user && typeof payload.user === 'object') {
          return __sw_assign({}, payload, { user: __sw_assign({}, payload.user) });
        }
        return __sw_assign({}, payload);
      }

      function socialOauthUrl(provider, opts) {
        opts = opts || {};
        if (!opts.redirect_uri) {
          const err = new Error('sw.auth.' + provider + 'Url: redirect_uri is required');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        const params = new URLSearchParams({
          project_id: projectId,
          redirect_uri: opts.redirect_uri,
        });
        return platformBase + '/v1/auth/' + provider + '?' + params.toString();
      }

      function socialOauthExchange(provider, opts) {
        return platformJSON('/v1/auth/' + provider + '/exchange', {
          method: 'POST',
          body: JSON.stringify(opts || {}),
        });
      }

      async function moderationJSON(req, path, opts) {
        opts = opts || {};
        if (!req || !req.headers || typeof req.headers.get !== 'function') {
          const err = new Error('sw.auth.moderation: request is required.');
          err.code = 'MODERATION_INVALID_ARGUMENT';
          err.status = 400;
          throw __sw_markExpected(err);
        }
        // Resolve the actor only from the Request supplied to this operation.
        // The platform route independently re-reads the stored admin role and
        // applies the same-project, self-op, last-admin, rate, and audit gates.
        const authRequest = new Request(req.url, {
          method: opts.method || 'GET',
          headers: req.headers,
        });
        const auth = cookieSessionAuth('moderation', authRequest);
        try {
          return await userTokenJSON(path, auth.token, {
            method: opts.method || 'GET',
            headers: auth.refreshToken ? { 'X-Refresh-Token': auth.refreshToken } : {},
            body: opts.body,
          });
        } catch (err) {
          throw __sw_markExpected(err);
        }
      }

      function moderationUserPath(userId, suffix) {
        if (typeof userId !== 'string' || !userId.trim()) {
          const err = new Error('sw.auth.moderation: userId must be a non-empty string.');
          err.code = 'MODERATION_INVALID_ARGUMENT';
          err.status = 400;
          throw __sw_markExpected(err);
        }
        return '/v1/auth/admin/users/' + encodeURIComponent(userId.trim()) + (suffix || '');
      }

      async function socialOauthCallbackWithCookie(provider, req, redirectTo) {
        const u = new URL(req.url);
        const code = u.searchParams.get('code');
        if (!code) { const e = new Error('Missing ?code on the OAuth callback.'); e.code = 'VALIDATION_ERROR'; e.status = 400; e.__sw_expose = true; throw e; }
        let d;
        try { d = await socialOauthExchange(provider, { code: code }); }
        catch (err) { throw __sw_markExpected(err); }
        const access = d && (d.token || d.access_token);
        const refresh = d && d.refresh_token;
        if (access && refresh) __sw_setAuthCookies(access, refresh);
        return new Response(null, { status: 302, headers: { Location: redirectTo || '/' } });
      }

      // THE identity spine (tsk_327fe8a4, Runtime v2). The ONE derivation of a
      // verified principal — behind sw.auth.fromRequest / sw.auth.requireUser
      // AND the automatic structured-query scoping in sw.db (tsk_5b91e0e4).
      // User authority arrives on EITHER credential TRANSPORT and both verify
      // identically — the seven checks run once, server-side, inside
      // sw.auth.me (signature, issuer, audience/project binding, expiration,
      // token type, session/revocation state, intended authority):
      //   (a) the credential ATTACHED to req — cookie or Authorization Bearer;
      //   (b) opts.forwardedToken — an explicitly forwarded platform-issued
      //       app-user token STRING (a second transport, never an exception).
      // Returns { user, id, role } or null. id/role are captured from the fresh
      // me() result BEFORE enrichment and before any customer code can touch the
      // object — me() only ever returns network-fresh objects or clones of its
      // private cache snapshot — so they are the authoritative identity; an
      // enriched dev-table row can never supply either value. It NEVER accepts
      // an identity CLAIM: a bare id / { user } / mutable principal handed as
      // forwardedToken is a typed FORWARDED_CREDENTIAL_INVALID throw, never a
      // silent identity.
      async function __sw_resolveRequestUser(req, opts) {
        // Transport (b): an explicitly forwarded credential. Presence of the
        // key with a non-string value is an identity CLAIM — reject it loudly
        // rather than deriving authority from something the caller supplied.
        if (opts && __sw_own(opts, 'forwardedToken')
            && opts.forwardedToken !== undefined && opts.forwardedToken !== null) {
          const forwarded = opts.forwardedToken;
          if (typeof forwarded !== 'string' || !forwarded) {
            const err = new Error('sw.auth: a forwarded credential must be a platform-issued app-user token string, not an identity value.');
            err.code = 'FORWARDED_CREDENTIAL_INVALID';
            err.status = 400;
            throw __sw_markExpected(err);
          }
          // A forwarded access token is a bearer credential, not this request's
          // session: no cookie, no CSRF gate, no auto-refresh.
          return await __sw_principalFromToken(forwarded, { fromCookie: false, refreshToken: null, enrich: opts });
        }

        // Transport (a): the credential attached to this request.
        if (!req || !req.headers || typeof req.headers.get !== 'function') return null;
        // Parse the Cookie header once into an exact-key map. A per-name
        // regex had an order edge case — reading 'token' failed when
        // 'sw_refresh_token' (which contains "token") came first in the
        // header, which browsers do freely (tsk_1288e1c6). Exact-key match
        // is order-independent and collision-free.
        const cookieHeader = req.headers.get('cookie') || req.headers.get('Cookie') || '';
        __sw_expireLegacyAuthCookiesIfPresent(cookieHeader, req.url);
        // Null-prototype (H1): the jar must reflect ONLY cookies actually in
        // the header. A plain {} reads through Object.prototype, so a polluted
        // Object.prototype.token would supply a phantom cookie that resolves an
        // unauthenticated request as another user and even overrides a real
        // Bearer (the cookie names are checked before the Authorization header).
        const jar = __sw_objCreateNull();
        for (const part of cookieHeader.split(';')) {
          const eq = part.indexOf('=');
          if (eq < 0) continue;
          const k = part.slice(0, eq).trim();
          if (k && !(k in jar)) {
            const raw = part.slice(eq + 1).trim();
            try { jar[k] = decodeURIComponent(raw); } catch (_) { jar[k] = raw; }
          }
        }
        let token = null;
        let fromCookie = false;
        for (const name of ['__Host-token', '__Host-auth_token', '__Host-session']) {
          if (jar[name]) { token = jar[name]; fromCookie = true; break; }
        }
        if (!token) {
          token = __sw_readBearer(req.headers.get('Authorization') || req.headers.get('authorization'));
        }
        if (!token) return null;

        // CSRF gate (tsk_272ce30 + tsk_38d7307f + tsk_67661784):
        // missing Origin on unsafe cookie-authenticated methods is a typed
        // 400; disallowed cross-origin cookie auth is a typed 403.
        if (fromCookie) __sw_enforceCookieCsrf(req);

        let refreshToken = null;
        const optOut = req.headers.get('X-No-Auto-Refresh') || req.headers.get('x-no-auto-refresh');
        if (optOut !== '1') {
          refreshToken = req.headers.get('X-Refresh-Token') || req.headers.get('x-refresh-token');
          if (!refreshToken) {
            for (const name of ['__Host-refresh_token', '__Host-sw_refresh_token']) {
              if (jar[name]) { refreshToken = jar[name]; break; }
            }
          }
        }

        return await __sw_principalFromToken(token, { fromCookie, refreshToken, enrich: opts });
      }

      // Shared verification tail: a token → a verified principal (or null).
      // Both credential transports funnel through here, so the seven checks
      // (run inside me(), server-side) happen once. id/role are read off the
      // fresh me() result before enrichment, so an enriched dev-table row can
      // never supply either. ctx = { fromCookie, refreshToken, enrich }.
      async function __sw_principalFromToken(token, ctx) {
        ctx = ctx || {};
        const enrich = ctx.enrich;
        let user;
        try {
          const noCache = Boolean(enrich && enrich.__sw_noAuthCache === true);
          const result = await __sw_auth.me(token, ctx.refreshToken ? { refreshToken: ctx.refreshToken, noCache } : (noCache ? { noCache: true } : undefined));
          user = result && result.user ? result.user : (result || null);
        } catch (err) {
          // Do NOT collapse two different facts into one silent null
          // (tsk_786aba5e / feedback_fail_loudly). A 401/403 is an EXPECTED
          // credential rejection — invalid / expired / revoked token — and the
          // caller treating it as unauthenticated is correct and quiet by
          // design. ANYTHING ELSE (network error, 5xx, timeout) is a
          // verification we COULD NOT ADJUDICATE: returning null there logs a
          // still-valid session out AND hides a platform fault behind a
          // "session ended" — exactly why this incident stayed invisible for
          // hours. We still return null (the auth path must never throw its way
          // into a 500), but the failure is now LOUD and classified in logs.
          const status = err && typeof err.status === 'number' ? err.status : 0;
          const credentialRejected = status === 401 || status === 403;
          if (!credentialRejected) {
            console.error(
              '[sw.auth] identity verification could not complete (PLATFORM FAULT, not a logout — the credential may still be valid):',
              (err && err.code) || 'AUTH_VERIFY_UNAVAILABLE',
              (err && err.message) || String(err),
            );
          }
          return null;
        }
        if (!user) return null;
        // The authoritative identity read: off the object me() just returned,
        // before enrichment and before the object is handed to anyone.
        const verifiedId = user.id;
        const verifiedRole = user.role === 'admin' ? 'admin' : 'user';

        // Cookie session that auto-refreshed → re-issue the httpOnly cookies so
        // the browser keeps a long-lived session, invisibly (tsk_1288e1c6). The
        // header-based X-New-* path (non-cookie clients) is unaffected. Only a
        // request-attached cookie transport re-issues; a forwarded token does not.
        if (ctx.fromCookie && __sw_pendingRefresh.access && __sw_pendingRefresh.refresh) {
          __sw_setAuthCookies(__sw_pendingRefresh.access, __sw_pendingRefresh.refresh);
        }

        // Optional enrichment — JOIN the dev's user-table row onto
        // the platform user. Skipped when not requested or when sw.db
        // isn't bound (shouldn't happen in practice). Errors are
        // swallowed so a missing table doesn't crash the request —
        // returns the unenriched user.
        if (enrich && enrich.enrichFrom && DB && typeof DB.prepare === 'function') {
          const table = String(enrich.enrichFrom);
          // Allow only [a-zA-Z0-9_] table names to block SQL injection on
          // this enrichment surface.
          if (!/^[a-zA-Z0-9_]+$/.test(table)) {
            console.error('sw.auth.fromRequest: invalid enrichFrom table name:', table);
            return { user: user, id: verifiedId, role: verifiedRole };
          }
          const joinCol = enrich.on && /^[a-zA-Z0-9_]+$/.test(String(enrich.on))
            ? String(enrich.on)
            : 'id';
          let selectExpr = '*';
          if (__sw_arrayIsArray(enrich.fields) && enrich.fields.length > 0) {
            const cleaned = enrich.fields
              .filter((f) => typeof f === 'string' && /^[a-zA-Z0-9_]+$/.test(f))
              .map((f) => '"' + f + '"');
            if (cleaned.length > 0) selectExpr = cleaned.join(', ');
          }
          try {
            const row = await DB.prepare(
              'SELECT ' + selectExpr + ' FROM "' + table + '" WHERE "' + joinCol + '" = ?'
            ).bind(verifiedId).first();
            if (row) {
              // Platform fields win on collision — never let the
              // dev table overwrite id/email/etc.
              user = __sw_assign({}, row, user);
            }
          } catch (err) {
            console.error('sw.auth.fromRequest enrichment failed:', err && err.message ? err.message : err);
          }
        }
        return { user: user, id: verifiedId, role: verifiedRole };
      }

      const __sw_auth = {
        signup(opts) {
          return platformJSON('/v1/auth/signup', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },
        login(opts) {
          return platformJSON('/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },
        logout(opts) {
          return platformJSON('/v1/auth/logout', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },
        async me(token, opts) {
          opts = opts || {};
          const refreshToken = opts.refreshToken || null;

          // Pre-flight parses the JWT and detects malformed input
          // synchronously. Expired tokens are tolerated here ONLY when
          // a paired refreshToken is supplied — the platform-side
          // /v1/auth/me handler does the auto-refresh dance and
          // returns the new pair via X-New-* response headers, which
          // we capture into the function context's __sw_pendingRefresh
          // slot so the shim can attach them to the user's response.
          const pre = refreshToken
            ? __sw_preflightJwtAllowExpired(token)
            : __sw_preflightJwt(token);

          // Request-local single-flight (tsk_786aba5e): one verification per
          // credential per request, INCLUDING the expired+refresh path the TTL
          // cache below deliberately skips. Without it, sw.auth.requireUser and
          // the sw.db scoped-query resolver each fire their own /v1/auth/me —
          // two auto-refreshes of the SAME refresh token, and single-use
          // rotation reads the second as reuse and revokes the whole session.
          // Re-enter ONCE (guarded by __sw_noInflight) to run the body below,
          // memoize that promise by signature, and hand every caller its own
          // clone so a mutated return can't corrupt a shared snapshot.
          if (pre && pre.sig && !opts.__sw_noInflight) {
            const inflight = __sw_cacheGet(__sw_authMeInflight, pre.sig);
            if (inflight) return inflight.then(__sw_cloneAuthPayload);
            const p = __sw_auth.me(token, __sw_assign({}, opts, { __sw_noInflight: true }));
            __sw_cacheSet(__sw_authMeInflight, pre.sig, p);
            return p.then(__sw_cloneAuthPayload);
          }

          const now = Date.now();

          // Cache hit short-circuits the network call. Skip the cache
          // when a refreshToken is supplied AND the access token is
          // expired — otherwise a previously-cached fresh response
          // would suppress the refresh that the caller is asking for.
          // The cache stores a PRIVATE snapshot, never an object we handed
          // out: each hit returns a fresh clone, so mutating a returned
          // payload cannot corrupt what a later caller sees.
          if (!opts.noCache && !(refreshToken && pre.expired)) {
            const hit = __sw_cacheGet(__sw_authMeCache, pre.sig);
            if (hit && hit.expiresAt > now) {
              return __sw_cloneAuthPayload(hit.snapshot);
            }
          }

          // Build the auth call by hand because we need the raw
          // Response back to read X-New-* headers — userTokenJSON
          // throws away the headers and returns data only.
          const headers = { 'Authorization': 'Bearer ' + token };
          if (refreshToken) headers['X-Refresh-Token'] = refreshToken;
          // Bind the token to THIS function's project (tsk_0409aa4f).
          // Without this, /v1/auth/me only checks the token is internally
          // consistent with its OWN project_id — so a JWT minted for
          // project A authenticated inside project B's deployed function.
          // The header tells /me which project is executing; /me rejects
          // (401) when the token's project_id differs — the same binding
          // the REST /v1/db path enforces via resolveProjectScope.
          if (projectId) headers['X-Sw-Executing-Project'] = projectId;
          const r = await __sw_runtimeFetch(platformBase + '/v1/auth/me', { headers });
          let data;
          try { data = await r.json(); } catch { data = null; }
          if (!r.ok || !data || data.ok === false) {
            const msg = (data && data.message) || ('Auth call failed: ' + r.status);
            const err = new Error(msg);
            err.code = (data && data.error) || 'AUTH_ERROR';
            err.status = r.status;
            throw err;
          }

          const newAccess = r.headers.get('X-New-Access-Token') || r.headers.get('x-new-access-token');
          const newRefresh = r.headers.get('X-New-Refresh-Token') || r.headers.get('x-new-refresh-token');
          if (newAccess && newRefresh) {
            __sw_pendingRefresh.access = newAccess;
            __sw_pendingRefresh.refresh = newRefresh;
          }

          const payload = data.data;

          // Only cache when refresh did NOT fire. If refresh fired the
          // cache key (sig of the old access token) is stale anyway. Cache a
          // CLEAN snapshot of the payload — never the object we just
          // returned — so a later hit clones a copy that mutations of prior
          // returns cannot have corrupted.
          if (!opts.noCache && !(newAccess && newRefresh)) {
            let ttl = __sw_AUTH_ME_TTL_MS;
            if (pre.expSec) {
              const untilExp = pre.expSec * 1000 - now - 5_000;
              if (untilExp > 0 && untilExp < ttl) ttl = untilExp;
            }
            if (ttl > 0) {
              if (__sw_cacheSize(__sw_authMeCache) >= __sw_AUTH_ME_MAX) {
                const firstKey = __sw_cacheKeys(__sw_authMeCache).next().value;
                if (firstKey) __sw_cacheDelete(__sw_authMeCache, firstKey);
              }
              __sw_cacheSet(__sw_authMeCache, pre.sig, { snapshot: __sw_cloneAuthPayload(payload), expiresAt: now + ttl });
            }
          }
          return payload;
        },
        refresh(opts) {
          return platformJSON('/v1/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },
        forgot(opts) {
          return platformJSON('/v1/auth/forgot', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },
        reset(opts) {
          return platformJSON('/v1/auth/reset', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },
        requestEmailVerification(token) {
          return userTokenJSON('/v1/auth/request-email-verification', token, { method: 'POST' });
        },
        verifyEmail(token, opts) {
          return userTokenJSON('/v1/auth/verify-email', token, {
            method: 'POST',
            body: JSON.stringify(opts || {}),
          });
        },
        resendVerification(token) {
          return userTokenJSON('/v1/auth/resend-verification', token, { method: 'POST' });
        },
        updatePassword(token, opts) {
          return userTokenJSON('/v1/auth/update-password', token, {
            method: 'POST',
            body: JSON.stringify(opts || {}),
          });
        },
        updateProfile(token, opts) {
          return userTokenJSON('/v1/auth/users/me', token, {
            method: 'PATCH',
            body: JSON.stringify(opts || {}),
          });
        },
        async updateProfileWithCookie(req, opts) {
          const auth = cookieSessionAuth('updateProfileWithCookie', req);
          let d;
          try {
            d = await userTokenJSON('/v1/auth/users/me', auth.token, {
              method: 'PATCH',
              headers: auth.refreshToken ? { 'X-Refresh-Token': auth.refreshToken } : {},
              body: JSON.stringify(opts || {}),
            });
          } catch (err) { throw __sw_markExpected(err); }
          if (auth.fromCookie && __sw_pendingRefresh.access && __sw_pendingRefresh.refresh) {
            __sw_setAuthCookies(__sw_pendingRefresh.access, __sw_pendingRefresh.refresh);
          }
          // Same wrapped contract as the other cookie helpers (tsk_72c4b4d2).
          return { user: __sw_requireAuthUser('updateProfileWithCookie', d) };
        },
        deleteUser(token) {
          return userTokenJSON('/v1/auth/users/me', token, { method: 'DELETE' });
        },
        // Build the Google OAuth URL for the user's browser. After consent,
        // the platform redirects to redirect_uri with ?code=AUTH_CODE.
        // Pass that code to sw.auth.googleExchange to get the JWT.
        googleUrl(opts) {
          opts = opts || {};
          if (!opts.redirect_uri) {
            const err = new Error('sw.auth.googleUrl: redirect_uri is required');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          const params = new URLSearchParams({
            project_id: projectId,
            redirect_uri: opts.redirect_uri,
          });
          return platformBase + '/v1/auth/google?' + params.toString();
        },
        googleExchange(opts) {
          return platformJSON('/v1/auth/google/exchange', {
            method: 'POST',
            body: JSON.stringify(opts || {}),
          });
        },
        githubUrl(opts) {
          return socialOauthUrl('github', opts);
        },
        githubExchange(opts) {
          return socialOauthExchange('github', opts);
        },
        discordUrl(opts) {
          return socialOauthUrl('discord', opts);
        },
        discordExchange(opts) {
          return socialOauthExchange('discord', opts);
        },

        // ── httpOnly cookie sessions (tsk_1288e1c6) ──────────────────────
        // Set the session as HttpOnly + Secure cookies on the response and
        // return the user. The client just does fetch(url, { credentials:
        // 'include' }) — no tokens in localStorage, nothing for XSS to steal,
        // and fromRequest auto-refreshes the cookie so sessions are long-lived.
        // The cookies ride out on the Response via the shim, so the handler
        // returns a Response-ready envelope and does zero header work.
        //
        // Response contract (tsk_72c4b4d2, A-F05): every cookie helper that
        // carries a user returns it WRAPPED — { user: {...} } — matching
        // GET /me, so Response.json(await sw.auth.loginWithCookie(...))
        // always yields the documented envelope. A success without a user is
        // impossible by construction: if the upstream sign-in response ever
        // lacked one that is a platform fault, and the helper THROWS instead
        // of returning a bare object or null (a 200-with-null body was the
        // old ambiguous-success failure mode).
        async loginWithCookie(req, email, password) {
          const creds = __sw_cookieCreds('loginWithCookie', req, email, password);
          let d;
          try { d = await this.login(creds); }
          catch (err) { throw __sw_markExpected(err); }
          const access = d && (d.token || d.access_token);
          const refresh = d && d.refresh_token;
          if (access && refresh) __sw_setAuthCookies(access, refresh);
          return { user: __sw_requireAuthUser('loginWithCookie', d) };
        },
        async signupWithCookie(req, email, password, opts) {
          const creds = __sw_cookieCreds('signupWithCookie', req, email, password, opts);
          let d;
          try { d = await this.signup(creds); }
          catch (err) { throw __sw_markExpected(err); }
          const access = d && (d.token || d.access_token);
          const refresh = d && d.refresh_token;
          if (access && refresh) __sw_setAuthCookies(access, refresh);
          return { user: __sw_requireAuthUser('signupWithCookie', d) };
        },
        // Completes the Google OAuth round-trip: reads ?code from the callback
        // request, exchanges it, sets the cookies, returns a 302 redirect.
        async googleCallbackWithCookie(req, redirectTo) {
          const u = new URL(req.url);
          const code = u.searchParams.get('code');
          if (!code) { const e = new Error('Missing ?code on the OAuth callback.'); e.code = 'VALIDATION_ERROR'; e.status = 400; e.__sw_expose = true; throw e; }
          let d;
          try { d = await this.googleExchange({ code: code, redirect_uri: u.origin + u.pathname }); }
          catch (err) { throw __sw_markExpected(err); }
          const access = d && (d.token || d.access_token);
          const refresh = d && d.refresh_token;
          if (access && refresh) __sw_setAuthCookies(access, refresh);
          return new Response(null, { status: 302, headers: { Location: redirectTo || '/' } });
        },
        githubCallbackWithCookie(req, redirectTo) {
          return socialOauthCallbackWithCookie('github', req, redirectTo);
        },
        discordCallbackWithCookie(req, redirectTo) {
          return socialOauthCallbackWithCookie('discord', req, redirectTo);
        },
        // Mint the httpOnly session cookies from an existing token pair —
        // the primitive the *WithCookie helpers wrap (tsk_1dd4e1b4). For
        // backends (e.g. @somewhere-tech/sdk/server, or its legacy auth shim) that already called
        // login / googleExchange / verifyOtp and want THAT session as
        // cookies without a second platform call.
        setSessionCookies(access, refresh) {
          if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
            const err = new Error('sw.auth.setSessionCookies: access and refresh must be non-empty strings');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          __sw_setAuthCookies(access, refresh);
        },
        // Park the Set-Cookie expirations that end a cookie session (the
        // clear half of setSessionCookies). logoutWithCookie does this AND
        // revokes server-side — prefer it when you have the Request.
        clearSessionCookies() {
          __sw_clearAuthCookies();
        },
        // Revokes the session server-side and clears the cookies.
        async logoutWithCookie(req) {
          const ch = (req && req.headers && (req.headers.get('cookie') || req.headers.get('Cookie'))) || '';
          __sw_expireLegacyAuthCookiesIfPresent(ch, req && req.url);
          const refresh = __sw_readCookie(ch, '__Host-sw_refresh_token') || __sw_readCookie(ch, '__Host-refresh_token');
          if (refresh) {
            try { await this.logout({ refresh_token: refresh }); } catch (_) {}
          }
          __sw_clearAuthCookies(req && req.url);
          return { ok: true };
        },

        // Magic-link / OTP sign-in (Supabase-shaped). Email-based,
        // single-use, 15-minute TTL. Auto-creates the user on first
        // sign-in. verifyOtp consumes the token and returns the same
        // shape login/signup produce.
        signInWithOtp(opts) {
          opts = opts || {};
          if (!opts.email) {
            const err = new Error('sw.auth.signInWithOtp: email is required');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          return platformJSON('/v1/auth/magic-link', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },
        verifyOtp(opts) {
          opts = opts || {};
          if (!opts.token) {
            const err = new Error('sw.auth.verifyOtp: token is required');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          return platformJSON('/v1/auth/magic-link/verify', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },

        // MFA / TOTP (Supabase-shaped). Two-step enrollment so a closed
        // tab mid-enrol doesn't lock the user out: enroll() stores the
        // secret, verify(code) flips mfa_enabled=1 and returns 8 single-
        // use backup codes (once). challenge() is the second-factor
        // call after password /login returned mfa_required:true.
        mfa: {
          // Begin enrolment. Caller must pass the user's JWT — MFA is
          // always tied to a logged-in account. Returns { secret,
          // otpauth_uri, issuer, account } — render otpauth_uri as a
          // QR code in the UI.
          enroll(opts) {
            opts = opts || {};
            if (!opts.token) {
              const err = new Error('sw.auth.mfa.enroll: token is required');
              err.code = 'VALIDATION_ERROR';
              throw err;
            }
            return platformJSON('/v1/auth/mfa/enroll', {
              method: 'POST',
              body: JSON.stringify({}),
              headers: {
                Authorization: 'Bearer ' + opts.token,
                // Cross-project binding (tsk_1c0eb7d9): reject a JWT minted by
                // another project, same as sw.auth.me / userTokenJSON.
                ...(projectId ? { 'X-Sw-Executing-Project': projectId } : {}),
              },
            });
          },
          // Confirm enrolment by submitting the first 6-digit code the
          // authenticator generates. Returns { enabled:true,
          // backup_codes:[...] } on first success; backup_codes is null
          // on a re-verify (existing codes are preserved).
          verify(opts) {
            opts = opts || {};
            if (!opts.token || !opts.code) {
              const err = new Error('sw.auth.mfa.verify: token and code are required');
              err.code = 'VALIDATION_ERROR';
              throw err;
            }
            return platformJSON('/v1/auth/mfa/verify', {
              method: 'POST',
              body: JSON.stringify({ code: opts.code }),
              headers: {
                Authorization: 'Bearer ' + opts.token,
                // Cross-project binding (tsk_1c0eb7d9): reject a JWT minted by
                // another project, same as sw.auth.me / userTokenJSON.
                ...(projectId ? { 'X-Sw-Executing-Project': projectId } : {}),
              },
            });
          },
          // Second-factor exchange after /login returned
          // { mfa_required:true, mfa_token }. Code is either the 6-digit
          // TOTP or a 10-char backup code. Returns the same shape as
          // /login on success.
          challenge(opts) {
            opts = opts || {};
            if (!opts.mfa_token || !opts.code) {
              const err = new Error('sw.auth.mfa.challenge: mfa_token and code are required');
              err.code = 'VALIDATION_ERROR';
              throw err;
            }
            return platformJSON('/v1/auth/mfa/challenge', {
              method: 'POST',
              body: JSON.stringify({
                project_id: projectId,
                mfa_token: opts.mfa_token,
                code: opts.code,
              }),
            });
          },
          // Disable MFA. Requires a fresh code (TOTP or backup) so a
          // stolen JWT alone can't turn it off.
          unenroll(opts) {
            opts = opts || {};
            if (!opts.token || !opts.code) {
              const err = new Error('sw.auth.mfa.unenroll: token and code are required');
              err.code = 'VALIDATION_ERROR';
              throw err;
            }
            return platformJSON('/v1/auth/mfa/unenroll', {
              method: 'POST',
              body: JSON.stringify({ code: opts.code }),
              headers: {
                Authorization: 'Bearer ' + opts.token,
                // Cross-project binding (tsk_1c0eb7d9): reject a JWT minted by
                // another project, same as sw.auth.me / userTokenJSON.
                ...(projectId ? { 'X-Sw-Executing-Project': projectId } : {}),
              },
            });
          },
        },

        // The historical sw.auth.admin surface stays removed: it implicitly
        // forwarded deploy-time authority and turned public handlers into
        // account-takeover primitives. In-app admins use the request-first
        // sw.auth.moderation surface below; operator tooling keeps using the
        // developer-authenticated control plane.
        admin: new Proxy({}, {
          get(_target, prop) {
            return () => {
              const err = new Error(
                'sw.auth.admin.' + String(prop) + ' is not available in the function runtime. ' +
                'Use sw.auth.moderation with the signed-in admin request for in-app moderation, ' +
                'or use developer-authenticated operator tooling outside the request handler.'
              );
              err.code = 'AUTH_ADMIN_REMOVED_FROM_RUNTIME';
              err.status = 403;
              throw __sw_markExpected(err);
            };
          },
        }),

        // Request-principal-gated in-app moderation. Unlike the historical
        // sw.auth.admin implementation, this surface never forwards the
        // deploy-time project key and never accepts an actor/user principal as
        // an argument. Every operation derives the actor from req and the
        // platform repeats authorization at the mutation chokepoint.
        moderation: Object.freeze({
          ban(req, userId, opts) {
            return moderationJSON(req, moderationUserPath(userId, '/ban'), {
              method: 'POST',
              body: JSON.stringify({ reason: opts && opts.reason !== undefined ? opts.reason : null }),
            });
          },
          unban(req, userId) {
            return moderationJSON(req, moderationUserPath(userId, '/unban'), {
              method: 'POST',
              body: JSON.stringify({}),
            });
          },
          deleteUser(req, userId) {
            return moderationJSON(req, moderationUserPath(userId), {
              method: 'DELETE',
            });
          },
          revokeSessions(req, userId) {
            return moderationJSON(req, moderationUserPath(userId, '/sessions'), {
              method: 'DELETE',
            });
          },
          setRole(req, userId, role) {
            if (role !== 'user' && role !== 'admin') {
              const err = new Error("sw.auth.moderation.setRole: role must be 'user' or 'admin'.");
              err.code = 'MODERATION_INVALID_ARGUMENT';
              err.status = 400;
              throw __sw_markExpected(err);
            }
            return moderationJSON(req, moderationUserPath(userId, '/role'), {
              method: 'PATCH',
              body: JSON.stringify({ role: role }),
            });
          },
        }),

        // Pull the end user out of the request in one call. Looks at
        // common cookie names (token, auth_token, session) first, then
        // the Authorization: Bearer header. Validates via sw.auth.me.
        // Returns the user object on success or null when no token is
        // present / the token is invalid / expired. Never throws — the
        // caller handles "no auth" with a single null check.
        //
        // Auto-refresh: when the request also carries an X-Refresh-Token
        // header (or refresh_token / sw_refresh_token cookie) and the
        // access token is expired, the platform mints a fresh pair and
        // we stash it into __sw_pendingRefresh; the function shim
        // attaches X-New-Access-Token / X-New-Refresh-Token to the
        // caller's response. Opt out with X-No-Auto-Refresh: 1.
        // Throwing variant of fromRequest — pulls the JWT from the
        // request, returns the user, or throws a 401 AUTH_REQUIRED error
        // if the request is unauthenticated. The thrown error is marked
        // with __sw_markExpected so BOTH dispatch paths surface it as a
        // real 401: the sw.endpoint wrapper reads e.status, and the bare
        // export-default routing shim's catch-all only returns a 4xx when
        // __sw_expose is set (otherwise it flattens every throw into an
        // opaque 500 FUNCTION_ERROR — which turned this expected auth
        // failure into a black-box 500 for the no-try/catch snippet below).
        // So a typical guarded handler is one line:
        //
        //   export default async (req, sw) => {
        //     const user = await sw.auth.requireUser(req);
        //     return Response.json({ id: user.id, email: user.email });
        //   };
        //
        // Optional second arg matches sw.auth.fromRequest's enrichment
        // shape so requireUser(req, { enrichFrom: 'members', fields: [...] })
        // returns the joined fields too. Add role:'admin' to require the
        // platform-owned app-user role in the same call. Role checks bypass
        // the short auth cache and read the role the resolver captured at
        // verification, BEFORE enrichment — a caller-supplied/enriched role
        // field is never authority.
        async requireUser(req, options) {
          const requiredRole = options && typeof options === 'object'
            ? options.role
            : undefined;
          if (requiredRole !== undefined && requiredRole !== 'admin') {
            const err = new Error('sw.auth.requireUser role currently supports admin.');
            err.code = 'VALIDATION_ERROR';
            err.status = 400;
            throw __sw_markExpected(err);
          }
          const authOptions = requiredRole
            ? __sw_assign({}, options, { __sw_noAuthCache: true })
            : options;
          const resolved = await __sw_resolveRequestUser(req, authOptions);
          if (!resolved) {
            const err = new Error('Sign in required.');
            err.code = 'AUTH_REQUIRED';
            err.status = 401;
            throw __sw_markExpected(err);
          }
          if (requiredRole && resolved.role !== requiredRole) {
            const err = new Error('Admin role required.');
            err.code = 'FORBIDDEN';
            err.status = 403;
            throw __sw_markExpected(err);
          }
          return resolved.user;
        },
        async requireRole(req, role, enrich) {
          const options = enrich && typeof enrich === 'object'
            ? __sw_assign({}, enrich, { role: role })
            : { role: role };
          return this.requireUser(req, options);
        },
        // fromRequest(req, enrich?) — resolves the signed-in user from
        // the request, optionally joining one row from a user-table the
        // dev maintains so every handler doesn't have to do a follow-up
        // SELECT. The enrich shape mirrors the Adapted Co feedback in
        // tsk_5c98f4f6:
        //
        //   const me = await sw.auth.fromRequest(req, {
        //     enrichFrom: 'members',
        //     fields: ['role', 'metadata'],   // optional, default '*'
        //     on: 'id',                       // optional, default 'id'
        //   });
        //   // me.id, me.email, me.role, me.metadata
        //
        // The join column on the user-table defaults to id and
        // matches the platform user's id. Set "on" to a different
        // column (e.g. user_id) when the dev's table doesn't use the
        // platform id as its primary key. Enrichment errors (missing
        // table, missing column) are swallowed — the base user is
        // returned without the extra fields and an error is logged.
        async fromRequest(req, enrich) {
          const resolved = await __sw_resolveRequestUser(req, enrich);
          return resolved ? resolved.user : null;
        },

        // Cookie-backed anonymous identity for pre-signup users.
        // Reads __Host-sw_anon_id from the request cookie if present; otherwise
        // mints a fresh uuid and returns a setCookie string the caller
        // attaches to its response. Use applyTo() to wrap a Response in
        // one line.
        anonSession(req) {
          let id = null;
          let isNew = false;
          if (req && req.headers && typeof req.headers.get === 'function') {
            const cookieHeader = req.headers.get('cookie') || req.headers.get('Cookie') || '';
            __sw_expireLegacyAuthCookiesIfPresent(cookieHeader, req.url);
            const existing = __sw_readCookie(
              cookieHeader,
              '__Host-sw_anon_id'
            );
            if (existing && /^anon_[a-zA-Z0-9_-]{8,}$/.test(existing)) {
              id = existing;
            }
          }
          if (!id) {
            id = 'anon_' + crypto.randomUUID().replace(/-/g, '');
            isNew = true;
          }
          // 1y, HttpOnly so JS can't read it, SameSite=Lax for normal
          // navigation, Secure so it only flies over HTTPS.
          const setCookie = isNew
            ? `__Host-sw_anon_id=${id}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
            : null;
          return {
            id,
            isAnon: true,
            setCookie,
            applyTo(response) {
              if (!setCookie) return response;
              const headers = new Headers(response.headers);
              headers.append('Set-Cookie', setCookie);
              return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
              });
            },
          };
        },

        // Move every row tagged with anonId over to userId on signup /
        // login. Auto-detects user-tables that have a user_id column
        // (skipping platform-managed _-prefixed tables and sqlite_*).
        // Pass tables: ['x', 'y'] to override the auto-detect.
        // Returns { migrated, tables }.
        async migrateAnon(opts) {
          // Snapshot every caller-controlled option before the first await.
          // Callers retain the opts object, so no value used after the
          // authoritative preflight may be read from it again.
          // Runtime v2 (tsk_327fe8a4): the DESTINATION is the request's verified
          // identity — never caller-supplied. A caller can only name the anon
          // SOURCE (validated below); it cannot claim which real user the anon
          // rows migrate onto. Fail-closed before any read or write.
          const { anonId, tables } = opts || {};
          const requestedTables = Array.isArray(tables) ? tables.slice() : null;
          if (!anonId) {
            const err = new Error('sw.auth.migrateAnon requires { anonId }');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          const userId = await __sw_requireSubject('sw.auth.migrateAnon');
          if (!DB) {
            const err = new Error('sw.auth.migrateAnon requires the project database. Call any sw.db.* method once first to provision it.');
            err.code = 'DB_NOT_PROVISIONED';
            throw err;
          }
          // Authoritative preflight before even inspecting the project schema:
          // a caller-supplied source that resolves to a real app user must
          // never reach the UPDATE loop. Legacy anonSession ids are cookie-only
          // anon_... and therefore intentionally have no app_users row.
          try {
            await platformJSON('/v1/auth/migrate-anon', {
              method: 'POST',
              body: JSON.stringify({
                project_id: projectId,
                anon_id: anonId,
              }),
            });
          } catch (err) {
            if (err && err.status >= 400 && err.status < 500) {
              throw __sw_markExpected(err);
            }
            throw err;
          }
          let tableList = requestedTables;
          if (!tableList) {
            const tablesQ = await DB.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'sqlite_%'"
            ).all();
            tableList = [];
            for (const row of (tablesQ.results || [])) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) continue;
              const cols = await DB.prepare('PRAGMA table_info("' + row.name.replace(/"/g, '""') + '")').all();
              if ((cols.results || []).some((c) => c.name === 'user_id')) {
                tableList.push(row.name);
              }
            }
          }
          let total = 0;
          for (const t of tableList) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) continue;
            const r = await DB.prepare(
              'UPDATE "' + t.replace(/"/g, '""') + '" SET user_id = ? WHERE user_id = ?'
            ).bind(userId, anonId).run();
            total += (r.meta && r.meta.changes) || 0;
          }
          return { migrated: total, tables: tableList };
        },
      };
      // Publish the identity spine into the context-head slots so surfaces
      // assembled before this namespace can resolve a verified principal
      // lazily. sw.db uses __sw_authResolveRequest (transport (a), request-
      // attached) for query-time scoping (tsk_5b91e0e4);
      // __sw_authVerifyPrincipal is the same spine under an intent-named handle
      // for Runtime v2 surfaces that also accept a forwarded token — transport
      // (b) — via opts.forwardedToken (tsk_327fe8a4). Both point at the one
      // resolver; there is no parallel derivation.
      __sw_authResolveRequest = __sw_resolveRequestUser;
      __sw_authVerifyPrincipal = __sw_resolveRequestUser;
      // Ambient visitor identity (tsk_99bec0b4; made reachable by tsk_11f8f791).
      // sw.db's owner() resolver calls this ONLY when there is no verified user
      // AND the project's baked owner-identity mode is 'visitor'. It reads
      // __Host-sw_anon_id from the FROZEN auth snapshot (the same source verified
      // identity is derived from, so customer code cannot spoof or downgrade it),
      // validates the format, and otherwise mints a fresh id AND queues the
      // Set-Cookie itself — there is no caller Response to attach it to on the
      // structured path. Never throws.
      //
      // What binds the owner predicate, exactly (the security claim):
      //  - ONE channel. The value is read from the __Host-sw_anon_id cookie on the
      //    frozen snapshot and nowhere else — no header, query param, body field,
      //    or sw.db argument can name a visitor. An id offered through any other
      //    channel is not read, so the request is simply a visitor with no cookie
      //    and the platform mints its own.
      //  - NEVER over a verified user. The caller reaches this only when identity
      //    resolution found no verified principal, so a cookie cannot downgrade or
      //    impersonate a signed-in user.
      //  - The anon_ prefix is mandatory, which is what keeps the visitor
      //    namespace disjoint from the app-user namespace: an id shaped like an
      //    app user's (a uuid) fails the test and is discarded, so a visitor
      //    cannot address a signed-in user's rows by naming their id.
      //  - Bounded (tsk_11f8f791): a conforming id is 37 chars; anything past 64
      //    is not ours and is discarded rather than written into an owner column.
      //  - Anything that fails the test is IGNORED, never repaired and never used:
      //    the platform mints a fresh id, so a malformed or hostile cookie yields
      //    a brand-new empty visitor, never a partial or borrowed one.
      // The conforming value itself is a bearer credential with the same standing
      // as a session cookie — HttpOnly, Secure, __Host-, 122 bits of entropy —
      // and is stated as such in the docs. Holding it IS being that visitor.
      __sw_resolveVisitorIdentity = function () {
        let id = null;
        try {
          const ch = __sw_authSnapshotRequest.headers.get('cookie');
          __sw_expireLegacyAuthCookiesIfPresent(ch, request && request.url);
          const existing = __sw_readCookie(ch, '__Host-sw_anon_id');
          if (existing && /^anon_[a-zA-Z0-9_-]{8,64}$/.test(existing)) id = existing;
        } catch (_) { /* fall through and mint */ }
        if (!id) {
          id = 'anon_' + crypto.randomUUID().replace(/-/g, '');
          try {
            // Same cookie shape sw.auth.anonSession sets — 1y, HttpOnly, Secure,
            // SameSite=Lax — so an app that also calls anonSession sees one id.
            __sw_pendingCookies.push('__Host-sw_anon_id=' + id + '; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax');
          } catch (_) { /* cannot persist: id is single-request; owner still holds within it */ }
        }
        return { id: id };
      };
      return __sw_auth;
    })(),

    jobs: {
      async create(opts) {
        return platformJSON('/v1/jobs', {
          method: 'POST',
          headers: await __sw_runtimeSubjectHeaders('X-Somewhere-Jobs-Authority', 'project_runtime'),
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      async status(jobId) {
        return platformJSON('/v1/jobs/' + jobId, {
          headers: await __sw_runtimeSubjectHeaders('X-Somewhere-Jobs-Authority', 'project_runtime'),
        });
      },
      async verifyInvocation(req) {
        const body = await req.clone().text();
        const source = req.headers.get('X-Somewhere-Invocation-Source') || req.headers.get('X-Somewhere-Source') || 'job';
        const invocationId = req.headers.get('X-Somewhere-Job-Id') || req.headers.get('X-Somewhere-Message-Id') || '';
        const timestamp = req.headers.get('X-Somewhere-Invocation-Timestamp') || '';
        const bodySha256 = req.headers.get('X-Somewhere-Body-SHA256') || '';
        const signature = req.headers.get('X-Somewhere-Signature') || '';
        try {
          const verified = await platformJSON('/v1/jobs/verify-invocation', {
            method: 'POST',
            body: JSON.stringify({
              project_id: projectId,
              source,
              invocation_id: invocationId,
              target_method: req.method,
              target_path: new URL(req.url).pathname,
              timestamp,
              body,
              body_sha256: bodySha256,
              signature,
            }),
          });
          return !!(verified && verified.valid);
        } catch (_) {
          return false;
        }
      },
    },

    queue: {
      push(opts) {
        return platformJSON('/v1/queue', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      async verifyInvocation(req) {
        return sw.jobs.verifyInvocation(req);
      },
    },

    logs: {
      async _send(level, message, data) {
        const response = await platformFetch('/v1/logs', {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, level, message, data, source: 'function' }),
        });
        if (!response.ok) {
          let body = null;
          try { body = await response.clone().json(); } catch (_) {}
          const err = new Error((body && body.message) || ('Log write failed: ' + response.status));
          err.code = (body && (body.code || body.error)) || 'LOG_WRITE_FAILED';
          err.status = response.status;
          if (body && body.retry_after_ms !== undefined) err.retry_after_ms = body.retry_after_ms;
          if (body && body.retry !== undefined) err.retry = body.retry;
          throw err;
        }
        return response;
      },
      debug(msg, data) { return this._send('debug', msg, data); },
      info(msg, data) { return this._send('info', msg, data); },
      warn(msg, data) { return this._send('warn', msg, data); },
      error(msg, data) { return this._send('error', msg, data); },
      // sw.logs.tail({ limit?, level?, since?, source?, search? }) — read this
      // project's OWN recent logs back, in one call, so a script can run an
      // action then read the logs it produced without a second round-trip
      // through the dashboard. Reads the same owner-scoped app_logs the
      // GET /v1/logs read path returns; the runtime key is pinned to this
      // project, so it can only ever see this project's logs. Both writes and
      // reads fail loudly: sw.logs.* resolves only after the platform durably
      // accepts the row into its queue (or direct fallback), and tail() throws
      // on read failure.
      //
      // Read consistency: log writes (sw.logs.* and platform internalLog) are
      // ingested through a durable queue that batch-inserts, so a line you just
      // wrote can lag a short window before tail() returns it (pfb
      // F-LOG-WRITE-READ-GAP). tail() reports only committed rows — it never
      // invents or waits on an un-ingested write. Poll briefly if you need
      // read-your-write.
      //
      //   since: epoch-ms number OR ISO-8601 string — returns logs at/after it.
      //   level: 'debug' | 'info' | 'warn' | 'error'.   source: filter by source.
      //   limit: default 50, capped at 500 by the read path.
      //   trace_id: return ONLY the lines written while handling ONE request.
      //             Pass sw.trace.id to read back this request's own lines, or
      //             the id from a report to read back someone else's. Every
      //             returned line also carries its own trace_id, so one noisy
      //             log leads straight to the request that produced it.
      // Returns an array of { id, level, message, data, source, created_at,
      // trace_id } (newest first).
      async tail(opts) {
        opts = opts || {};
        const qs = new URLSearchParams({ project_id: projectId });
        if (opts.limit != null) qs.set('limit', String(opts.limit));
        if (opts.level) qs.set('level', String(opts.level));
        if (opts.source) qs.set('source', String(opts.source));
        if (opts.search) qs.set('search', String(opts.search));
        if (opts.trace_id) qs.set('trace_id', String(opts.trace_id));
        if (opts.since != null) {
          qs.set('after', typeof opts.since === 'number' ? String(opts.since) : String(opts.since));
        }
        const d = await platformJSON('/v1/logs?' + qs.toString());
        return (d && d.logs) || [];
      },
      // sw.logs.trace(traceId) — the ORDERED PARENT/CHILD OPERATION TREE for
      // one request: what ran, in what order, how long each step took, which
      // step called which, and which one failed. One id in, the whole
      // waterfall out — no joining log lines by timestamp.
      //
      //   const t = await sw.logs.trace(sw.trace.id);
      //   t.waterfall  // flat, pre-order: read top-to-bottom = the request
      //                // in the order it happened. Each entry has
      //                // { name, depth, offset_ms, duration_ms, status }.
      //   t.tree                // the same spans, nested by parent
      //   t.slowest_operation   // what to fix first
      //   t.failed_operations   // what broke
      //
      // Omit the argument to read THIS request's own trace. Note a request's
      // own spans are written after its response flushes, so calling this on
      // your own in-flight id returns { found: false } — pass an id from an
      // EARLIER request (a log line, an error row, an X-Trace-Id header).
      // found:false always carries a reason string; an unstored trace never
      // looks the same as a wrong id.
      async trace(traceId) {
        const id = traceId || (sw.trace && sw.trace.id);
        if (!id) {
          const err = new Error('sw.logs.trace: a trace id is required (this request has none).');
          err.code = 'TRACE_ID_REQUIRED';
          throw err;
        }
        return platformJSON('/v1/traces/' + encodeURIComponent(String(id)) + '?project_id=' + encodeURIComponent(projectId));
      },
    },

    realtime: (function () {
      function __sw_realtimeHidden(op) {
        const err = new Error('sw.realtime.' + op + ' is not available in this runtime. Realtime is now driven by database changes — client subscriptions to db:<table> channels fire automatically on sw.db writes. Standalone customer channels are deferred; contact support if you need pub/sub or presence.');
        err.code = 'REALTIME_UNAVAILABLE';
        err.status = 400;
        return __sw_markExpected(err);
      }
      return {
        publish() { throw __sw_realtimeHidden('publish'); },
        subscribe() { throw __sw_realtimeHidden('subscribe'); },
        channels() { throw __sw_realtimeHidden('channels'); },
        broadcast() { throw __sw_realtimeHidden('broadcast'); },
        meta() { throw __sw_realtimeHidden('meta'); },
      };
    })(),

    analytics: {
      async track(event, opts) {
        opts = opts || {};
        // Event attribution is platform-derived. A verified app-user becomes
        // the event subject; server/background work has no subject and remains
        // project-level. Identity-looking fields in opts are not forwarded.
        const subject = await __sw_optionalSubject();
        return platformJSON('/v1/analytics/track', {
          method: 'POST',
          headers: subject ? { 'X-Somewhere-Acting-Subject': String(subject) } : {},
          body: JSON.stringify({
            project_id: projectId,
            event,
            properties: opts.properties,
            page: opts.page,
            referrer: opts.referrer,
            user_agent: opts.user_agent,
          }),
        });
      },
      query(opts) {
        opts = opts || {};
        return platformJSON('/v1/analytics/query', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
    },

    // sw.render.{screenshot,pdf} — when storage opt is set, returns a
    // JSON envelope { storage_path, size_bytes, content_type }; without
    // storage, returns the raw fetch Response so callers can stream
    // the binary out (e.g. to the browser).
    render: {
      async screenshot(opts) {
        opts = opts || {};
        const body = JSON.stringify({ ...opts, project_id: projectId });
        if (opts.storage) {
          return platformJSON('/v1/render/screenshot', { method: 'POST', body });
        }
        const r = await platformFetch('/v1/render/screenshot', { method: 'POST', body });
        if (!r.ok) {
          let msg = 'screenshot failed: ' + r.status;
          let code;
          try { const j = await r.json(); if (j && j.error) code = j.error; if (j && j.message) msg = j.message; } catch { /* noop */ }
          // 402 INSUFFICIENT_BALANCE is end-user-triggerable — keep the
          // real code/status for logging but neutralize the message.
          if (r.status === 402 && code === 'INSUFFICIENT_BALANCE') {
            msg = 'This feature is temporarily unavailable. Please try again later.';
          }
          const err = new Error(msg); if (code) err.code = code; err.status = r.status; throw err;
        }
        return r;
      },
      async pdf(opts) {
        opts = opts || {};
        const body = JSON.stringify({ ...opts, project_id: projectId });
        if (opts.storage) {
          return platformJSON('/v1/render/pdf', { method: 'POST', body });
        }
        const r = await platformFetch('/v1/render/pdf', { method: 'POST', body });
        if (!r.ok) {
          let msg = 'pdf failed: ' + r.status;
          let code;
          try { const j = await r.json(); if (j && j.error) code = j.error; if (j && j.message) msg = j.message; } catch { /* noop */ }
          // 402 INSUFFICIENT_BALANCE is end-user-triggerable — keep the
          // real code/status for logging but neutralize the message.
          if (r.status === 402 && code === 'INSUFFICIENT_BALANCE') {
            msg = 'This feature is temporarily unavailable. Please try again later.';
          }
          const err = new Error(msg); if (code) err.code = code; err.status = r.status; throw err;
        }
        return r;
      },
    },

    search: {
      async add(path) {
        const userId = await __sw_requireSubject('sw.search.add');
        return platformJSON('/v1/search/managed/add', {
          method: 'POST',
          headers: { 'X-Sw-Verified-Subject': userId },
          body: JSON.stringify({ project_id: projectId, path }),
        });
      },
      createIndex(name) {
        return platformJSON('/v1/search/index', {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, name }),
        });
      },
      listIndexes() {
        return platformJSON('/v1/search/index?project_id=' + encodeURIComponent(projectId));
      },
      deleteIndex(name) {
        return platformJSON('/v1/search/index/' + encodeURIComponent(name) + '?project_id=' + encodeURIComponent(projectId), { method: 'DELETE' });
      },
      upsert(opts) {
        return platformJSON('/v1/search/upsert', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      query(opts) {
        if (typeof opts === 'string') {
          return __sw_requireSubject('sw.search.query').then((userId) => platformJSON('/v1/search/managed/query', {
            method: 'POST',
            headers: { 'X-Sw-Verified-Subject': userId },
            body: JSON.stringify({ project_id: projectId, query: opts }),
          }));
        }
        return platformJSON('/v1/search/query', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      remove(opts) {
        return platformJSON('/v1/search/remove', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
    },

    video: {
      uploadUrl(opts) {
        opts = opts || {};
        return platformJSON('/v1/video/upload-url', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      list(opts) {
        opts = opts || {};
        const qs = '?project_id=' + encodeURIComponent(projectId) + (opts.limit ? '&limit=' + Number(opts.limit) : '');
        return platformJSON('/v1/video' + qs);
      },
      get(id) {
        return platformJSON('/v1/video/' + encodeURIComponent(id));
      },
      delete(id) {
        return platformJSON('/v1/video/' + encodeURIComponent(id), { method: 'DELETE' });
      },
    },

    inbox: (function () {
      const __sw_inboxIdentityKeys = new Set([
        'as_user', 'asUser', 'user_id', 'userId', 'owner',
        'owner_id', 'owner_subject_id', 'owner_subject_type',
        'subject_id', 'subject_type',
      ]);
      function __sw_inboxCleanOpts(opts) {
        const clean = {};
        if (!opts || typeof opts !== 'object') return clean;
        for (const key of Object.keys(opts)) {
          if (!__sw_inboxIdentityKeys.has(key)) clean[key] = opts[key];
        }
        return clean;
      }
      function __sw_makeInbox(projectMode) {
        async function requestAuthority() {
          const projectAuthority = projectMode || __sw_hasRuntimeProjectAuthority();
          const authorityHeaders = await __sw_runtimeSubjectHeaders(
            'X-Somewhere-Inbox-Authority',
            projectAuthority ? 'project_runtime' : 'unauthenticated',
            projectMode,
          );
          return {
            subject: authorityHeaders['X-Somewhere-Acting-Subject'] || null,
            headers: authorityHeaders,
          };
        }
        async function headers() {
          return (await requestAuthority()).headers;
        }
        return {
          async listAddresses() {
            return platformJSON('/v1/inbox/addresses?project_id=' + encodeURIComponent(projectId), { headers: await headers() });
          },
          async createAddress(opts) {
            opts = __sw_inboxCleanOpts(opts);
            const authority = await requestAuthority();
            // Preserve the API's mailbox kind. The authority header above, not
            // credential absence, decides whether this is an app-user write,
            // an explicit project-runtime write, or an unauthenticated request.
            // The route rejects the last case; it never silently changes an app
            // mailbox into an admin mailbox.
            const body = { ...opts, kind: projectMode ? 'admin' : 'app', project_id: projectId };
            return platformJSON('/v1/inbox/addresses', {
              method: 'POST',
              headers: authority.headers,
              body: JSON.stringify(body),
            });
          },
          async listAppAddresses() {
            return platformJSON('/v1/inbox/addresses?kind=app&project_id=' + encodeURIComponent(projectId), { headers: await headers() });
          },
          async deleteAddress(id) {
            return platformJSON('/v1/inbox/addresses/' + encodeURIComponent(id), { method: 'DELETE', headers: await headers() });
          },
          async list(opts) {
            opts = __sw_inboxCleanOpts(opts);
            const params = ['project_id=' + encodeURIComponent(projectId)];
            if (opts.address_id) params.push('address_id=' + encodeURIComponent(opts.address_id));
            if (opts.limit) params.push('limit=' + Number(opts.limit));
            if (opts.unread) params.push('unread=1');
            if (opts.q) params.push('q=' + encodeURIComponent(String(opts.q)));
            if (opts.include_spam) params.push('include_spam=1');
            return platformJSON('/v1/inbox?' + params.join('&'), { headers: await headers() });
          },
          async get(id, opts) {
            opts = __sw_inboxCleanOpts(opts);
            const qs = opts.include_html ? '?include=html' : '';
            return platformJSON('/v1/inbox/' + encodeURIComponent(id) + qs, { headers: await headers() });
          },
          // Returns a Response — caller can stream/redirect/serve. The response
          // carries X-Somewhere-Ownership-Status because bytes have no JSON body.
          async raw(id) {
            return platformFetch('/v1/inbox/' + encodeURIComponent(id) + '/raw', { headers: await headers() });
          },
          async attachment(id, idx) {
            return platformFetch('/v1/inbox/' + encodeURIComponent(id) + '/attachments/' + Number(idx), { headers: await headers() });
          },
          async markRead(id, read) {
            const body = read === false ? { read: false } : { read: true };
            return platformJSON('/v1/inbox/' + encodeURIComponent(id) + '/read', {
              method: 'POST', headers: await headers(), body: JSON.stringify(body),
            });
          },
          async delete(id) {
            return platformJSON('/v1/inbox/' + encodeURIComponent(id), { method: 'DELETE', headers: await headers() });
          },
          async reply(id, opts) {
            opts = __sw_inboxCleanOpts(opts);
            return platformJSON('/v1/inbox/' + encodeURIComponent(id) + '/reply', {
              method: 'POST', headers: await headers(), body: JSON.stringify(opts),
            });
          },
          async send(addressId, opts) {
            opts = __sw_inboxCleanOpts(opts);
            return platformJSON('/v1/inbox/addresses/' + encodeURIComponent(addressId) + '/send', {
              method: 'POST', headers: await headers(), body: JSON.stringify(opts),
            });
          },
          async threads(opts) {
            opts = __sw_inboxCleanOpts(opts);
            const params = ['project_id=' + encodeURIComponent(projectId)];
            if (opts.address_id) params.push('address_id=' + encodeURIComponent(opts.address_id));
            if (opts.limit) params.push('limit=' + Number(opts.limit));
            if (opts.include_spam) params.push('include_spam=1');
            return platformJSON('/v1/inbox/threads?' + params.join('&'), { headers: await headers() });
          },
          async thread(root) {
            return platformJSON('/v1/inbox/threads/by-root?project_id=' +
              encodeURIComponent(projectId) + '&root=' + encodeURIComponent(root), { headers: await headers() });
          },
          rules: {
            async list(opts) {
              opts = __sw_inboxCleanOpts(opts);
              const params = ['project_id=' + encodeURIComponent(projectId)];
              if (opts.address_id) params.push('address_id=' + encodeURIComponent(opts.address_id));
              return platformJSON('/v1/inbox/rules?' + params.join('&'), { headers: await headers() });
            },
            async create(opts) {
              opts = __sw_inboxCleanOpts(opts);
              return platformJSON('/v1/inbox/rules', {
                method: 'POST', headers: await headers(),
                body: JSON.stringify({ ...opts, project_id: projectId }),
              });
            },
            async delete(id) {
              return platformJSON('/v1/inbox/rules/' + encodeURIComponent(id), { method: 'DELETE', headers: await headers() });
            },
          },
        };
      }

      // A verified app-user request is subject-scoped. A request with no
      // verified principal is explicitly labelled unauthenticated; omission is
      // never interpreted as project authority. Server code that deliberately
      // needs project scope uses sw.inbox.project below.
      const userInbox = __sw_makeInbox(false);
      // Deliberate trusted cross-user/admin path. It never impersonates a user,
      // and app mail creation is unavailable here (createAddress forces admin).
      const projectInbox = __sw_makeInbox(true);
      projectInbox.assignLegacyOwner = function (addressId, appUserId) {
        return platformJSON('/v1/inbox/addresses/' + encodeURIComponent(addressId) + '/ownership', {
          method: 'POST',
          headers: { 'X-Somewhere-Inbox-Authority': 'project_runtime' },
          body: JSON.stringify({ app_user_id: String(appUserId) }),
        });
      };
      projectInbox.grants = {
        list(addressId) {
          return platformJSON('/v1/inbox/addresses/' + encodeURIComponent(addressId) + '/grants', {
            headers: { 'X-Somewhere-Inbox-Authority': 'project_runtime' },
          });
        },
        set(addressId, collaboratorUserId, role) {
          return platformJSON('/v1/inbox/addresses/' + encodeURIComponent(addressId) + '/grants', {
            method: 'POST',
            headers: { 'X-Somewhere-Inbox-Authority': 'project_runtime' },
            body: JSON.stringify({ collaborator_user_id: String(collaboratorUserId), role: role }),
          });
        },
        delete(addressId, collaboratorUserId) {
          return platformJSON('/v1/inbox/addresses/' + encodeURIComponent(addressId) + '/grants/' + encodeURIComponent(collaboratorUserId), {
            method: 'DELETE',
            headers: { 'X-Somewhere-Inbox-Authority': 'project_runtime' },
          });
        },
      };
      userInbox.project = projectInbox;
      return userInbox;
    })(),

    // sw.connect.* — read-side third-party connections (tsk_1b20).
    // Opposite of sw.payments: read another account's data, don't accept money.
    connect: {
      stripe: {
        // Returns { url } — send the creator's browser there to authorize
        // read-only access to their existing Stripe. opts.return_url is where
        // Stripe bounces them back (gets ?connect=success|error appended).
        connect(opts) {
          opts = opts || {};
          return platformJSON('/v1/connect/stripe/connect', {
            method: 'POST',
            body: JSON.stringify({ project_id: projectId, return_url: opts.return_url || opts.returnUrl }),
          });
        },
        // { connected, account_id, scope, status, sync_error, connected_at, updated_at }
        // status is `syncing` until the initial subscriber cache is durable,
        // and `error` when the cache is stale/failed; subscribers() fails loud
        // in either state instead of returning a misleading empty list.
        status() {
          return platformJSON('/v1/connect/stripe/status?project_id=' + encodeURIComponent(projectId));
        },
        // { data: [{ email, tier, status, current_period_end, ... }], next_cursor,
        //   sync_status: 'connected', updated_at }
        // Reads the platform-cached list (kept fresh by the Connect webhook).
        subscribers(opts) {
          opts = opts || {};
          const params = new URLSearchParams({ project_id: projectId });
          if (opts.status) params.set('status', opts.status);
          if (opts.limit) params.set('limit', String(opts.limit));
          if (opts.cursor) params.set('cursor', opts.cursor);
          return platformJSON('/v1/connect/stripe/subscribers?' + params.toString());
        },
        disconnect() {
          return platformJSON('/v1/connect/stripe/disconnect', {
            method: 'POST',
            body: JSON.stringify({ project_id: projectId }),
          });
        },
      },
    },

    async quote(resource, range, opts) {
      opts = opts || {};
      const env = opts.env || projectEnv;
      const subject = await __sw_optionalSubject();
      const booking = { ...(opts.booking || {}) };
      if (subject) {
        delete booking.app_user_id;
        delete booking.appUserId;
        booking.app_user_id = String(subject);
      }
      return platformJSON('/v1/payments/quote', {
        method: 'POST',
        headers: subject ? { 'X-Somewhere-Acting-Subject': String(subject) } : {},
        body: JSON.stringify({ ...opts, project_id: projectId, env, resource, range, booking }),
      });
    },
    payments: {
      onboard(opts) {
        opts = opts || {};
        return platformJSON('/v1/payments/onboard', {
          method: 'POST',
          body: JSON.stringify(opts),
        });
      },
      async quote(resource, range, opts) {
        opts = opts || {};
        const env = opts.env || projectEnv;
        const subject = await __sw_optionalSubject();
        const booking = { ...(opts.booking || {}) };
        if (subject) {
          delete booking.app_user_id;
          delete booking.appUserId;
          booking.app_user_id = String(subject);
        }
        return platformJSON('/v1/payments/quote', {
          method: 'POST',
          headers: subject ? { 'X-Somewhere-Acting-Subject': String(subject) } : {},
          body: JSON.stringify({ ...opts, project_id: projectId, env, resource, range, booking }),
        });
      },
      status(opts) {
        opts = opts || {};
        return platformJSON('/v1/payments/status' + (opts.refresh ? '?refresh=1' : ''));
      },
      checkout(opts) {
        opts = opts || {};
        const env = opts.env || projectEnv;
        return platformJSON('/v1/payments/checkout', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId, env }),
        });
      },
      // checkoutForUser(opts) — Runtime v2 (tsk_327fe8a4): the app_user is
      // DERIVED from the request's verified principal, never a caller-passed id
      // (which could bind a checkout to another user's account). Fail-closed.
      // The merchant checkout() above stays a service op on the same route.
      async checkoutForUser(opts) {
        opts = opts || {};
        if (!opts.plan) {
          const err = new Error('sw.payments.checkoutForUser: opts.plan is required');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        const userId = await __sw_requireSubject('sw.payments.checkoutForUser');
        const metadata = { ...(opts.metadata || {}) };
        delete metadata.app_user_id;
        delete metadata.somewhere_app_user_id;
        metadata.app_user_id = String(userId);
        metadata.plan = String(opts.plan);
        const body = { ...opts, metadata };
        delete body.plan;
        return this.checkout(body);
      },
      dashboardLink() {
        return platformJSON('/v1/payments/dashboard-link');
      },
      refund(opts) {
        opts = opts || {};
        const env = opts.env || projectEnv;
        return platformJSON('/v1/payments/refund', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId, env }),
        });
      },
      cancelSubscription(opts) {
        opts = opts || {};
        const env = opts.env || projectEnv;
        return platformJSON('/v1/payments/cancel-subscription', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId, env }),
        });
      },
      transactions(opts) {
        opts = opts || {};
        const env = opts.env || projectEnv;
        const params = new URLSearchParams({ project_id: projectId, env });
        if (opts.limit) params.set('limit', String(opts.limit));
        if (opts.starting_after || opts.startingAfter) {
          params.set('starting_after', opts.starting_after || opts.startingAfter);
        }
        return platformJSON('/v1/payments/transactions?' + params.toString());
      },
      portal(opts) {
        opts = opts || {};
        const env = opts.env || projectEnv;
        return platformJSON('/v1/payments/portal', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            env,
            customer_id: opts.customer_id || opts.customerId,
            return_url: opts.return_url || opts.returnUrl,
          }),
        });
      },
      // portalForUser(opts) — Runtime v2: the app_user is DERIVED from the
      // request's verified principal, never caller-supplied. Fail-closed. The
      // merchant portal() above (customer_id) stays a service op.
      async portalForUser(opts) {
        opts = opts || {};
        const userId = await __sw_requireSubject('sw.payments.portalForUser');
        const env = opts.env || projectEnv;
        return platformJSON('/v1/payments/portal', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            env,
            app_user_id: String(userId),
            return_url: opts.return_url || opts.returnUrl,
          }),
        });
      },
      events(opts) {
        opts = opts || {};
        const params = new URLSearchParams({ project_id: projectId });
        if (opts.limit) params.set('limit', String(opts.limit));
        if (opts.before) params.set('before', String(opts.before));
        if (opts.type) params.set('type', opts.type);
        return platformJSON('/v1/payments/events?' + params.toString());
      },
    },

    billing: {
      definePlans(plans) {
        if (!Array.isArray(plans)) {
          const err = new Error('sw.billing.definePlans: plans must be an array of { slug, name, features }');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        return platformJSON('/v1/entitlements/plans', {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, plans: plans }),
        });
      },
      plans() {
        return platformJSON('/v1/entitlements/plans?project_id=' + encodeURIComponent(projectId));
      },
      // has(feature) — Runtime v2: the subject is DERIVED from the request's
      // verified principal (tsk_327fe8a4), never a caller-passed id. Checking
      // another user's entitlements is a server concern (raw /v1/entitlements),
      // not this end-user gate.
      async has(feature) {
        if (!feature) {
          const err = new Error('sw.billing.has: feature is required');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        const userId = await __sw_requireSubject('sw.billing.has');
        const r = await platformJSON(
          '/v1/entitlements/has?feature=' + encodeURIComponent(feature) +
          '&user_id=' + encodeURIComponent(userId)
        );
        return !!(r && r.has === true);
      },
      async entitlements() {
        const userId = await __sw_requireSubject('sw.billing.entitlements');
        return platformJSON('/v1/entitlements/me?user_id=' + encodeURIComponent(userId));
      },
    },

    calls: {
      newSession(opts) {
        opts = opts || {};
        return platformJSON('/v1/calls/sessions', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
    },

    tasks: {
      // sw.tasks.create({ title, description?, status?, priority?, assignee?, labels?, due_at?, area?, parent_id? })
      create(opts) {
        opts = opts || {};
        return platformJSON('/v1/tasks', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      // sw.tasks.list({ status?, assignee?, area?, parent_id?, limit? })
      // Pass parent_id: 'null' to fetch only top-level tasks (no parent).
      list(opts) {
        opts = opts || {};
        const q = new URLSearchParams({ project_id: projectId });
        if (opts.status) q.set('status', opts.status);
        if (opts.assignee) q.set('assignee', opts.assignee);
        if (opts.area) q.set('area', opts.area);
        if (opts.parent_id !== undefined && opts.parent_id !== null) q.set('parent_id', String(opts.parent_id));
        if (opts.limit) q.set('limit', String(opts.limit));
        return platformJSON('/v1/tasks?' + q.toString());
      },
      // sw.tasks.get(id) → { ...task, comments: [...] }
      get(id) {
        return platformJSON('/v1/tasks/' + encodeURIComponent(id) + '?project_id=' + encodeURIComponent(projectId));
      },
      // sw.tasks.update(id, { title?, description?, status?, priority?, assignee?, labels?, due_at?, area?, parent_id? })
      update(id, opts) {
        return platformJSON('/v1/tasks/' + encodeURIComponent(id), {
          method: 'PATCH',
          body: JSON.stringify({ ...(opts || {}), project_id: projectId }),
        });
      },
      // sw.tasks.delete(id)
      delete(id) {
        return platformJSON('/v1/tasks/' + encodeURIComponent(id) + '?project_id=' + encodeURIComponent(projectId), { method: 'DELETE' });
      },
      // sw.tasks.comment(id, body, author?)
      comment(id, body, author) {
        return platformJSON('/v1/tasks/' + encodeURIComponent(id) + '/comments', {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, body: body, ...(author ? { author: author } : {}) }),
        });
      },
      // sw.tasks.settings.get() / sw.tasks.settings.update({ webhook_url?, notify_email? })
      // — webhook_secret is returned exactly once when first set; store it
      // server-side to verify the X-Somewhere-Signature header on incoming
      // task webhook POSTs.
      settings: {
        get() {
          return platformJSON('/v1/tasks/settings?project_id=' + encodeURIComponent(projectId));
        },
        update(opts) {
          return platformJSON('/v1/tasks/settings', {
            method: 'PATCH',
            body: JSON.stringify({ project_id: projectId, ...opts }),
          });
        },
      },
    },

    cron: {
      create(opts) {
        return platformJSON('/v1/cron', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      list() {
        return platformJSON('/v1/cron?project_id=' + encodeURIComponent(projectId));
      },
      update(id, opts) {
        return platformJSON('/v1/cron/' + encodeURIComponent(id), {
          method: 'PATCH',
          body: JSON.stringify(opts || {}),
        });
      },
      delete(id) {
        return platformJSON('/v1/cron/' + encodeURIComponent(id), { method: 'DELETE' });
      },
    },

    calendar: {
      hold(resourceOrOpts, range, ttl) {
        const body = (resourceOrOpts && typeof resourceOrOpts === 'object' && range === undefined)
          ? { ...resourceOrOpts }
          : { resource: resourceOrOpts, range, ttl };
        return platformJSON('/v1/calendar/hold', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      blackout(resourceOrOpts, range, opts) {
        const body = (resourceOrOpts && typeof resourceOrOpts === 'object' && range === undefined)
          ? { ...resourceOrOpts }
          : { ...(opts || {}), resource: resourceOrOpts, range };
        return platformJSON('/v1/calendar/blackout', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      removeBlackout(idOrOpts, opts) {
        const body = typeof idOrOpts === 'string'
          ? { ...(opts || {}), reservation_id: idOrOpts }
          : { ...(idOrOpts || {}) };
        return platformJSON('/v1/calendar/blackout/remove', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      cancel(idOrOpts, opts) {
        // Paid cancellations expose reservation.cancellation_status as
        // `refund_pending`, `refund_succeeded`, `refund_failed`, or
        // `refund_unknown`, plus cancellation_refund_intent_id/error. The
        // reservation leaves active state before money moves; retry the same
        // cancel call to reconcile a pending/unknown durable refund intent.
        const body = typeof idOrOpts === 'string'
          ? { ...(opts || {}), reservation_id: idOrOpts }
          : { ...(idOrOpts || {}) };
        return platformJSON('/v1/calendar/cancel', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      rebook(idOrOpts, newRange) {
        const body = typeof idOrOpts === 'string'
          ? { reservation_id: idOrOpts, new_range: newRange }
          : { ...(idOrOpts || {}) };
        return platformJSON('/v1/calendar/rebook', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      setPolicy(resourceOrOpts, policy) {
        const body = (resourceOrOpts && typeof resourceOrOpts === 'object' && policy === undefined)
          ? { ...resourceOrOpts }
          : { resource: resourceOrOpts, policy };
        return platformJSON('/v1/calendar/policy/set', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      getPolicy(resourceOrOpts) {
        const body = typeof resourceOrOpts === 'string'
          ? { resource: resourceOrOpts }
          : { ...(resourceOrOpts || {}) };
        return platformJSON('/v1/calendar/policy/get', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      availability(resourceOrOpts, range) {
        const body = (resourceOrOpts && typeof resourceOrOpts === 'object' && range === undefined)
          ? { ...resourceOrOpts }
          : { resource: resourceOrOpts, range };
        return platformJSON('/v1/calendar/availability', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      list(resourceOrOpts, opts) {
        const body = (resourceOrOpts && typeof resourceOrOpts === 'object' && opts === undefined)
          ? { ...resourceOrOpts }
          : { ...(opts || {}), resource: resourceOrOpts };
        return platformJSON('/v1/calendar/list', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      get(idOrOpts) {
        const body = typeof idOrOpts === 'string'
          ? { reservation_id: idOrOpts }
          : { ...(idOrOpts || {}) };
        return platformJSON('/v1/calendar/get', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      pending(tokenOrOpts, opts) {
        const body = typeof tokenOrOpts === 'string'
          ? { ...(opts || {}), token: tokenOrOpts }
          : { ...(tokenOrOpts || {}) };
        return platformJSON('/v1/calendar/pending', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      confirm(tokenOrOpts, opts) {
        const body = typeof tokenOrOpts === 'string'
          ? { ...(opts || {}), token: tokenOrOpts }
          : { ...(tokenOrOpts || {}) };
        return platformJSON('/v1/calendar/confirm', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      release(tokenOrOpts, opts) {
        const body = typeof tokenOrOpts === 'string'
          ? { ...(opts || {}), token: tokenOrOpts }
          : { ...(tokenOrOpts || {}) };
        return platformJSON('/v1/calendar/release', {
          method: 'POST',
          body: JSON.stringify({ ...body, project_id: projectId }),
        });
      },
      expire(opts) {
        opts = opts || {};
        return platformJSON('/v1/calendar/expire', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
    },

    rateLimit: {
      // sw.rateLimit.check(key, max, windowSeconds) → { allowed, remaining, reset, ... }
      // Fixed-window counter, scoped per (project, key). On allowed=false the
      // caller should return 429.
      async check(key, max, windowSeconds) {
        try {
          return await platformJSON('/v1/rate-limit/check', {
            method: 'POST',
            body: JSON.stringify({
              project_id: projectId,
              key,
              max,
              window_seconds: windowSeconds,
            }),
          });
        } catch (e) {
          if (e && e.status === 429 && e.code === 'RATE_LIMIT_KEY_CARDINALITY_EXCEEDED') {
            const retryAfter = Math.max(1, Math.ceil(((e.retry_after_ms || 0) / 1000) || windowSeconds || 60));
            return {
              allowed: false,
              remaining: 0,
              reset: Math.floor(Date.now() / 1000) + retryAfter,
              limit: max,
              window_seconds: windowSeconds,
              retry_after: retryAfter,
              error: e.code,
              message: e.message,
            };
          }
          throw e;
        }
      },
    },

    web: {
      // sw.web.scrape(url, opts?) — fetch a URL, return its content as
      // markdown by default. opts: { formats?, only_main?, wait_for? }
      scrape(url, opts) {
        opts = opts || {};
        return platformJSON('/v1/web/scrape', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            url,
            ...(opts.formats !== undefined ? { formats: opts.formats } : {}),
            ...(opts.only_main !== undefined ? { only_main: opts.only_main } : {}),
            ...(opts.wait_for !== undefined ? { wait_for: opts.wait_for } : {}),
          }),
        });
      },
      // sw.web.search(query, opts?) — search the public web by keyword.
      // Returns { query, results: [{ url, title, description, age, source }], count }
      // opts: { count?, country?, freshness?, safesearch? }
      search(query, opts) {
        opts = opts || {};
        return platformJSON('/v1/web/search', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            query,
            ...(opts.count !== undefined ? { count: opts.count } : {}),
            ...(opts.country !== undefined ? { country: opts.country } : {}),
            ...(opts.freshness !== undefined ? { freshness: opts.freshness } : {}),
            ...(opts.safesearch !== undefined ? { safesearch: opts.safesearch } : {}),
          }),
        });
      },
    },

    // sw.notifications — unified notify primitive (tsk_594eddbf).
    // Fans out across the channels the app uses: push (sw.push), the
    // app's own in-app bell (a _notifications table in the project DB,
    // auto-created on first use), and optionally email when the dev
    // passes an explicit email address. Safe to call from an LLM tool
    // — write your own dedup if you need it; this layer is the
    // primitive, not the policy.
    notifications: (function () {
      // Direct DB binding for the bell store (tsk_5d490a39). Each IIFE binds
      // its own copy — mirrors ai.ts / auth.ts — because fragments are
      // separate closures; without this every bell method ReferenceErrors.
      const DB = env.PROJECT_DB;
      const TABLE_SQL = "CREATE TABLE IF NOT EXISTS _notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, body TEXT, url TEXT, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_notifications_user ON _notifications(user_id, created_at DESC);";
      let ensured = false;
      function requireDB(method) {
        if (!DB || typeof DB.prepare !== 'function') {
          const err = new Error('sw.notifications.' + method + ': sw.db is not attached to this deploy. Call any sw.db.* method once first to provision the database, then redeploy.');
          err.code = 'DB_NOT_PROVISIONED';
          throw err;
        }
      }
      async function ensureTable() {
        if (ensured) return;
        if (!DB || typeof DB.exec !== 'function') return;
        try { await DB.exec(TABLE_SQL); ensured = true; } catch (err) {
          // exec doesn't support multi-statement on some D1 versions;
          // try one at a time.
          try {
            await DB.prepare("CREATE TABLE IF NOT EXISTS _notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, body TEXT, url TEXT, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)").run();
            await DB.prepare("CREATE INDEX IF NOT EXISTS idx_notifications_user ON _notifications(user_id, created_at DESC)").run();
            ensured = true;
          } catch (e2) {
            console.error('sw.notifications: ensureTable failed:', e2 && e2.message ? e2.message : e2);
          }
        }
      }

      return {
        // send(userId, { title, body?, url?, email?, channels? }) →
        // { bell?, push?, email? } with per-channel result or error.
        // channels defaults to ['bell','push']. Pass channels:['email']
        // (with email:'addr') to send only email, etc.
        async send(userId, opts) {
          opts = opts || {};
          if (!userId) {
            const err = new Error('sw.notifications.send: userId is required'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          const title = opts.title || '';
          const body = opts.body || '';
          const url = opts.url || null;
          const channels = Array.isArray(opts.channels) && opts.channels.length > 0
            ? opts.channels
            : ['bell', 'push'];
          const results = {};

          if (channels.includes('bell')) {
            try {
              requireDB('send');
              await ensureTable();
              const id = 'ntf_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
              await DB.prepare(
                'INSERT INTO _notifications (id, user_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
              ).bind(id, String(userId), title, body, url, Date.now()).run();
              results.bell = { id, ok: true };
            } catch (err) {
              results.bell = { ok: false, error: err && err.message ? err.message : 'bell write failed', code: err && err.code };
            }
          }

          if (channels.includes('push')) {
            try {
              const r = await platformJSON('/v1/push/send', {
                method: 'POST',
                body: JSON.stringify({
                  project_id: projectId,
                  payload: { title, body, url },
                  user_id: String(userId),
                }),
              });
              results.push = { ok: true, ...r };
            } catch (err) {
              results.push = { ok: false, error: err && err.message ? err.message : 'push send failed', code: err && err.code };
            }
          }

          if (channels.includes('email')) {
            if (!opts.email || typeof opts.email !== 'string') {
              results.email = { ok: false, error: "email channel requires opts.email (address). The user-table lookup is the dev's call — see sw.auth.fromRequest({ enrichFrom })." };
            } else {
              try {
                const r = await platformJSON('/v1/email/send', {
                  method: 'POST',
                  body: JSON.stringify({
                    project_id: projectId,
                    to: opts.email,
                    subject: title,
                    html: body || '',
                    ...(opts.from ? { from: opts.from } : {}),
                  }),
                });
                results.email = { ok: true, ...r };
              } catch (err) {
                results.email = { ok: false, error: err && err.message ? err.message : 'email send failed', code: err && err.code };
              }
            }
          }

          return results;
        },

        // Bell-only SELF-SERVICE helpers (Runtime v2, tsk_327fe8a4): the
        // recipient is DERIVED from the request's verified principal, never a
        // caller-passed id. No verified user fails closed (AUTH_REQUIRED) —
        // never a silent empty result that could mask a missing session.
        async list(opts) {
          opts = opts || {};
          const userId = await __sw_requireSubject('sw.notifications.list');
          requireDB('list');
          await ensureTable();
          const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
          const where = opts.unread_only ? 'WHERE user_id = ? AND read = 0' : 'WHERE user_id = ?';
          const r = await DB.prepare(
            'SELECT id, title, body, url, read, created_at FROM _notifications ' + where + ' ORDER BY created_at DESC LIMIT ?'
          ).bind(String(userId), limit).all();
          return { notifications: r.results || [], count: (r.results || []).length };
        },
        async unreadCount() {
          const userId = await __sw_requireSubject('sw.notifications.unreadCount');
          requireDB('unreadCount');
          await ensureTable();
          const r = await DB.prepare(
            'SELECT COUNT(*) AS n FROM _notifications WHERE user_id = ? AND read = 0'
          ).bind(String(userId)).first();
          return r && typeof r.n === 'number' ? r.n : 0;
        },
        // markRead(notificationId) — Runtime v2 closes the row-id-only hole:
        // any caller with a bell-row id could previously flip ANOTHER user's
        // notification. The UPDATE is now constrained to user_id = the verified
        // recipient, so a foreign id simply matches nothing (0 changes).
        async markRead(notificationId) {
          if (!notificationId) return { ok: false, error: 'notificationId required' };
          const userId = await __sw_requireSubject('sw.notifications.markRead');
          requireDB('markRead');
          await ensureTable();
          const res = await DB.prepare(
            'UPDATE _notifications SET read = 1 WHERE id = ? AND user_id = ?'
          ).bind(String(notificationId), String(userId)).run();
          return { ok: true, changes: (res.meta && res.meta.changes) || 0 };
        },
        async markAllRead() {
          const userId = await __sw_requireSubject('sw.notifications.markAllRead');
          requireDB('markAllRead');
          await ensureTable();
          const res = await DB.prepare(
            'UPDATE _notifications SET read = 1 WHERE user_id = ? AND read = 0'
          ).bind(String(userId)).run();
          return { ok: true, changes: (res.meta && res.meta.changes) || 0 };
        },
      };
    })(),

    push: (function () {
      function __sw_pushHidden(op) {
        const err = new Error('sw.push.' + op + ' is not available in this runtime. The browser push subscription API is deferred (tsk_327fe8a4); server-side sw.push.send(...) to a user id still works. Contact support if you need client push subscriptions.');
        err.code = 'PUSH_SUBSCRIBE_UNAVAILABLE';
        err.status = 400;
        return __sw_markExpected(err);
      }
      return {
      // sw.push.vapidPublicKey() → { vapid_public_key }
      // The browser passes vapid_public_key to PushManager.subscribe().
      vapidPublicKey() {
        return platformJSON('/v1/push/vapid-public-key?project_id=' + encodeURIComponent(projectId));
      },
      // sw.push.subscribe / unsubscribe — HIDDEN/DEFERRED in Runtime v2
      // (tsk_327fe8a4, #8). The customer subscribe path persisted a browser
      // subscription against a caller-supplied user_id — an identity claim on
      // an authority surface. Rather than retrofit derivation onto a path with
      // no real customer usage, it is CUT with a clear error and will return
      // later as two explicit, additive, authority-scoped ops. The internal
      // push pipeline and the service op sw.push.send(...) are unaffected.
      subscribe() { throw __sw_pushHidden('subscribe'); },
      unsubscribe() { throw __sw_pushHidden('unsubscribe'); },
      // sw.push.send({ payload, user_id? | endpoint?, ttl? })
      // payload may be a string or any JSON-serializable value.
      send(opts) {
        opts = opts || {};
        return platformJSON('/v1/push/send', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            payload: opts.payload,
            user_id: opts.user_id ?? opts.userId,
            endpoint: opts.endpoint,
            ttl: opts.ttl,
          }),
        });
      },
      };
    })(),
  };
  if (isDraftExecution) {
    // One capability boundary for draft execution. Drafts receive local
    // computation plus their isolated database/files and diagnostic logs.
    // Shared/external capabilities stay outside this object; a method whose
    // name must remain discoverable but whose effect is shared fails with the
    // same typed draft error.
    function draftScopeBlocked() {
      const err = new Error('sw.db.scope is unavailable in a draft because scope declarations change shared project configuration. Declare the scope in production code, then open a new draft.');
      err.code = 'DRAFT_SIDE_EFFECT_BLOCKED';
      err.status = 409;
      err.__sw_expose = true;
      throw err;
    }
    draftScopeBlocked.list = draftScopeBlocked;
    draftScopeBlocked.get = draftScopeBlocked;
    const draftDb = Object.freeze({
      query: sw.db.query,
      batch: sw.db.batch,
      tables: sw.db.tables,
      from: sw.db.from,
      count: sw.db.count,
      insert: sw.db.insert,
      update: sw.db.update,
      remove: sw.db.remove,
      delete: sw.db.delete,
      scope: Object.freeze(draftScopeBlocked),
    });
    const draftFs = Object.freeze({
      read: sw.fs.read,
      write: sw.fs.write,
      delete: sw.fs.delete,
      move: sw.fs.move,
      copy: sw.fs.copy,
      restore: sw.fs.restore,
      stat: sw.fs.stat,
      versions: sw.fs.versions,
      list: sw.fs.list,
      diff: sw.fs.diff,
      glob: sw.fs.glob,
      search: sw.fs.search,
      replace: sw.fs.replace,
      uploadUrl: sw.fs.uploadUrl,
      signedUrl: sw.fs.signedUrl,
      public_url: sw.fs.public_url,
      publicUrl: sw.fs.publicUrl,
      setOwner: sw.fs.setOwner,
      uploadFromRequest: sw.fs.uploadFromRequest,
    });
    const draftSafe = new Set([
      'project_id', 'subdomain', 'tier', 'env', 'request_id', 'params',
      'crypto', 'db', 'fs', 'logs', 'sw', 'ctx',
      '__sw_pendingRefresh', '__sw_pendingCookies', '__sw_pendingBackground',
      // Tracing is observation, not a side effect: a draft must be able to
      // read its own trace id, and the request shim must be able to drain its
      // spans. Omitting these would make the draft proxy throw
      // DRAFT_SIDE_EFFECT_BLOCKED on every draft request (tsk_47a2a3f6).
      'trace', '__sw_trace',
    ]);
    const draftTarget = Object.create(null);
    for (const property of draftSafe) {
      if (property === 'sw' || property === 'ctx') continue;
      const descriptor = Object.getOwnPropertyDescriptor(sw, property);
      if (!descriptor) continue;
      if (property === 'db' || property === 'fs') {
        Object.defineProperty(draftTarget, property, {
          value: property === 'db' ? draftDb : draftFs,
          enumerable: descriptor.enumerable,
        });
      } else {
        Object.defineProperty(draftTarget, property, descriptor);
      }
    }
    const draftSw = new Proxy(draftTarget, {
      get(target, property, receiver) {
        if (typeof property !== 'string' || draftSafe.has(property)) {
          return Reflect.get(target, property, receiver);
        }
        const err = new Error('sw.' + property + ' is unavailable in a draft because it can affect shared or external state.');
        err.code = 'DRAFT_SIDE_EFFECT_BLOCKED';
        err.status = 409;
        err.__sw_expose = true;
        throw err;
      },
    });
    Object.defineProperty(draftTarget, 'sw', { value: draftSw, enumerable: true });
    Object.defineProperty(draftTarget, 'ctx', { value: draftSw, enumerable: true });
    Object.freeze(draftTarget);
    return draftSw;
  }
  // sw and ctx are aliases — same object.
  sw.sw = sw;
  sw.ctx = sw;

  // sol round 6: there is no post-construction "decide the context" step. The
  // project/developer file view (sw.fs.dev) is CONSTRUCTED at the entrypoint
  // structurally allowed to have it (run_code, via devFsEnabled) — see fs.ts and
  // buildPlatformContext. The function bundle never sets that flag, so no HTTP-
  // reached context (fetch handlers, cron, queue, job) has dev, and there is no
  // header to inspect or replay. The round-5 __sw_init classifier is deleted.
  return sw;
}

export { buildPlatformContext };
