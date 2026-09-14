// Captured from the worker's pure POST /v1/deploy/check/run validator:
// tech/worker/src/utils/check-oracle.ts validateCheckRunInput, which delegates
// request normalization to draft-invoke.ts validateInvokeInput. Source commit:
// 0c46d628e005558ceac9842563635346a0639355.
//
// This fixture lives with the published CLI so its boundary test remains
// hermetic. Keep it byte-semantically aligned with that server validator when
// the endpoint contract changes.

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const DEFAULT_INVOKE_TIMEOUT_MS = 10_000;
const MAX_INVOKE_TIMEOUT_MS = 30_000;

function normalizeSourceMap(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    return `${field} must be an object mapping file paths to content.`;
  }
  const out = {};
  for (const [path, source] of Object.entries(value)) {
    if (typeof source !== 'string') return `${field}[${JSON.stringify(path)}] must be a string of source code.`;
    out[path] = source;
  }
  return out;
}

function validateInvokeInput(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'JSON body required.' };
  if (typeof body.project_id !== 'string' || !body.project_id) {
    return { ok: false, error: 'project_id is required.' };
  }
  const path = body.path === undefined || body.path === null ? '/' : body.path;
  if (typeof path !== 'string') return { ok: false, error: 'path must be a string.' };
  const method = (typeof body.method === 'string' && body.method ? body.method : 'GET').toUpperCase();
  if (!VALID_METHODS.has(method)) return { ok: false, error: 'invalid method.' };
  if (typeof body.body === 'string' && body.body.length > 256 * 1024) {
    return { ok: false, error: 'body exceeds the 256KB invoke limit.' };
  }
  const timeoutRaw = Number(body.timeout_ms);
  const timeout_ms = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.min(Math.floor(timeoutRaw), MAX_INVOKE_TIMEOUT_MS)
    : DEFAULT_INVOKE_TIMEOUT_MS;
  return {
    ok: true,
    value: {
      project_id: body.project_id,
      path,
      method,
      headers: undefined,
      body: body.body,
      timeout_ms,
    },
  };
}

export function validateCheckRunInput(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'JSON body required.' };
  const functions = normalizeSourceMap(body.functions, 'functions');
  if (typeof functions === 'string') return { ok: false, error: functions };
  if (Object.keys(functions).length === 0) return { ok: false, error: 'handler source required.' };
  const spec = validateInvokeInput(body);
  if (!spec.ok) return spec;
  return {
    ok: true,
    value: {
      project_id: spec.value.project_id,
      functions,
      path: spec.value.path,
      method: spec.value.method,
      headers: spec.value.headers,
      body: spec.value.body,
      timeout_ms: spec.value.timeout_ms,
    },
  };
}
