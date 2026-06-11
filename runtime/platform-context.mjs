// VENDORED from worker/src/utils/function-bundle.ts (PLATFORM_CONTEXT_JS) @ 8c58200
// — the exact runtime deployed functions run against. Do not edit by hand;
// re-sync with: node scripts/extract-runtime.mjs <monorepo>
// Process-wide cache for sw.auth.me — keyed by the JWT signature
// segment so the full token never lives outside the user's call frame
// any longer than the request itself. CF Workers reuse isolates across
// requests, so a hit here saves the /v1/auth/me round-trip on every
// subsequent call within the cache window. TTL is the smaller of 60s
// or (jwt.exp - now - 5s) so a near-expiry token is never returned
// past its real expiry. Soft cap of 256 entries; oldest evicted on
// overflow. Trade-off: a token revoked server-side stays "valid"
// inside this isolate for up to 60s. If you need stricter freshness,
// fetch /v1/auth/me directly via fetch() instead of sw.auth.me.
const __sw_authMeCache = new Map();
const __sw_AUTH_ME_TTL_MS = 60_000;
const __sw_AUTH_ME_MAX = 256;

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

function buildPlatformContext(env, request) {
  const projectId = env.PROJECT_ID;
  const projectEnv = env.PROJECT_ENV || 'dev';
  const platformDomain = env.PLATFORM_DOMAIN || 'somewhere.tech';
  const platformBase = env.PLATFORM_API_BASE || ('https://api.' + platformDomain);
  const apiKey = env.PROJECT_API_KEY;

  async function platformFetch(path, opts) {
    opts = opts || {};
    const headers = {
      'Authorization': 'Bearer ' + apiKey,
      ...(opts.headers || {}),
    };
    if (opts.body && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(platformBase + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
    });
  }

  async function platformJSON(path, opts) {
    const r = await platformFetch(path, opts);
    let data;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok || !data || data.ok === false) {
      const msg = (data && data.message) || ('Platform call failed: ' + r.status);
      const err = new Error(msg);
      err.code = (data && data.error) || 'PLATFORM_ERROR';
      err.status = r.status;
      throw err;
    }
    return data.data;
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

  // httpOnly cookie sessions (sw.auth.*WithCookie, tsk_1288e1c6). Auth cookies
  // produced during the handler are parked here; the shim attaches them as
  // Set-Cookie on the outbound Response post-handler (Option B — invisible, the
  // dev never touches headers). The cookie persists 30d; the access JWT inside
  // expires ~15min and fromRequest auto-refreshes it from the refresh cookie,
  // re-issuing fresh cookies — so the browser stays logged in across restarts.
  const __sw_pendingCookies = [];
  const __SW_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
  function __sw_authCookie(name, value, maxAge) {
    return name + '=' + encodeURIComponent(value) +
      '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + maxAge;
  }
  function __sw_setAuthCookies(access, refresh) {
    // Names match what fromRequest reads back: access='token', refresh='sw_refresh_token'.
    __sw_pendingCookies.push(__sw_authCookie('token', access, __SW_COOKIE_MAX_AGE));
    __sw_pendingCookies.push(__sw_authCookie('sw_refresh_token', refresh, __SW_COOKIE_MAX_AGE));
  }
  function __sw_clearAuthCookies() {
    __sw_pendingCookies.push(__sw_authCookie('token', '', 0));
    __sw_pendingCookies.push(__sw_authCookie('sw_refresh_token', '', 0));
  }

  const sw = {
    project_id: projectId,
    subdomain: env.SUBDOMAIN || '',
    tier: env.TIER || 'free',
    env: (env.USER_ENV ? JSON.parse(env.USER_ENV) : {}),
    request_id: request.headers.get('cf-ray') || crypto.randomUUID(),
    // Exposed under a name the user code is told never to touch. The
    // shim reads it post-handler. Lives on the same object so user
    // handlers can't accidentally return a fresh ctx without it.
    __sw_pendingRefresh,
    __sw_pendingCookies,

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
      //   1. Native D1 binding when the deploy wired it up (env.PROJECT_DB).
      //      Zero HTTP, no auth middleware — fastest path.
      //   2. REST fallback through /v1/db/query (+ /v1/db/batch) when
      //      no binding is attached. Used on accounts where the WfP
      //      dispatch-namespace + D1 combo is not yet enabled (CF
      //      returns 10015 at script-upload). Re-enable the native
      //      path by setting WFP_D1_BINDING_ENABLED=1 on the worker.
      //
      // The fallback synthesizes an object that mimics D1's binding
      // surface — prepare(sql).bind(...).all() / .batch([...]) — so
      // the rest of this module doesn't branch on which path served
      // the query.
      function __sw_makeRestDB() {
        async function runOne(sql, params) {
          const r = await platformFetch('/v1/db/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, sql: sql, params: params || [] }),
          });
          if (!r.ok) {
            const txt = await r.text().catch(function () { return ''; });
            const err = new Error('sw.db query failed: HTTP ' + r.status + ' ' + txt.slice(0, 200));
            err.code = 'DB_QUERY_FAILED';
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
          // the atomic /v1/db/batch endpoint (the per-project write
          // serializer commits every statement or none). NEVER replay
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
          const r = await platformFetch('/v1/db/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, statements: statements }),
          });
          const txt = await r.text().catch(function () { return ''; });
          let j = null;
          try { j = txt ? JSON.parse(txt) : null; } catch (_) { j = null; }
          if (!r.ok || !j || j.ok === false) {
            const msg = (j && j.message) || ('sw.db.batch failed: HTTP ' + r.status + ' ' + txt.slice(0, 200));
            const err = new Error(msg + ' The batch was rolled back; no statements were applied.');
            err.code = (j && j.error) || 'DB_BATCH_FAILED';
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

      // Direct D1 binding when the deploy wired it up. No HTTP, no API
      // key, no auth middleware — the function's Worker talks directly
      // to the project's database. Falls back to the REST shim above
      // when the binding is absent (CF 10015 carve-out).
      const DB = env.PROJECT_DB || __sw_makeRestDB();

      // Scopes baked in at deploy time. Map of lowercased table name →
      // owner column. Mirrors worker/src/utils/scope-enforcement.ts —
      // see that file for the full threat model.
      const SCOPES = (function () {
        try { return env.PROJECT_SCOPES ? JSON.parse(env.PROJECT_SCOPES) : {}; }
        catch (_) { return {}; }
      })();

      function ensureBinding() {
        // Always satisfied now — DB is either the native binding or
        // the REST facade. Kept as a no-op so the call sites below
        // don't have to change. Remove with the next refactor.
      }

      function __sw_stripStringsAndComments(sql) {
        let out = '', i = 0;
        const n = sql.length;
        while (i < n) {
          const ch = sql[i];
          if (ch === "'") {
            out += ' '; i++;
            while (i < n) {
              if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
              if (sql[i] === "'") { i++; break; }
              i++;
            }
            continue;
          }
          if (ch === '-' && sql[i + 1] === '-') {
            while (i < n && sql[i] !== '\n') i++;
            continue;
          }
          if (ch === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            if (i < n) i += 2;
            continue;
          }
          out += ch; i++;
        }
        return out;
      }

      function __sw_extractTables(sql) {
        const stripped = __sw_stripStringsAndComments(sql);
        const tables = new Set();
        const patterns = [
          /\bFROM\s+("?)([a-zA-Z_][a-zA-Z0-9_]*)\1/gi,
          /\bJOIN\s+("?)([a-zA-Z_][a-zA-Z0-9_]*)\1/gi,
          /\bINTO\s+("?)([a-zA-Z_][a-zA-Z0-9_]*)\1/gi,
          /\bUPDATE\s+("?)([a-zA-Z_][a-zA-Z0-9_]*)\1/gi,
        ];
        for (const rx of patterns) {
          let m;
          while ((m = rx.exec(stripped)) !== null) {
            tables.add(m[2].toLowerCase());
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

      function __sw_escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      function __sw_checkScope(sql) {
        const tableNames = Object.keys(SCOPES);
        if (tableNames.length === 0) return null;
        const touched = __sw_extractTables(sql);
        const stripped = __sw_stripStringsAndComments(sql);
        const kind = __sw_detectStmt(stripped);
        for (const table of touched) {
          const ownerCol = SCOPES[table];
          if (!ownerCol) continue;
          if (kind === 'insert') {
            const m = new RegExp('INTO\\s+"?' + table + '"?\\s*\\(([^)]*)\\)', 'i').exec(stripped);
            if (!m) return { table: table, ownerCol: ownerCol, reason: 'INSERT into scoped table `' + table + '` must use the explicit-column form: INSERT INTO ' + table + ' (' + ownerCol + ', …) VALUES ($current_user, …).' };
            const cols = m[1].split(',').map(function (s) { return s.trim().replace(/^"|"$/g, '').toLowerCase(); });
            if (cols.indexOf(ownerCol.toLowerCase()) === -1) return { table: table, ownerCol: ownerCol, reason: 'INSERT into scoped table `' + table + '` must include column `' + ownerCol + '` set to $current_user.' };
            if (!/\$current_user\b/.test(sql)) return { table: table, ownerCol: ownerCol, reason: 'INSERT into scoped table `' + table + '` must bind `' + ownerCol + '` to $current_user.' };
            continue;
          }
          if (kind === 'select' || kind === 'update' || kind === 'delete') {
            if (!/\bWHERE\b/i.test(stripped)) return { table: table, ownerCol: ownerCol, reason: kind.toUpperCase() + ' on scoped table `' + table + '` must have a WHERE clause that constrains `' + ownerCol + '` to $current_user.' };
            const bindRx = new RegExp('(?:\\b|\\.|")' + __sw_escapeRegex(ownerCol) + '"?\\s*=\\s*\\$current_user\\b', 'i');
            if (!bindRx.test(stripped)) return { table: table, ownerCol: ownerCol, reason: kind.toUpperCase() + ' on scoped table `' + table + '` must constrain `' + ownerCol + '` with: ' + ownerCol + ' = $current_user.' };
            continue;
          }
          return { table: table, ownerCol: ownerCol, reason: 'Statement type not recognized for scope enforcement on `' + table + '`. Use SELECT, INSERT, UPDATE, or DELETE.' };
        }
        return null;
      }

      // Auto-scope rewriter. Given a raw query on a scoped table,
      // produce the equivalent query with the owner predicate
      // injected (via $current_user — the existing substituter then
      // turns it into the actual user id). Returns null for shapes
      // we can't safely rewrite — JOIN/UNION/subquery; caller should
      // throw with a "use scoped(userId).query() explicitly" message.
      //
      // The rule of thumb: if the stripped SQL has any of these
      // tokens beyond the one-table simple shape, bail. Better to
      // force the caller's hand than to silently scope a query that
      // means something different from what the caller wrote.
      function __sw_autoScopeRewrite(sql, table, ownerCol) {
        const stripped = __sw_stripStringsAndComments(sql);
        // Bail on complex shapes — auto-rewriting these is a footgun.
        if (/\bJOIN\b/i.test(stripped)) return null;
        if (/\bUNION\b/i.test(stripped) || /\bEXCEPT\b/i.test(stripped) || /\bINTERSECT\b/i.test(stripped)) return null;
        // Subquery detector: a "(" followed (after whitespace) by SELECT.
        if (/\(\s*SELECT\b/i.test(stripped)) return null;
        const tableNamesTouched = __sw_extractTables(sql);
        // Set has .size, not .length — earlier code used .length, which
        // is undefined, so this branch ALWAYS returned null and the
        // auto-scope rewrite never fired (deploy-scope-mcp-audit.md
        // §"Auto-Scope Database Implementation"). Every {user}-scoped
        // query was throwing SCOPE_VIOLATION instead of injecting the
        // owner predicate.
        if (tableNamesTouched.size !== 1) return null;

        const kind = __sw_detectStmt(stripped);
        const ownerQ = '"' + ownerCol + '"';
        const predicate = ownerQ + ' = $current_user';

        if (kind === 'select' || kind === 'update' || kind === 'delete') {
          // If a WHERE already exists, AND the predicate onto it.
          // Otherwise, append a fresh WHERE clause. Use the ORIGINAL
          // sql (with strings) and place the predicate before any
          // trailing GROUP BY / ORDER BY / LIMIT.
          const whereRx = /\bWHERE\b/i;
          if (whereRx.test(stripped)) {
            // Find the trailing-clause anchor in the stripped sql.
            // String-stripping is a same-length replacement so offsets
            // remain valid against the original SQL.
            const tailMatch = /(\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|;|$)/i.exec(stripped);
            if (!tailMatch) return null;
            const insertAt = tailMatch.index;
            // Inject the AND-predicate before the tail clauses.
            return sql.slice(0, insertAt).trimEnd() + ' AND ' + predicate + ' ' + sql.slice(insertAt);
          }
          // No WHERE — append one before the tail clauses.
          const tailMatch = /(\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|;|$)/i.exec(stripped);
          const insertAt = tailMatch ? tailMatch.index : sql.length;
          return sql.slice(0, insertAt).trimEnd() + ' WHERE ' + predicate + ' ' + sql.slice(insertAt);
        }

        if (kind === 'insert') {
          // Add the owner column to the column list and bind it to
          // $current_user in the VALUES tuple. Single-row INSERT only.
          // Bail if the INSERT has no explicit cols + VALUES shape.
          const m = /INTO\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
          if (!m) return null;
          const colList = m[2];
          const valList = m[3];
          // Already has owner column? Bail — caller did it manually.
          const colsLower = colList.split(',').map(function (c) { return c.trim().replace(/^"|"$/g, '').toLowerCase(); });
          if (colsLower.indexOf(ownerCol.toLowerCase()) !== -1) return null;
          const newCols = colList + ', ' + ownerQ;
          const newVals = valList + ', $current_user';
          const before = sql.slice(0, m.index);
          const after = sql.slice(m.index + m[0].length);
          const newInsert = 'INTO ' + m[1] + ' (' + newCols + ') VALUES (' + newVals + ')';
          return before + newInsert + after;
        }
        return null;
      }

      function __sw_substCurrentUser(sql, params, userId) {
        let out = '', i = 0;
        const n = sql.length;
        const newParams = [];
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
          if (ch === '$' && sql.substr(i, 13) === '$current_user' && !/[a-zA-Z0-9_]/.test(sql[i + 13] || '')) {
            out += '?';
            newParams.push(userId);
            i += 13;
            continue;
          }
          out += ch; i++;
        }
        return { sql: out, params: (params || []).concat(newParams) };
      }

      function __sw_throwViolation(v, hint) {
        const err = new Error(v.reason + (hint ? ' ' + hint : ''));
        err.code = 'SCOPE_VIOLATION';
        err.table = v.table;
        err.owner_column = v.ownerCol;
        throw err;
      }

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

      function prep(sql, params) {
        const normalized = __sw_normalizePlaceholders(sql, params);
        const translated = __sw_translateForDialect(normalized.sql);
        let stmt = DB.prepare(translated);
        if (normalized.params && normalized.params.length) stmt = stmt.bind(...normalized.params);
        return stmt;
      }

      // Slow-query alerting (tsk_4d3e9e item 2) + schema-drift hint
      // (tsk_4d3e9e item 7). Wraps any sw.db execution: console.warn
      // on slow queries (>SW_SLOW_QUERY_MS), and on errors matching
      // "no such column" / "no such table" rewrites the message to
      // tell the developer their schema is out of date — a real
      // missing-column error otherwise blames the deployed code when
      // the actual fix is db_migrate. Logs and dashboard Logs tab
      // surface both tags ([SW_SLOW_QUERY] / [SW_SCHEMA_DRIFT]).
      const SW_SLOW_QUERY_MS = 100;
      function __sw_decorateError(label, sqlPreview, err) {
        const msg = (err && err.message) || String(err);
        const m = msg.match(/no such (?:column|table)[^A-Za-z0-9_]*([A-Za-z0-9_.]*)/i);
        if (m) {
          const ident = m[1] || 'unknown';
          const snippet = String(sqlPreview).replace(/\s+/g, ' ').slice(0, 200);
          console.warn('[SW_SCHEMA_DRIFT] ' + label + ' — ' + ident + ' missing — ' + snippet);
          const better = new Error('Schema drift: ' + msg + '. Your code references "' + ident + '" but the database schema does not. Did you forget to run db_migrate before deploying?');
          better.code = 'SCHEMA_DRIFT';
          better.original = err;
          return better;
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
      async function __sw_timedExec(label, sqlPreview, runner) {
        const start = Date.now();
        let attempt = 0;
        for (;;) {
          try {
            const out = await runner();
            const ms = Date.now() - start;
            if (ms >= SW_SLOW_QUERY_MS) {
              const snippet = String(sqlPreview).replace(/\s+/g, ' ').slice(0, 200);
              console.warn('[SW_SLOW_QUERY] ' + label + ' took ' + ms + 'ms — ' + snippet);
            }
            return out;
          } catch (err) {
            if (attempt < __SW_RETRY_DELAYS.length && __sw_isRetryable(err)) {
              console.warn('[SW_DB_RETRY] ' + label + ' backpressure — retry ' + (attempt + 1) + ' after ' + __SW_RETRY_DELAYS[attempt] + 'ms');
              await new Promise(function (r) { setTimeout(r, __SW_RETRY_DELAYS[attempt]); });
              attempt++;
              continue;
            }
            throw __sw_decorateError(label, sqlPreview, err);
          }
        }
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
          try { size = JSON.stringify(out).length; } catch (_) { size = MAX_TOTAL_CHARS + 1; }
          if (size <= MAX_TOTAL_CHARS) break;
          out.pop();
          truncated = true;
        }
        return { rows: out, truncated: truncated };
      }
      function __sw_publishDbMutation(table, op, rows) {
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

      function scopedClient(userId) {
        if (typeof userId !== 'string' || !userId) {
          const err = new Error('sw.db.scoped(userId) requires a non-empty userId string (the JWT subject from sw.auth.fromRequest).');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }

        function fromTable(table) {
          const tableLc = String(table).toLowerCase();
          const ownerCol = SCOPES[tableLc];
          if (!ownerCol) {
            const err = new Error('sw.db.scoped(...).from("' + table + '") — table is not declared as user-scoped. Declare it via POST /v1/db/scopes with { project_id, table, owner_column }, then redeploy.');
            err.code = 'SCOPE_NOT_DECLARED';
            throw err;
          }
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
            const err = new Error('Invalid table name: ' + table);
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          const tableQ = '"' + table + '"';
          const ownerQ = '"' + ownerCol + '"';

          function whereFromFilter(filter) {
            const keys = filter ? Object.keys(filter) : [];
            const conds = [];
            const params = [];
            for (const k of keys) {
              if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
                const err = new Error('Invalid filter column: ' + k);
                err.code = 'VALIDATION_ERROR';
                throw err;
              }
              conds.push('"' + k + '" = ?');
              params.push(filter[k]);
            }
            conds.push(ownerQ + ' = ?');
            params.push(userId);
            return { where: ' WHERE ' + conds.join(' AND '), params: params };
          }

          return {
            async list(opts) {
              ensureBinding();
              opts = opts || {};
              let sql = 'SELECT * FROM ' + tableQ + ' WHERE ' + ownerQ + ' = ?';
              const params = [userId];
              if (opts.orderBy) {
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(opts.orderBy)) {
                  const err = new Error('Invalid orderBy column: ' + opts.orderBy);
                  err.code = 'VALIDATION_ERROR';
                  throw err;
                }
                sql += ' ORDER BY "' + opts.orderBy + '"' + (opts.descending ? ' DESC' : ' ASC');
              }
              if (typeof opts.limit === 'number') sql += ' LIMIT ' + Math.max(1, Math.floor(opts.limit));
              if (typeof opts.offset === 'number') sql += ' OFFSET ' + Math.max(0, Math.floor(opts.offset));
              const r = await DB.prepare(sql).bind(...params).all();
              return r.results || [];
            },
            async get(id) {
              ensureBinding();
              const r = await DB.prepare('SELECT * FROM ' + tableQ + ' WHERE id = ? AND ' + ownerQ + ' = ?')
                .bind(id, userId).all();
              return (r.results || [])[0] || null;
            },
            async insert(rows) {
              ensureBinding();
              const list = Array.isArray(rows) ? rows : [rows];
              if (list.length === 0) return [];
              const enriched = list.map(function (r) { const copy = Object.assign({}, r); copy[ownerCol] = userId; return copy; });
              const cols = Object.keys(enriched[0]);
              for (const c of cols) {
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) {
                  const err = new Error('Invalid column name: ' + c);
                  err.code = 'VALIDATION_ERROR';
                  throw err;
                }
              }
              const colSql = cols.map(function (c) { return '"' + c + '"'; }).join(', ');
              const placeholders = '(' + cols.map(function () { return '?'; }).join(', ') + ')';
              const valuesClause = enriched.map(function () { return placeholders; }).join(', ');
              const sql = 'INSERT INTO ' + tableQ + ' (' + colSql + ') VALUES ' + valuesClause + ' RETURNING *';
              const params = [];
              for (const r of enriched) for (const c of cols) params.push(r[c]);
              const res = await DB.prepare(sql).bind(...params).all();
              const inserted = res.results || [];
              // tsk_5523b9: known table name — no parse needed.
              // tsk_2bf7d327: include the inserted row(s) (RETURNING *).
              __sw_publishDbMutation(table, 'insert', inserted);
              return inserted;
            },
            async update(filter, patch) {
              ensureBinding();
              const cols = Object.keys(patch || {});
              if (cols.length === 0) {
                const err = new Error('update(filter, patch) requires a non-empty patch object.');
                err.code = 'VALIDATION_ERROR';
                throw err;
              }
              for (const c of cols) {
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) {
                  const err = new Error('Invalid column name in patch: ' + c);
                  err.code = 'VALIDATION_ERROR';
                  throw err;
                }
                if (c.toLowerCase() === ownerCol.toLowerCase()) {
                  const err = new Error('Cannot reassign the owner column `' + ownerCol + '` via .update().');
                  err.code = 'SCOPE_VIOLATION';
                  throw err;
                }
              }
              const setClause = cols.map(function (c) { return '"' + c + '" = ?'; }).join(', ');
              const setParams = cols.map(function (c) { return patch[c]; });
              const w = whereFromFilter(filter);
              // tsk_2bf7d327: RETURNING * so the change event can carry the
              // new row(s). Return shape stays { changes } — derive it from
              // meta.changes, falling back to the returned-row count
              // (RETURNING yields one row per updated row).
              const sql = 'UPDATE ' + tableQ + ' SET ' + setClause + w.where + ' RETURNING *';
              const r = await DB.prepare(sql).bind(...setParams.concat(w.params)).all();
              const updated = r.results || [];
              __sw_publishDbMutation(table, 'update', updated);
              return { changes: (r.meta && typeof r.meta.changes === 'number') ? r.meta.changes : updated.length };
            },
            async delete(filter) {
              ensureBinding();
              const w = whereFromFilter(filter);
              // tsk_2bf7d327: RETURNING * so the change event can carry the
              // deleted (old) row(s). Return shape stays { changes }.
              const sql = 'DELETE FROM ' + tableQ + w.where + ' RETURNING *';
              const r = await DB.prepare(sql).bind(...w.params).all();
              const deleted = r.results || [];
              __sw_publishDbMutation(table, 'delete', deleted);
              return { changes: (r.meta && typeof r.meta.changes === 'number') ? r.meta.changes : deleted.length };
            },
          };
        }

        return {
          async query(sql, params) {
            ensureBinding();
            __sw_assertNoDdl(sql);
            const subst = __sw_substCurrentUser(sql, params, userId);
            const r = await prep(subst.sql, subst.params).all();
            const rows = r.results || [];
            // tsk_5523b9: auto-publish a realtime event for mutations.
            // tsk_2bf7d327: include any returned row(s) (when RETURNING).
            const mut = __sw_mutationOf(sql);
            if (mut) __sw_publishDbMutation(mut.table, mut.op, rows);
            return {
              data: rows,
              error: null,
              count: rows.length,
              last_row_id: (r.meta && r.meta.last_row_id) || null,
              changes: (r.meta && r.meta.changes) || 0,
            };
          },
          async batch(statements) {
            ensureBinding();
            if (!Array.isArray(statements) || statements.length === 0) {
              const err = new Error('sw.db.scoped(...).batch requires a non-empty array of { sql, params }.');
              err.code = 'VALIDATION_ERROR';
              throw err;
            }
            for (const s of statements) __sw_assertNoDdl(s.sql);
            const prepared = statements.map(function (s) {
              const subst = __sw_substCurrentUser(s.sql, s.params, userId);
              return prep(subst.sql, subst.params);
            });
            const results = await __sw_timedExec('sw.db.batch', statements.map(function(s){return s.sql;}).join(' ; ').slice(0, 200), function () { return DB.batch(prepared); });
            // tsk_5523b9: one realtime publish per mutating statement.
            // tsk_2bf7d327: include that statement's returned row(s),
            // index-aligned with the batch result set.
            for (let i = 0; i < statements.length; i++) {
              const mut = __sw_mutationOf(statements[i].sql);
              if (mut) __sw_publishDbMutation(mut.table, mut.op, (results[i] && results[i].results) || []);
            }
            return results.map(function (r) {
              return {
                data: r.results || [],
                changes: (r.meta && r.meta.changes) || 0,
                last_row_id: (r.meta && r.meta.last_row_id) || null,
              };
            });
          },
          from: fromTable,
          user_id: userId,
        };
      }

      // Resolve the user id from a query option in any of the shapes
      // developers actually pass — a string user id, a user object
      // with .id (from sw.auth.fromRequest), or null/missing.
      // Centralized so { user } means the same thing across query()
      // and batch().
      function __sw_resolveUserId(opt) {
        if (opt == null) return null;
        if (typeof opt === 'string') return opt;
        if (typeof opt === 'object' && typeof opt.id === 'string') return opt.id;
        return null;
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
        const cleaned = String(sql).replace(/^(?:\s+|--[^\n]*\n?)+/g, '').toUpperCase();
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
          throw err;
        }
      }

      return {
        async query(sql, params, options) {
          ensureBinding();
          __sw_assertNoDdl(sql);
          options = options || {};
          // Opt-out: { unscoped: true } bypasses the safety net.
          // Document the reason — analytics, admin endpoints, public
          // reads. The security advisor flips from "use scoped" to
          // "you're using unscoped, are you sure?" on this branch.
          const unscoped = options.unscoped === true;
          // Opt-in: { user } bound at the call site (e.g. from
          // sw.auth.fromRequest(req).user). Auto-rewrites a raw
          // query into the equivalent scoped query.
          const userId = __sw_resolveUserId(options.user);
          if (!unscoped) {
            const v = __sw_checkScope(sql);
            if (v) {
              if (userId) {
                // Auto-rewrite: substitute $current_user → user id and
                // route through the scoped-client query path so the
                // existing checker re-validates the rewritten SQL.
                const rewritten = __sw_autoScopeRewrite(sql, v.table, v.ownerCol);
                if (rewritten) {
                  const subst = __sw_substCurrentUser(rewritten, params, userId);
                  const rr = await prep(subst.sql, subst.params).all();
                  const rrRows = rr.results || [];
                  // Realtime publish — same hook as the unscoped path
                  // below. The auto-rewritten SQL targets the same
                  // table, so the channel is identical.
                  // tsk_2bf7d327: include any returned row(s).
                  const mut = __sw_mutationOf(rewritten);
                  if (mut) __sw_publishDbMutation(mut.table, mut.op, rrRows);
                  return {
                    data: rrRows,
                    error: null,
                    count: rrRows.length,
                    last_row_id: (rr.meta && rr.meta.last_row_id) || null,
                    changes: (rr.meta && rr.meta.changes) || 0,
                  };
                }
                __sw_throwViolation(v,
                  'Pass { user } and we will scope your query automatically, but only for single-table SELECT/UPDATE/DELETE/INSERT. This query has a JOIN, UNION, or subquery — use sw.db.scoped(user.id) to write the scoped form explicitly, or { unscoped: true } if cross-user is intentional.');
              }
              __sw_throwViolation(v,
                'Pass { user } as the third arg — sw.db.query(sql, params, { user: sw.auth.fromRequest(req).user }) — or { unscoped: true } if cross-user is intentional. The verbose form sw.db.scoped(user.id).query(...) still works.');
            }
          }
          const r = await __sw_timedExec('sw.db.query', sql, function () { return prep(sql, params).all(); });
          const rows = r.results || [];
          // tsk_5523b9: auto-publish a realtime event for mutations.
          // tsk_2bf7d327: include any returned row(s) (when RETURNING).
          const mut = __sw_mutationOf(sql);
          if (mut) __sw_publishDbMutation(mut.table, mut.op, rows);
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
          for (const s of statements) __sw_assertNoDdl(s.sql);
          options = options || {};
          const unscoped = options.unscoped === true;
          const userId = __sw_resolveUserId(options.user);
          if (!unscoped) {
            for (const s of statements) {
              const v = __sw_checkScope(s.sql);
              if (v && !userId) {
                __sw_throwViolation(v,
                  'Pass { user } as the second arg to sw.db.batch, or { unscoped: true } if cross-user is intentional. The verbose form sw.db.scoped(user.id).batch(...) still works.');
              }
            }
          }
          const prepared = statements.map((s) => {
            if (userId && !unscoped) {
              const v = __sw_checkScope(s.sql);
              if (v) {
                const rewritten = __sw_autoScopeRewrite(s.sql, v.table, v.ownerCol);
                if (rewritten) {
                  const subst = __sw_substCurrentUser(rewritten, s.params, userId);
                  return prep(subst.sql, subst.params);
                }
                __sw_throwViolation(v,
                  'Auto-scope only handles single-table SELECT/UPDATE/DELETE/INSERT. Use sw.db.scoped(user.id).batch(...) for JOIN/UNION/subquery shapes.');
              }
            }
            return prep(s.sql, s.params);
          });
          const results = await __sw_timedExec('sw.db.batch', statements.map(function(s){return s.sql;}).join(' ; ').slice(0, 200), function () { return DB.batch(prepared); });
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
        scoped: scopedClient,
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
    })(),

    fs: {
      async read(path, opts) {
        opts = opts || {};
        // { user } scopes the read to one end-user: the platform enforces the
        // file's per-end-user ACL (owner_subject_*). Pass the app_user id so a
        // file owned by another user is refused.
        const asUser = opts.user || opts.as_user;
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
        const r = await platformFetch('/v1/fs/' + projectId + path, {
          method: 'PUT',
          headers,
          body,
        });
        if (!r.ok) throw new Error('fs.write failed: ' + r.status);
        return r.json();
      },
      delete(path) {
        return platformFetch('/v1/fs/' + projectId + path, { method: 'DELETE' }).then(r => r.json());
      },
      move(from, to, opts) {
        const body = { from, to };
        if (opts && opts.overwrite === true) body.overwrite = true;
        return platformJSON('/v1/fs/' + projectId + '/move', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      copy(from, to) {
        return platformJSON('/v1/fs/' + projectId + '/copy', {
          method: 'POST',
          body: JSON.stringify({ from, to }),
        });
      },
      restore(path, version) {
        return platformJSON('/v1/fs/' + projectId + '/restore', {
          method: 'POST',
          body: JSON.stringify({ path, version }),
        });
      },
      stat(path) {
        return platformJSON('/v1/fs/' + projectId + '/stat' + path);
      },
      versions(path) {
        return platformJSON('/v1/fs/' + projectId + '/versions' + path);
      },
      list(path, opts) {
        opts = opts || {};
        const query = [];
        if (opts.recursive) query.push('recursive=1');
        if (opts.depth) query.push('depth=' + Number(opts.depth));
        const qs = query.length ? '?' + query.join('&') : '';
        const dirPath = path && path !== '/' && !path.endsWith('/') ? path + '/' : (path || '/');
        return platformJSON('/v1/fs/' + projectId + dirPath + qs);
      },
      diff(path, opts) {
        opts = opts || {};
        const body = { path };
        if (typeof opts.version === 'number') body.version = opts.version;
        return platformJSON('/v1/fs/' + projectId + '/diff', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      glob(pattern, opts) {
        opts = opts || {};
        return platformJSON('/v1/fs/' + projectId + '/glob', {
          method: 'POST',
          body: JSON.stringify({ pattern, limit: opts.limit }),
        });
      },
      search(opts) {
        opts = opts || {};
        return platformJSON('/v1/fs/' + projectId + '/search', {
          method: 'POST',
          body: JSON.stringify({
            path: opts.path || '/',
            query: opts.query,
            limit: opts.limit,
            max_files: opts.max_files,
          }),
        });
      },
      replace(opts) {
        return platformJSON('/v1/fs/' + projectId + '/replace', {
          method: 'POST',
          body: JSON.stringify({
            path: opts.path,
            find: opts.find,
            replace: opts.replace,
          }),
        });
      },
      // sw.fs.uploadUrl({ path, maxSize?, contentType?, expiresIn? })
      // → { url, path, expires_at, max_size, content_type }
      // Mints a short-lived signed URL the browser can PUT bytes to
      // directly. The browser does NOT need a platform key.
      uploadUrl(opts) {
        opts = opts || {};
        return platformJSON('/v1/fs/upload-url', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            path: opts.path,
            max_size: opts.maxSize ?? opts.max_size,
            content_type: opts.contentType ?? opts.content_type,
            expires_in: opts.expiresIn ?? opts.expires_in,
          }),
        });
      },
      // sw.fs.signedUrl(path, { expiresIn? })
      //   → { url, token, path, expires_at, expires_in }
      // Mints a short-lived signed URL anyone can GET to download the
      // file. No platform key required for the recipient. Default 1h,
      // max 7d. Common for email attachments, image previews, share
      // links.
      signedUrl(path, opts) {
        opts = opts || {};
        return platformJSON('/v1/fs/' + projectId + '/sign', {
          method: 'POST',
          body: JSON.stringify({
            path,
            expires_in: opts.expiresIn ?? opts.expires_in,
            // { user } mints a link only if that end-user owns the file
            // (per-end-user ACL, owner_subject_*). Omit for full backend access.
            as_user: opts.user ?? opts.as_user,
          }),
        });
      },
      // sw.fs.public_url(path) → { path, public_url, content_type, size_bytes, visibility }
      // Flips the file to public and returns its permanent, unauthenticated
      // URL. Advertised in AGENT.md but was missing from the shim (doc/runtime
      // drift — a function calling it got "undefined is not a function").
      public_url(path) {
        return platformJSON('/v1/fs/' + projectId + '/public-url?path=' + encodeURIComponent(path));
      },
      publicUrl(path) {
        return platformJSON('/v1/fs/' + projectId + '/public-url?path=' + encodeURIComponent(path));
      },
      // sw.fs.setOwner(path, user)
      //   → { path, owner_subject_type, owner_subject_id }
      // Assigns (or transfers) a PRIVATE file to a single end-user so only that
      // app_user can read it — via sw.fs.read(path, { user }) /
      // sw.fs.signedUrl(path, { user }). Pass null to reset ownership back to
      // the project. The ACL applies to private files only.
      setOwner(path, user) {
        return platformJSON('/v1/fs/' + projectId + '/owner', {
          method: 'POST',
          body: JSON.stringify({ path, owner: user ?? null }),
        });
      },
      // sw.fs.uploadFromRequest(req, { path, maxBytes?, allowedTypes?, fieldName? })
      //   → { url, path, size, contentType }
      //
      // One-call multipart upload handler. Parses multipart/form-data
      // from the request, validates against the optional limits, writes
      // to the given path, returns the public URL the browser can fetch.
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
        await this.write(path, bytes, { contentType: fileType });
        const normalizedPath = path.startsWith('/') ? path : '/' + path;
        return {
          url: '/storage' + normalizedPath,
          path: normalizedPath,
          size,
          contentType: fileType,
        };
      },
    },

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

    ai: (function () {
      // Direct DB binding for sw.ai surfaces that read/write the
      // project DB (catalogTool, userMemory, notifications bell).
      // Mirrors the sw.db IIFE's "const DB = env.PROJECT_DB;" — kept
      // separate per-closure so each surface fails loud with a
      // helpful error rather than throwing on undefined.
      const DB = env.PROJECT_DB;

      function withSubject(opts, subjectType, subjectId) {
        opts = opts || {};
        if (!subjectId) {
          const err = new Error('sw.ai.scoped: subjectId is required');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        return {
          ...opts,
          subject_type: subjectType || 'app_user',
          subject_id: String(subjectId),
        };
      }
      function chat(opts) {
        return platformJSON('/v1/ai/complete', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      }
      function transcribe(opts) {
        return platformJSON('/v1/ai/transcribe', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      }
      // tts returns binary audio (Response) when no storage opt is set,
      // and a JSON envelope { storage_path, ... } when storage is set.
      // Mirrors sw.render.* — keep raw Response so callers can stream.
      async function tts(opts) {
        opts = opts || {};
        const body = JSON.stringify({ ...opts, project_id: projectId });
        if (opts.storage) {
          return platformJSON('/v1/ai/tts', { method: 'POST', body });
        }
        const r = await platformFetch('/v1/ai/tts', { method: 'POST', body });
        if (!r.ok) {
          let msg = 'tts failed: ' + r.status;
          try { const j = await r.json(); if (j && j.message) msg = j.message; } catch { /* noop */ }
          const err = new Error(msg); err.status = r.status; throw err;
        }
        return r;
      }
      async function generateImage(opts) {
        opts = opts || {};
        const body = JSON.stringify({ ...opts, project_id: projectId });
        if (opts.storage) {
          return platformJSON('/v1/ai/generate-image', { method: 'POST', body });
        }
        const r = await platformFetch('/v1/ai/generate-image', { method: 'POST', body });
        if (!r.ok) {
          let msg = 'generate-image failed: ' + r.status;
          try { const j = await r.json(); if (j && j.message) msg = j.message; } catch { /* noop */ }
          const err = new Error(msg); err.status = r.status; throw err;
        }
        return r;
      }
      async function removeBackground(opts) {
        opts = opts || {};
        const body = JSON.stringify({ ...opts, project_id: projectId });
        if (opts.storage) {
          return platformJSON('/v1/ai/remove-background', { method: 'POST', body });
        }
        const r = await platformFetch('/v1/ai/remove-background', { method: 'POST', body });
        if (!r.ok) {
          let msg = 'remove-background failed: ' + r.status;
          try { const j = await r.json(); if (j && j.message) msg = j.message; } catch { /* noop */ }
          const err = new Error(msg); err.status = r.status; throw err;
        }
        return r;
      }
      function embeddings(opts) {
        return platformJSON('/v1/ai/embeddings', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
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
        return platformJSON('/v1/ai/conversations/' + encodeURIComponent(id) + '?' + q.toString());
      }
      function conversationDelete(id) {
        return platformJSON('/v1/ai/conversations/' + encodeURIComponent(id) + '?project_id=' + encodeURIComponent(projectId), {
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
        return platformJSON('/v1/ai/conversations/' + encodeURIComponent(sourceId) + '/fork', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      const conversations = {
        list: conversationsList,
        get: conversationGet,
        delete: conversationDelete,
        fork: conversationFork,
        forUser(userId) {
          return {
            list(opts) { return conversationsList({ ...(opts || {}), subject_type: 'app_user', subject_id: String(userId) }); },
            get: conversationGet,
            delete: conversationDelete,
            fork: conversationFork,
          };
        },
      };

      // Tool-use loop helper (tsk_293ae3fd) — every chatbot was
      // re-implementing the same while-stop_reason==='tool_use' loop
      // with iteration caps and error handling. chatWithTools runs the
      // loop internally; the dev provides one tool-dispatch function.
      //
      //   const r = await sw.ai.chatWithTools({
      //     provider: 'anthropic',
      //     model: 'claude-haiku-4-5',
      //     conversation_id: 'nibble:' + user.id,
      //     messages: [{ role: 'user', content: text }],
      //     tools: [{ name: 'lookup', description: '...', input_schema: {...} }],
      //     async executeTools(toolCalls) {
      //       // toolCalls = [{ id, name, input }, ...]
      //       return Promise.all(toolCalls.map(async (tc) => {
      //         try {
      //           const out = await runTool(tc.name, tc.input);
      //           return { tool_use_id: tc.id, content: JSON.stringify(out) };
      //         } catch (err) {
      //           return { tool_use_id: tc.id, content: String(err), is_error: true };
      //         }
      //       }));
      //     },
      //     maxIterations: 5,   // optional, default 5
      //     maxSpendCents: 50,  // optional, abort if running cost passes cap
      //   });
      //   // r.text, r.iterations, r.tool_calls_made, r.total_cost_cents
      async function chatWithTools(opts) {
        opts = opts || {};
        const execute = opts.executeTools;
        if (typeof execute !== 'function') {
          const err = new Error('sw.ai.chatWithTools: executeTools function is required');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        const maxIter = Math.max(1, Math.min(20, Number(opts.maxIterations) || 5));
        const maxSpend = typeof opts.maxSpendCents === 'number' && opts.maxSpendCents > 0
          ? opts.maxSpendCents
          : Infinity;

        // Pull out loop-specific opts so they don't bleed into the
        // underlying chat() call.
        const passOpts = { ...opts };
        delete passOpts.executeTools;
        delete passOpts.maxIterations;
        delete passOpts.maxSpendCents;

        let messages = Array.isArray(opts.messages) ? [...opts.messages] : [];
        let totalCostCents = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let toolCallsMade = 0;
        let lastResponse = null;

        for (let iter = 0; iter < maxIter; iter++) {
          const r = await chat({ ...passOpts, messages });
          lastResponse = r;
          if (r && r.usage) {
            totalInputTokens += Number(r.usage.input_tokens) || 0;
            totalOutputTokens += Number(r.usage.output_tokens) || 0;
          }
          if (r && r.cost && typeof r.cost.total_cents === 'number') {
            totalCostCents += r.cost.total_cents;
          }
          if (totalCostCents > maxSpend) {
            const err = new Error('sw.ai.chatWithTools: maxSpendCents (' + maxSpend + '¢) exceeded at iter ' + iter + ' (' + totalCostCents + '¢).');
            err.code = 'AI_SPEND_CAP_EXCEEDED';
            err.status = 402;
            throw err;
          }

          const blocks = Array.isArray(r && r.content) ? r.content : [];
          const toolUseBlocks = blocks.filter((b) => b && b.type === 'tool_use');

          if (r.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
            // Final answer — return with accumulated metrics.
            return {
              ...r,
              iterations: iter + 1,
              tool_calls_made: toolCallsMade,
              total_input_tokens: totalInputTokens,
              total_output_tokens: totalOutputTokens,
              total_cost_cents: totalCostCents,
            };
          }

          // Run dev's tool dispatcher.
          toolCallsMade += toolUseBlocks.length;
          let toolResults;
          try {
            toolResults = await execute(toolUseBlocks.map((b) => ({
              id: b.id, name: b.name, input: b.input,
            })));
          } catch (err) {
            // Tool runner threw — feed the error back to the model as
            // a tool_result with is_error so it can recover, rather
            // than aborting the whole loop.
            toolResults = toolUseBlocks.map((b) => ({
              tool_use_id: b.id,
              content: 'Tool runner threw: ' + (err && err.message ? err.message : String(err)),
              is_error: true,
            }));
          }
          if (!Array.isArray(toolResults)) {
            const err = new Error('sw.ai.chatWithTools: executeTools must return an array of tool_result objects.');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          // Build the next-iter user message: an array of tool_result
          // blocks, one per tool_use the model emitted. Missing ids get
          // synthesized so the model never sees an unanswered tool_use.
          const resultsById = new Map();
          for (const tr of toolResults) {
            if (tr && typeof tr.tool_use_id === 'string') resultsById.set(tr.tool_use_id, tr);
          }
          const orderedResults = toolUseBlocks.map((b) => {
            const tr = resultsById.get(b.id);
            if (tr) {
              return {
                type: 'tool_result',
                tool_use_id: b.id,
                content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
                ...(tr.is_error ? { is_error: true } : {}),
              };
            }
            return {
              type: 'tool_result',
              tool_use_id: b.id,
              content: 'No result returned for this tool call.',
              is_error: true,
            };
          });

          // On the next iter, messages is just the new user tool_result
          // turn — the platform's conversation_id replay handles
          // history, OR if no conversation_id we keep building a local
          // history.
          if (opts.conversation_id) {
            messages = [{ role: 'user', content: orderedResults }];
          } else {
            messages.push({ role: 'assistant', content: blocks });
            messages.push({ role: 'user', content: orderedResults });
          }
        }

        // Hit maxIterations without a terminal answer. Return the last
        // response so the dev can inspect what the model wanted to do.
        const err = new Error('sw.ai.chatWithTools: maxIterations (' + maxIter + ') reached without a final answer.');
        err.code = 'AI_MAX_ITERATIONS';
        err.status = 422;
        // Stuff metrics onto the error so a logging handler can see
        // them without re-querying.
        err.metrics = {
          iterations: maxIter,
          tool_calls_made: toolCallsMade,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          total_cost_cents: totalCostCents,
          last_response: lastResponse,
        };
        throw err;
      }

      // sw.ai.userMemory — per-user structured memory blob with
      // auto-compaction (tsk_293ae3fd item 2). Every chat app
      // reinvents this — Nibble has nibble_memory, RailTime would
      // have railtime_memory, etc. One table, three calls.
      //
      //   const m = await sw.ai.userMemory.get(user.id);
      //   await sw.ai.userMemory.update(user.id, { preferred_line: 'Northern' });
      //   // After N turns, fold history into the structured blob:
      //   await sw.ai.userMemory.compact(user.id, {
      //     type: 'object',
      //     properties: {
      //       preferred_line: { type: 'string' },
      //       commute_time: { type: 'string' },
      //       last_seen_disruptions: { type: 'array', items: { type: 'string' } },
      //     },
      //   }, { conversation_id: 'railtime:' + user.id });
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
      const userMemory = {
        async get(userId) {
          if (!userId) {
            const err = new Error('sw.ai.userMemory.get: userId is required'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          await ensureMemoryTable();
          const r = await DB.prepare(
            'SELECT blob_json, updated_at FROM _ai_user_memory WHERE user_id = ?'
          ).bind(String(userId)).first();
          if (!r) return {};
          try { return JSON.parse(r.blob_json); } catch { return {}; }
        },
        async update(userId, patch) {
          if (!userId) {
            const err = new Error('sw.ai.userMemory.update: userId is required'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            const err = new Error('sw.ai.userMemory.update: patch must be a plain object'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          await ensureMemoryTable();
          const current = await this.get(userId);
          const merged = { ...current, ...patch };
          const now = Date.now();
          await DB.prepare(
            'INSERT INTO _ai_user_memory (user_id, blob_json, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(user_id) DO UPDATE SET blob_json = excluded.blob_json, updated_at = excluded.updated_at'
          ).bind(String(userId), JSON.stringify(merged), now).run();
          return merged;
        },
        async clear(userId) {
          if (!userId) {
            const err = new Error('sw.ai.userMemory.clear: userId is required'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          await ensureMemoryTable();
          await DB.prepare('DELETE FROM _ai_user_memory WHERE user_id = ?').bind(String(userId)).run();
          return { cleared: true };
        },
        // compact(userId, schema, opts?) — feeds recent conversation
        // turns to a cheap model with the schema as a response_schema,
        // merges the structured output into the existing blob. Returns
        // the new blob. Use after N conversation turns or as a periodic
        // cron task. Cost: one ai.chat call against the cheapest model.
        async compact(userId, schema, opts) {
          opts = opts || {};
          if (!userId) {
            const err = new Error('sw.ai.userMemory.compact: userId is required'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          if (!schema || typeof schema !== 'object') {
            const err = new Error('sw.ai.userMemory.compact: schema (JSON Schema object) is required'); err.code = 'VALIDATION_ERROR'; throw err;
          }
          // Pull recent turns from the user's conversation, if one was
          // named. Without a conversation_id we still extract from any
          // history the dev pre-loads as opts.history.
          let recentText = '';
          if (opts.conversation_id) {
            try {
              const full = await platformJSON('/v1/ai/conversations/' + encodeURIComponent(opts.conversation_id) + '?project_id=' + encodeURIComponent(projectId));
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
            return this.get(userId);
          }

          const current = await this.get(userId);
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

      // sw.ai.catalogTool (tsk_261b) — three-line wiring for the
      // "search my catalog" tool every chat app builds. Returns
      // { tool, execute } so the dev can drop them into
      // sw.ai.chatWithTools without re-implementing the
      // SELECT/LIKE/format pattern.
      //
      //   const restaurants = sw.ai.catalogTool({
      //     table: 'restaurants',
      //     searchColumns: ['name', 'cuisine', 'neighborhood'],
      //     resultColumns: ['id', 'name', 'cuisine', 'rating', 'image_url'],
      //     urlTemplate: '/restaurant/{id}',
      //     limit: 10,
      //     // optional Anthropic-tool overrides:
      //     name: 'search_restaurants',
      //     description: 'Search the restaurant catalog by name, cuisine, or area.',
      //     // optional WHERE constraint (parameterized):
      //     where: { sql: 'is_published = ?', params: [1] },
      //   });
      //
      //   const r = await sw.ai.chatWithTools({
      //     model: 'claude-haiku-4-5',
      //     messages: [{ role: 'user', content: q }],
      //     tools: [restaurants.tool],
      //     async executeTools(toolCalls) {
      //       return Promise.all(toolCalls.map(async (tc) => {
      //         if (tc.name === restaurants.tool.name) {
      //           const out = await restaurants.execute(tc.input);
      //           return { tool_use_id: tc.id, content: JSON.stringify(out) };
      //         }
      //         return { tool_use_id: tc.id, content: 'Unknown tool', is_error: true };
      //       }));
      //     },
      //   });
      //
      // Identifier safety: table + column names are validated against
      // [a-zA-Z0-9_]+ so the assembled SQL is injection-safe. The
      // user query is bound as a parameter — never interpolated.
      function catalogTool(cfg) {
        cfg = cfg || {};
        const table = String(cfg.table || '');
        if (!/^[a-zA-Z0-9_]+$/.test(table)) {
          const err = new Error('sw.ai.catalogTool: table must be [a-zA-Z0-9_]+'); err.code = 'VALIDATION_ERROR'; throw err;
        }
        const searchColumns = Array.isArray(cfg.searchColumns) ? cfg.searchColumns.filter((c) => typeof c === 'string' && /^[a-zA-Z0-9_]+$/.test(c)) : [];
        if (searchColumns.length === 0) {
          const err = new Error('sw.ai.catalogTool: searchColumns required'); err.code = 'VALIDATION_ERROR'; throw err;
        }
        const resultColumns = Array.isArray(cfg.resultColumns) && cfg.resultColumns.length > 0
          ? cfg.resultColumns.filter((c) => typeof c === 'string' && /^[a-zA-Z0-9_]+$/.test(c))
          : null;
        const selectExpr = resultColumns && resultColumns.length > 0
          ? resultColumns.map((c) => '"' + c + '"').join(', ')
          : '*';
        const defaultLimit = Math.max(1, Math.min(50, Number(cfg.limit) || 10));
        const urlTemplate = typeof cfg.urlTemplate === 'string' ? cfg.urlTemplate : null;
        const extraWhere = cfg.where && typeof cfg.where.sql === 'string' ? cfg.where : null;

        const toolName = typeof cfg.name === 'string' && /^[a-zA-Z0-9_]+$/.test(cfg.name)
          ? cfg.name
          : 'search_' + table;
        const description = typeof cfg.description === 'string'
          ? cfg.description
          : 'Search the ' + table + ' catalog. Matches user query against ' + searchColumns.join(', ') + ' with a SQL LIKE.';

        const tool = {
          name: toolName,
          description,
          input_schema: {
            type: 'object',
            properties: {
              query:  { type: 'string',  description: 'Free-text search query (matched against ' + searchColumns.join(', ') + ').' },
              limit:  { type: 'integer', description: 'Max results to return. Defaults to ' + defaultLimit + ', capped at 50.' },
            },
            required: ['query'],
          },
        };

        async function execute(input) {
          input = input || {};
          const query = String(input.query || '').trim();
          const limit = Math.max(1, Math.min(50, Number(input.limit) || defaultLimit));
          if (!query) return { count: 0, results: [] };

          if (!DB || typeof DB.prepare !== 'function') {
            const err = new Error('sw.ai.catalogTool: sw.db is not attached to this deploy. Call any sw.db.* method once first to provision the database, then redeploy.');
            err.code = 'DB_NOT_PROVISIONED';
            throw err;
          }

          const likeClause = searchColumns.map((c) => '"' + c + '" LIKE ?').join(' OR ');
          const params = searchColumns.map(() => '%' + query + '%');
          let sql = 'SELECT ' + selectExpr + ' FROM "' + table + '" WHERE (' + likeClause + ')';
          if (extraWhere) {
            sql += ' AND (' + extraWhere.sql + ')';
            if (Array.isArray(extraWhere.params)) {
              for (const p of extraWhere.params) params.push(p);
            }
          }
          sql += ' LIMIT ?';
          params.push(limit);

          const stmt = params.length > 0
            ? DB.prepare(sql).bind(...params)
            : DB.prepare(sql);
          const r = await stmt.all();
          const rows = (r.results || []);
          const results = urlTemplate
            ? rows.map((row) => {
                const url = urlTemplate.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
                  const v = row[key];
                  return v == null ? '' : encodeURIComponent(String(v));
                });
                return Object.assign({}, row, { url });
              })
            : rows;
          return { count: results.length, query, limit, results };
        }

        return { tool, execute };
      }

      return {
        chat,
        complete: chat,
        chatWithTools,
        catalogTool,
        userMemory,
        conversations,
        scoped(subjectId, subjectType) {
          const sType = subjectType || 'app_user';
          return {
            chat(opts) { return chat(withSubject(opts, sType, subjectId)); },
            complete(opts) { return chat(withSubject(opts, sType, subjectId)); },
            chatWithTools(opts) { return chatWithTools(withSubject(opts, sType, subjectId)); },
            conversations: {
              list(opts) { return conversationsList({ ...(opts || {}), subject_type: sType, subject_id: String(subjectId) }); },
              get: conversationGet,
              delete: conversationDelete,
              fork: conversationFork,
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

    image: (function () {
      // Image transformations — URL builder. Returns a string URL that
      // points at Cloudflare's image resizer on the project's domain.
      // Stick the URL in <img src="..."> or fetch it server-side. No
      // API call is made by this helper; transformation happens at the
      // edge when the URL is fetched.
      const PROJECT_HOST = env.SUBDOMAIN ? env.SUBDOMAIN + '.somewhere.tech' : null;

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
        if (opts.body && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        const r = await fetch(platformBase + path, {
          method: opts.method || 'GET',
          headers,
          body: opts.body,
        });
        let data;
        try { data = await r.json(); } catch { data = null; }
        if (!r.ok || !data || data.ok === false) {
          const msg = (data && data.message) || ('Auth call failed: ' + r.status);
          const err = new Error(msg);
          err.code = (data && data.error) || 'AUTH_ERROR';
          err.status = r.status;
          throw err;
        }
        return data.data;
      }

      return {
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
          const now = Date.now();

          // Cache hit short-circuits the network call. Skip the cache
          // when a refreshToken is supplied AND the access token is
          // expired — otherwise a previously-cached fresh response
          // would suppress the refresh that the caller is asking for.
          if (!(refreshToken && pre.expired)) {
            const hit = __sw_authMeCache.get(pre.sig);
            if (hit && hit.expiresAt > now) {
              return hit.payload;
            }
          }

          // Build the auth call by hand because we need the raw
          // Response back to read X-New-* headers — userTokenJSON
          // throws away the headers and returns data only.
          const headers = { 'Authorization': 'Bearer ' + token };
          if (refreshToken) headers['X-Refresh-Token'] = refreshToken;
          const r = await fetch(platformBase + '/v1/auth/me', { headers });
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
          // cache key (sig of the old access token) is stale anyway.
          if (!(newAccess && newRefresh)) {
            let ttl = __sw_AUTH_ME_TTL_MS;
            if (pre.expSec) {
              const untilExp = pre.expSec * 1000 - now - 5_000;
              if (untilExp > 0 && untilExp < ttl) ttl = untilExp;
            }
            if (ttl > 0) {
              if (__sw_authMeCache.size >= __sw_AUTH_ME_MAX) {
                const firstKey = __sw_authMeCache.keys().next().value;
                if (firstKey) __sw_authMeCache.delete(firstKey);
              }
              __sw_authMeCache.set(pre.sig, { payload, expiresAt: now + ttl });
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

        // ── httpOnly cookie sessions (tsk_1288e1c6) ──────────────────────
        // Set the session as HttpOnly + Secure cookies on the response and
        // return the user. The client just does fetch(url, { credentials:
        // 'include' }) — no tokens in localStorage, nothing for XSS to steal,
        // and fromRequest auto-refreshes the cookie so sessions are long-lived.
        // The cookies ride out on the Response via the shim, so the handler
        // returns a plain user/Response and does zero header work.
        async loginWithCookie(req, email, password) {
          const d = await this.login({ email: email, password: password });
          const access = d && (d.token || d.access_token);
          const refresh = d && d.refresh_token;
          if (access && refresh) __sw_setAuthCookies(access, refresh);
          return (d && d.user) || null;
        },
        async signupWithCookie(req, email, password) {
          const d = await this.signup({ email: email, password: password });
          const access = d && (d.token || d.access_token);
          const refresh = d && d.refresh_token;
          if (access && refresh) __sw_setAuthCookies(access, refresh);
          return (d && d.user) || null;
        },
        // Completes the Google OAuth round-trip: reads ?code from the callback
        // request, exchanges it, sets the cookies, returns a 302 redirect.
        async googleCallbackWithCookie(req, redirectTo) {
          const u = new URL(req.url);
          const code = u.searchParams.get('code');
          if (!code) { const e = new Error('Missing ?code on the OAuth callback.'); e.code = 'VALIDATION_ERROR'; throw e; }
          const d = await this.googleExchange({ code: code, redirect_uri: u.origin + u.pathname });
          const access = d && (d.token || d.access_token);
          const refresh = d && d.refresh_token;
          if (access && refresh) __sw_setAuthCookies(access, refresh);
          return new Response(null, { status: 302, headers: { Location: redirectTo || '/' } });
        },
        // Revokes the session server-side and clears the cookies.
        async logoutWithCookie(req) {
          const ch = (req && req.headers && (req.headers.get('cookie') || req.headers.get('Cookie'))) || '';
          const refresh = __sw_readCookie(ch, 'sw_refresh_token') || __sw_readCookie(ch, 'refresh_token');
          try { await this.logout(refresh ? { refresh_token: refresh } : {}); } catch (_) {}
          __sw_clearAuthCookies();
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
              headers: { Authorization: 'Bearer ' + opts.token },
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
              headers: { Authorization: 'Bearer ' + opts.token },
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
              headers: { Authorization: 'Bearer ' + opts.token },
            });
          },
        },

        // sw.auth.admin used to live here — removed 2026-05-21 per the
        // function-runtime security audit (tsk_a9f1fee70). Admin
        // app-user actions (banUser, deleteUser, impersonate, session
        // revocation, etc.) silently used the deploy-time smt_ key, so
        // any public handler that accepted a userId from the request
        // body became a takeover primitive. Existing call sites get a
        // typed error pointing at the supported paths — the same
        // REST/MCP endpoints continue to work for legitimate operator
        // tooling, just not from inside a request handler.
        admin: new Proxy({}, {
          get(_t, prop) {
            return () => {
              const err = new Error(
                'sw.auth.admin.' + String(prop) + ' was removed from the function runtime (2026-05-21). ' +
                'Admin actions on app_users must run with a developer smt_ key, not inside a request handler — ' +
                'call PATCH/DELETE /v1/auth/users/:id directly (CLI: somewhere fetch ..., MCP: auth_user_delete / auth_user_update), ' +
                'or admin from your operator dashboard. Reason: any public handler taking a userId from the body could escalate.'
              );
              err.code = 'AUTH_ADMIN_REMOVED_FROM_RUNTIME';
              throw err;
            };
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
        // request, returns the user, or throws an Error with status=401
        // if the request is unauthenticated. The handler shim turns
        // thrown errors with a status field into the matching HTTP
        // response, so a typical guarded handler is one line:
        //
        //   export default async (req, sw) => {
        //     const user = await sw.auth.requireUser(req);
        //     return Response.json({ id: user.id, email: user.email });
        //   };
        //
        // Optional second arg matches sw.auth.fromRequest's enrichment
        // shape so requireUser(req, { enrichFrom: 'members', fields: [...] })
        // returns the joined fields too.
        async requireUser(req, enrich) {
          const user = await this.fromRequest(req, enrich);
          if (!user) {
            const err = new Error('Sign in required.');
            err.code = 'AUTH_REQUIRED';
            err.status = 401;
            throw err;
          }
          return user;
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
          if (!req || !req.headers || typeof req.headers.get !== 'function') return null;
          // Parse the Cookie header once into an exact-key map. A per-name
          // regex had an order edge case — reading 'token' failed when
          // 'sw_refresh_token' (which contains "token") came first in the
          // header, which browsers do freely (tsk_1288e1c6). Exact-key match
          // is order-independent and collision-free.
          const cookieHeader = req.headers.get('cookie') || req.headers.get('Cookie') || '';
          const jar = {};
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
          for (const name of ['token', 'auth_token', 'session']) {
            if (jar[name]) { token = jar[name]; fromCookie = true; break; }
          }
          if (!token) {
            token = __sw_readBearer(req.headers.get('Authorization') || req.headers.get('authorization'));
          }
          if (!token) return null;

          let refreshToken = null;
          const optOut = req.headers.get('X-No-Auto-Refresh') || req.headers.get('x-no-auto-refresh');
          if (optOut !== '1') {
            refreshToken = req.headers.get('X-Refresh-Token') || req.headers.get('x-refresh-token');
            if (!refreshToken) {
              for (const name of ['refresh_token', 'sw_refresh_token']) {
                if (jar[name]) { refreshToken = jar[name]; break; }
              }
            }
          }

          let user;
          try {
            const result = await this.me(token, refreshToken ? { refreshToken } : undefined);
            user = result && result.user ? result.user : (result || null);
          } catch (_) {
            return null;
          }
          if (!user) return null;

          // Cookie session that auto-refreshed → re-issue the httpOnly cookies so
          // the browser keeps a long-lived session, invisibly (tsk_1288e1c6). The
          // header-based X-New-* path (non-cookie clients) is unaffected.
          if (fromCookie && __sw_pendingRefresh.access && __sw_pendingRefresh.refresh) {
            __sw_setAuthCookies(__sw_pendingRefresh.access, __sw_pendingRefresh.refresh);
          }

          // Optional enrichment — JOIN the dev's user-table row onto
          // the platform user. Skipped when not requested or when sw.db
          // isn't bound (shouldn't happen in practice). Errors are
          // swallowed so a missing table doesn't crash the request —
          // returns the unenriched user.
          if (enrich && enrich.enrichFrom && DB && typeof DB.prepare === 'function') {
            const table = String(enrich.enrichFrom);
            // Allow only [a-zA-Z0-9_] table names — same constraint
            // sw.db.scoped uses, blocks SQL injection on this surface.
            if (!/^[a-zA-Z0-9_]+$/.test(table)) {
              console.error('sw.auth.fromRequest: invalid enrichFrom table name:', table);
              return user;
            }
            const joinCol = enrich.on && /^[a-zA-Z0-9_]+$/.test(String(enrich.on))
              ? String(enrich.on)
              : 'id';
            let selectExpr = '*';
            if (Array.isArray(enrich.fields) && enrich.fields.length > 0) {
              const cleaned = enrich.fields
                .filter((f) => typeof f === 'string' && /^[a-zA-Z0-9_]+$/.test(f))
                .map((f) => '"' + f + '"');
              if (cleaned.length > 0) selectExpr = cleaned.join(', ');
            }
            try {
              const row = await DB.prepare(
                'SELECT ' + selectExpr + ' FROM "' + table + '" WHERE "' + joinCol + '" = ?'
              ).bind(user.id).first();
              if (row) {
                // Platform fields win on collision — never let the
                // dev table overwrite id/email/etc.
                user = Object.assign({}, row, user);
              }
            } catch (err) {
              console.error('sw.auth.fromRequest enrichment failed:', err && err.message ? err.message : err);
            }
          }
          return user;
        },

        // Cookie-backed anonymous identity for pre-signup users.
        // Reads sw_anon_id from the request cookie if present; otherwise
        // mints a fresh uuid and returns a setCookie string the caller
        // attaches to its response. Use applyTo() to wrap a Response in
        // one line.
        anonSession(req) {
          let id = null;
          let isNew = false;
          if (req && req.headers && typeof req.headers.get === 'function') {
            const existing = __sw_readCookie(
              req.headers.get('cookie') || req.headers.get('Cookie'),
              'sw_anon_id'
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
            ? `sw_anon_id=${id}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
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
          opts = opts || {};
          if (!opts.anonId || !opts.userId) {
            const err = new Error('sw.auth.migrateAnon requires { anonId, userId }');
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          if (!DB) {
            const err = new Error('sw.auth.migrateAnon requires the project database. Call any sw.db.* method once first to provision it.');
            err.code = 'DB_NOT_PROVISIONED';
            throw err;
          }
          let tableList = Array.isArray(opts.tables) ? opts.tables.slice() : null;
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
            ).bind(opts.userId, opts.anonId).run();
            total += (r.meta && r.meta.changes) || 0;
          }
          return { migrated: total, tables: tableList };
        },
      };
    })(),

    jobs: {
      create(opts) {
        return platformJSON('/v1/jobs', {
          method: 'POST',
          body: JSON.stringify({ ...opts, project_id: projectId }),
        });
      },
      status(jobId) {
        return platformJSON('/v1/jobs/' + jobId);
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
      _send(level, message, data) {
        return platformFetch('/v1/logs', {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, level, message, data, source: 'function' }),
        }).catch(() => {});
      },
      debug(msg, data) { return this._send('debug', msg, data); },
      info(msg, data) { return this._send('info', msg, data); },
      warn(msg, data) { return this._send('warn', msg, data); },
      error(msg, data) { return this._send('error', msg, data); },
    },

    realtime: {
      // Publish an event to every subscriber on a channel. Returns
      // { channel, event, delivered }. event defaults to 'message'.
      publish(channel, data, opts) {
        opts = opts || {};
        return platformJSON('/v1/realtime/publish', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            channel,
            event: opts.event,
            data,
            from: opts.from,
          }),
        });
      },
      // Wait for the next event on a channel (server-side listener).
      // Used for webhook-style flows between functions. Returns the
      // envelope or null after timeout. Default timeout is 25 s.
      async subscribe(channel, opts) {
        opts = opts || {};
        const out = await platformJSON('/v1/realtime/wait', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            channel,
            timeout_ms: opts.timeout_ms,
            event: opts.event,
          }),
        });
        return out && out.data ? out.data.event : null;
      },
      // List active channels on this project (rows the platform has seen
      // in the last 10 minutes). Returns { channels: [...] }.
      channels() {
        return platformJSON('/v1/realtime/channels?project_id=' + encodeURIComponent(projectId));
      },
      // Legacy alias — same as publish but with the older { message }
      // envelope shape. Prefer publish() for new code.
      broadcast(channel, message, opts) {
        opts = opts || {};
        return platformJSON('/v1/realtime/channels/' + encodeURIComponent(channel) + '/broadcast', {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, message, from: opts.from }),
        });
      },
      meta(channel) {
        return platformJSON('/v1/realtime/channels/' + encodeURIComponent(channel) + '/meta?project_id=' + encodeURIComponent(projectId));
      },
    },

    analytics: {
      track(event, opts) {
        opts = opts || {};
        return platformJSON('/v1/analytics/track', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            event,
            user_id: opts.user_id,
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
          try { const j = await r.json(); if (j && j.message) msg = j.message; } catch { /* noop */ }
          const err = new Error(msg); err.status = r.status; throw err;
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
          try { const j = await r.json(); if (j && j.message) msg = j.message; } catch { /* noop */ }
          const err = new Error(msg); err.status = r.status; throw err;
        }
        return r;
      },
    },

    search: {
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

    inbox: {
      listAddresses() {
        return platformJSON('/v1/inbox/addresses?project_id=' + encodeURIComponent(projectId));
      },
      createAddress(opts) {
        opts = opts || {};
        // App-created mailboxes default to kind='app' so per-user inboxes
        // minted at runtime stay out of the dashboard Email tab. Pass
        // kind:'admin' explicitly to surface one there.
        const body = { kind: 'app', ...opts, project_id: projectId };
        return platformJSON('/v1/inbox/addresses', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      listAppAddresses() {
        return platformJSON('/v1/inbox/addresses?kind=app&project_id=' + encodeURIComponent(projectId));
      },
      deleteAddress(id) {
        return platformJSON('/v1/inbox/addresses/' + encodeURIComponent(id), { method: 'DELETE' });
      },
      list(opts) {
        opts = opts || {};
        const params = ['project_id=' + encodeURIComponent(projectId)];
        if (opts.address_id) params.push('address_id=' + encodeURIComponent(opts.address_id));
        if (opts.limit) params.push('limit=' + Number(opts.limit));
        if (opts.unread) params.push('unread=1');
        if (opts.q) params.push('q=' + encodeURIComponent(String(opts.q)));
        if (opts.include_spam) params.push('include_spam=1');
        return platformJSON('/v1/inbox?' + params.join('&'));
      },
      get(id, opts) {
        opts = opts || {};
        const qs = opts.include_html ? '?include=html' : '';
        return platformJSON('/v1/inbox/' + encodeURIComponent(id) + qs);
      },
      // Returns a Response — caller can stream/redirect/serve.
      // Use .arrayBuffer() / .blob() / .body to consume.
      raw(id) {
        return platformFetch('/v1/inbox/' + encodeURIComponent(id) + '/raw');
      },
      attachment(id, idx) {
        return platformFetch('/v1/inbox/' + encodeURIComponent(id) + '/attachments/' + Number(idx));
      },
      markRead(id, read) {
        const body = read === false ? { read: false } : { read: true };
        return platformJSON('/v1/inbox/' + encodeURIComponent(id) + '/read', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      },
      delete(id) {
        return platformJSON('/v1/inbox/' + encodeURIComponent(id), { method: 'DELETE' });
      },
      reply(id, opts) {
        opts = opts || {};
        return platformJSON('/v1/inbox/' + encodeURIComponent(id) + '/reply', {
          method: 'POST',
          body: JSON.stringify(opts),
        });
      },
      send(addressId, opts) {
        // Compose new — addressId is one of sw.inbox.listAddresses().
        // opts: { to, subject, body | text | html }
        opts = opts || {};
        return platformJSON('/v1/inbox/addresses/' + encodeURIComponent(addressId) + '/send', {
          method: 'POST',
          body: JSON.stringify(opts),
        });
      },
      threads(opts) {
        opts = opts || {};
        const params = ['project_id=' + encodeURIComponent(projectId)];
        if (opts.address_id) params.push('address_id=' + encodeURIComponent(opts.address_id));
        if (opts.limit) params.push('limit=' + Number(opts.limit));
        if (opts.include_spam) params.push('include_spam=1');
        return platformJSON('/v1/inbox/threads?' + params.join('&'));
      },
      thread(root) {
        return platformJSON('/v1/inbox/threads/by-root?project_id=' +
          encodeURIComponent(projectId) + '&root=' + encodeURIComponent(root));
      },
      rules: {
        list(opts) {
          opts = opts || {};
          const params = ['project_id=' + encodeURIComponent(projectId)];
          if (opts.address_id) params.push('address_id=' + encodeURIComponent(opts.address_id));
          return platformJSON('/v1/inbox/rules?' + params.join('&'));
        },
        create(opts) {
          opts = opts || {};
          return platformJSON('/v1/inbox/rules', {
            method: 'POST',
            body: JSON.stringify({ ...opts, project_id: projectId }),
          });
        },
        delete(id) {
          return platformJSON('/v1/inbox/rules/' + encodeURIComponent(id), { method: 'DELETE' });
        },
      },
    },

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
        // { connected, account_id, scope, status, connected_at }
        status() {
          return platformJSON('/v1/connect/stripe/status?project_id=' + encodeURIComponent(projectId));
        },
        // { data: [{ email, tier, status, current_period_end, ... }], next_cursor }
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

    payments: {
      onboard(opts) {
        opts = opts || {};
        return platformJSON('/v1/payments/onboard', {
          method: 'POST',
          body: JSON.stringify(opts),
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
      checkoutForUser(userId, opts) {
        opts = opts || {};
        if (!userId) {
          const err = new Error('sw.payments.checkoutForUser: userId is required');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        if (!opts.plan) {
          const err = new Error('sw.payments.checkoutForUser: opts.plan is required');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        const metadata = {
          ...(opts.metadata || {}),
          app_user_id: String(userId),
          plan: String(opts.plan),
        };
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
      events(opts) {
        opts = opts || {};
        const params = new URLSearchParams({ project_id: projectId });
        if (opts.limit) params.set('limit', String(opts.limit));
        if (opts.before) params.set('before', String(opts.before));
        if (opts.type) params.set('type', opts.type);
        return platformJSON('/v1/payments/events?' + params.toString());
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

    rateLimit: {
      // sw.rateLimit.check(key, max, windowSeconds) → { allowed, remaining, reset, ... }
      // Fixed-window counter, scoped per (project, key). On allowed=false the
      // caller should return 429.
      check(key, max, windowSeconds) {
        return platformJSON('/v1/rate-limit/check', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            key,
            max,
            window_seconds: windowSeconds,
          }),
        });
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
      const TABLE_SQL = "CREATE TABLE IF NOT EXISTS _notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, body TEXT, url TEXT, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_notifications_user ON _notifications(user_id, created_at DESC);";
      let ensured = false;
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
              await ensureTable();
              const id = 'ntf_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
              await DB.prepare(
                'INSERT INTO _notifications (id, user_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
              ).bind(id, String(userId), title, body, url, Date.now()).run();
              results.bell = { id, ok: true };
            } catch (err) {
              results.bell = { ok: false, error: err && err.message ? err.message : 'bell write failed' };
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

        // Bell-only read helpers — list / mark read / unread count.
        async list(userId, opts) {
          opts = opts || {};
          if (!userId) return { notifications: [], count: 0 };
          await ensureTable();
          const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
          const where = opts.unread_only ? 'WHERE user_id = ? AND read = 0' : 'WHERE user_id = ?';
          const r = await DB.prepare(
            'SELECT id, title, body, url, read, created_at FROM _notifications ' + where + ' ORDER BY created_at DESC LIMIT ?'
          ).bind(String(userId), limit).all();
          return { notifications: r.results || [], count: (r.results || []).length };
        },
        async unreadCount(userId) {
          if (!userId) return 0;
          await ensureTable();
          const r = await DB.prepare(
            'SELECT COUNT(*) AS n FROM _notifications WHERE user_id = ? AND read = 0'
          ).bind(String(userId)).first();
          return r && typeof r.n === 'number' ? r.n : 0;
        },
        async markRead(notificationId) {
          if (!notificationId) return { ok: false, error: 'notificationId required' };
          await ensureTable();
          const res = await DB.prepare(
            'UPDATE _notifications SET read = 1 WHERE id = ?'
          ).bind(String(notificationId)).run();
          return { ok: true, changes: (res.meta && res.meta.changes) || 0 };
        },
        async markAllRead(userId) {
          if (!userId) return { ok: false, error: 'userId required' };
          await ensureTable();
          const res = await DB.prepare(
            'UPDATE _notifications SET read = 1 WHERE user_id = ? AND read = 0'
          ).bind(String(userId)).run();
          return { ok: true, changes: (res.meta && res.meta.changes) || 0 };
        },
      };
    })(),

    push: {
      // sw.push.vapidPublicKey() → { vapid_public_key }
      // The browser passes vapid_public_key to PushManager.subscribe().
      vapidPublicKey() {
        return platformJSON('/v1/push/vapid-public-key?project_id=' + encodeURIComponent(projectId));
      },
      // sw.push.subscribe({ subscription, user_id? })
      // Persists the subscription object the browser handed back from
      // PushManager.subscribe().
      subscribe(opts) {
        opts = opts || {};
        return platformJSON('/v1/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            subscription: opts.subscription,
            user_id: opts.user_id ?? opts.userId,
          }),
        });
      },
      // sw.push.unsubscribe({ endpoint })
      unsubscribe(opts) {
        opts = opts || {};
        return platformJSON('/v1/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            endpoint: opts.endpoint,
          }),
        });
      },
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
    },
  };
  // sw and ctx are aliases — same object, both names work forever.
  sw.sw = sw;
  sw.ctx = sw;
  return sw;
}

export { buildPlatformContext };
