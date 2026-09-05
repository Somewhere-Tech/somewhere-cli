import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

export type BrowserSequenceAction =
  | { click: string }
  | { fill: string; value: string }
  | { upload: string; file: string; name: string }
  | { select: string; value: string }
  | { wait: string | number | { selector: string } }
  | { expect: { selector: string; text?: string; value?: string; visible?: boolean; count?: number } }
  | { screenshot: string }
  | { eval: string };

export interface ExpectedBrowserRequest {
  path: string;
  status: number;
}

export interface BrowserRequestExpectationResult extends ExpectedBrowserRequest {
  ok: boolean;
  error?: string;
}

const ACTION_KEYS = ['click', 'fill', 'upload', 'select', 'wait', 'expect', 'screenshot', 'eval'] as const;
export const MAX_BROWSER_UPLOAD_BYTES = 10 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
};

interface BrowserUpload {
  file: string;
  name: string;
}

function decodedBase64Bytes(base64: string): number | null {
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function inlineBrowserUpload(raw: string): BrowserUpload | null {
  const dataUrl = /^data:([^;,]+)?(?:;name=([^;,]+))?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(raw);
  const base64 = dataUrl ? dataUrl[3] : raw;
  const bytes = decodedBase64Bytes(base64);
  if (bytes === null) return null;
  if (bytes > MAX_BROWSER_UPLOAD_BYTES) {
    throw new Error(`BROWSER_UPLOAD_TOO_LARGE: Upload file is ${bytes} bytes; the browser upload limit is ${MAX_BROWSER_UPLOAD_BYTES} bytes (10 MB).`);
  }
  let name = 'upload.bin';
  if (dataUrl?.[2]) {
    try {
      name = decodeURIComponent(dataUrl[2]);
    } catch {
      throw new Error('upload data URL has a malformed filename.');
    }
    if (!name.trim()) throw new Error('upload data URL has an empty filename.');
  }
  const contentType = dataUrl?.[1] || 'application/octet-stream';
  return { file: dataUrl ? raw : `data:${contentType};base64,${base64}`, name };
}

/** Resolve the CLI-only local path form into the platform's byte-bearing form. */
export function resolveBrowserUpload(raw: string, baseDir = process.cwd()): BrowserUpload {
  if (!raw) throw new Error('upload needs a local file path, data URL, or base64 value.');
  if (raw.startsWith('data:')) {
    const inline = inlineBrowserUpload(raw);
    if (!inline) throw new Error('upload data URL must contain valid base64 bytes.');
    return inline;
  }

  const absolute = resolve(baseDir, raw);
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(absolute);
  } catch {
    const inline = inlineBrowserUpload(raw);
    if (inline) return inline;
    throw new Error(`upload file is not readable: ${absolute}`);
  }
  if (!stat.isFile()) throw new Error(`upload path is not a regular file: ${absolute}`);
  if (stat.size > MAX_BROWSER_UPLOAD_BYTES) {
    throw new Error(`BROWSER_UPLOAD_TOO_LARGE: Upload file is ${stat.size} bytes; the browser upload limit is ${MAX_BROWSER_UPLOAD_BYTES} bytes (10 MB).`);
  }
  const name = basename(absolute);
  const contentType = MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
  const bytes = readFileSync(absolute);
  if (bytes.length > MAX_BROWSER_UPLOAD_BYTES) {
    throw new Error(`BROWSER_UPLOAD_TOO_LARGE: Upload file is ${bytes.length} bytes; the browser upload limit is ${MAX_BROWSER_UPLOAD_BYTES} bytes (10 MB).`);
  }
  return { file: `data:${contentType};base64,${bytes.toString('base64')}`, name };
}

export function normalizeBrowserActions(raw: unknown, baseDir = process.cwd()):
  | { ok: true; actions: BrowserSequenceAction[] }
  | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'actions must be a JSON array.' };
  if (raw.length > 30) return { ok: false, error: `actions has ${raw.length} items; max is 30.` };
  const actions: BrowserSequenceAction[] = [];
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    const at = `action ${index}`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `${at}: expected an object such as {"click":"#save"}.` };
    }
    const record = value as Record<string, unknown>;
    const keys = ACTION_KEYS.filter((key) => record[key] !== undefined);
    if (keys.length !== 1) return { ok: false, error: `${at}: provide exactly one of ${ACTION_KEYS.join(', ')}.` };
    const key = keys[0];
    const actionValue = record[key];
    if (key === 'click') {
      if (typeof actionValue !== 'string' || !actionValue) return { ok: false, error: `${at}: click must be a non-empty CSS selector.` };
      actions.push({ click: actionValue });
      continue;
    }
    if (key === 'fill' || key === 'select') {
      if (typeof actionValue !== 'string' || !actionValue) return { ok: false, error: `${at}: ${key} must be a non-empty CSS selector.` };
      if (typeof record.value !== 'string') return { ok: false, error: `${at}: ${key} needs a string value.` };
      actions.push(key === 'fill'
        ? { fill: actionValue, value: record.value }
        : { select: actionValue, value: record.value });
      continue;
    }
    if (key === 'upload') {
      if (typeof actionValue !== 'string' || !actionValue) return { ok: false, error: `${at}: upload must be a non-empty CSS selector.` };
      if (typeof record.file !== 'string' || !record.file) return { ok: false, error: `${at}: upload needs a local file path, data URL, or base64 value in "file".` };
      try {
        const upload = resolveBrowserUpload(record.file, baseDir);
        if (record.name !== undefined && (typeof record.name !== 'string' || !record.name.trim())) {
          return { ok: false, error: `${at}: upload.name must be a non-empty filename when provided.` };
        }
        actions.push({
          upload: actionValue,
          file: upload.file,
          name: typeof record.name === 'string' ? record.name.trim() : upload.name,
        });
      } catch (err) {
        return { ok: false, error: `${at}: ${err instanceof Error ? err.message : String(err)}` };
      }
      continue;
    }
    if (key === 'wait') {
      if (typeof actionValue === 'string' && actionValue) actions.push({ wait: actionValue });
      else if (typeof actionValue === 'number' && Number.isFinite(actionValue) && actionValue >= 0) actions.push({ wait: actionValue });
      else if (actionValue && typeof actionValue === 'object' && !Array.isArray(actionValue)
        && typeof (actionValue as Record<string, unknown>).selector === 'string'
        && (actionValue as Record<string, unknown>).selector) {
        actions.push({ wait: { selector: (actionValue as Record<string, string>).selector } });
      } else return { ok: false, error: `${at}: wait must be a CSS selector string, { "selector": "#ready" }, or non-negative milliseconds number.` };
      continue;
    }
    if (key === 'eval') {
      if (typeof actionValue !== 'string' || !actionValue) return { ok: false, error: `${at}: eval must be a non-empty JavaScript string.` };
      actions.push({ eval: actionValue });
      continue;
    }
    if (key === 'screenshot') {
      if (typeof actionValue !== 'string' || !actionValue.trim()) return { ok: false, error: `${at}: screenshot must be a non-empty label.` };
      actions.push({ screenshot: actionValue.trim() });
      continue;
    }
    if (!actionValue || typeof actionValue !== 'object' || Array.isArray(actionValue)) {
      return { ok: false, error: `${at}: expect must be an object.` };
    }
    const expectation = actionValue as Record<string, unknown>;
    if (typeof expectation.selector !== 'string' || !expectation.selector) {
      return { ok: false, error: `${at}: expect needs a non-empty selector.` };
    }
    const hasText = typeof expectation.text === 'string';
    const hasValue = typeof expectation.value === 'string';
    const hasVisible = typeof expectation.visible === 'boolean';
    const hasCount = typeof expectation.count === 'number'
      && Number.isInteger(expectation.count)
      && expectation.count >= 0;
    if (!hasText && !hasValue && !hasVisible && !hasCount) {
      return { ok: false, error: `${at}: expect needs text, value, visible, or count.` };
    }
    if (expectation.text !== undefined && !hasText) return { ok: false, error: `${at}: expect.text must be a string.` };
    if (expectation.value !== undefined && !hasValue) return { ok: false, error: `${at}: expect.value must be a string.` };
    if (expectation.visible !== undefined && !hasVisible) return { ok: false, error: `${at}: expect.visible must be boolean.` };
    if (expectation.count !== undefined && !hasCount) return { ok: false, error: `${at}: expect.count must be a non-negative integer.` };
    actions.push({
      expect: {
        selector: expectation.selector,
        ...(hasText ? { text: expectation.text as string } : {}),
        ...(hasValue ? { value: expectation.value as string } : {}),
        ...(hasVisible ? { visible: expectation.visible as boolean } : {}),
        ...(hasCount ? { count: expectation.count as number } : {}),
      },
    });
  }
  return { ok: true, actions };
}

function splitSelectorValue(raw: string, flag: '--fill' | '--select'): { selector: string; value: string } {
  const at = raw.indexOf('=');
  if (at <= 0) throw new Error(`${flag} expects <selector>=<value> (for example ${flag} '#email=a@b.co').`);
  return { selector: raw.slice(0, at), value: raw.slice(at + 1) };
}

const UPLOAD_USAGE =
  "--upload expects <selector>=<file> (for example --upload '#avatar=./photo.png'). " +
  'The selector may contain "=", because the file path is taken from the LAST "=". ' +
  "If the PATH itself contains \"=\", use the explicit form <selector>::<file> instead.";

/**
 * Upload mappings are split at the LAST `=`, not the first.
 *
 * A CSS attribute selector carries its own equals sign — `[data-testid=file]` —
 * so first-`=` splitting cut real selectors in half and then tried to open the
 * remainder as a path. The right-hand side of an upload mapping is always a
 * file path, and paths rarely contain `=`, so the last `=` is the reliable
 * boundary; `#avatar=./photo.png` is unaffected because its only `=` is also
 * its last one.
 *
 * `<selector>::<file>` is the explicit form for the remaining ambiguity (a path
 * that really does contain `=`). When `::` is present it wins and the split is
 * at the FIRST `::`. The only selectors that lose are pseudo-ELEMENTS
 * (`input::-webkit-file-upload-button`), which can never be an upload target —
 * a file attaches to the `<input type="file">` itself. Pseudo-CLASSES use a
 * single colon (`input:not([disabled])`) and are unaffected.
 *
 * --fill and --select keep first-`=` splitting: their values routinely contain
 * `=` (query strings, base64, tokens), which is the opposite trade-off.
 */
export function splitUploadMapping(raw: string): { selector: string; value: string } {
  const explicit = raw.indexOf('::');
  if (explicit > 0) {
    const selector = raw.slice(0, explicit);
    const value = raw.slice(explicit + 2);
    if (!selector || !value) throw new Error(UPLOAD_USAGE);
    return { selector, value };
  }
  const at = raw.lastIndexOf('=');
  if (at <= 0 || at === raw.length - 1) throw new Error(UPLOAD_USAGE);
  return { selector: raw.slice(0, at), value: raw.slice(at + 1) };
}

export function parseFillFlag(raw: string): BrowserSequenceAction {
  const parsed = splitSelectorValue(raw, '--fill');
  return { fill: parsed.selector, value: parsed.value };
}

export function parseSelectFlag(raw: string): BrowserSequenceAction {
  const parsed = splitSelectorValue(raw, '--select');
  return { select: parsed.selector, value: parsed.value };
}

export function parseUploadFlag(raw: string, baseDir = process.cwd()): BrowserSequenceAction {
  const parsed = splitUploadMapping(raw);
  const upload = resolveBrowserUpload(parsed.value, baseDir);
  return { upload: parsed.selector, file: upload.file, name: upload.name };
}

export function parseExpectFlag(raw: string): BrowserSequenceAction {
  const match = raw.match(/^(.*):(text|value|visible|count)=(.*)$/s);
  if (!match || !match[1]) {
    throw new Error("--expect expects <selector>:text=<substring>, :value=<exact value>, :visible=true|false, or :count=<n>.");
  }
  const [, selector, kind, rawValue] = match;
  if (kind === 'text') return { expect: { selector, text: rawValue } };
  if (kind === 'value') return { expect: { selector, value: rawValue } };
  if (kind === 'visible') {
    if (rawValue !== 'true' && rawValue !== 'false') throw new Error('--expect visible must be true or false.');
    return { expect: { selector, visible: rawValue === 'true' } };
  }
  const count = Number(rawValue);
  if (!Number.isInteger(count) || count < 0) throw new Error('--expect count must be a non-negative integer.');
  return { expect: { selector, count } };
}

export function parseExpectedRequestFlag(raw: string): ExpectedBrowserRequest {
  const at = raw.lastIndexOf(':');
  if (at <= 0) throw new Error("--expect-request expects <path>:<status> (for example '/api/tasks:401').");
  const path = raw.slice(0, at);
  const status = Number(raw.slice(at + 1));
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('--expect-request status must be an integer from 100 through 599.');
  }
  return { path, status };
}

export function actionLabel(action: BrowserSequenceAction): string {
  if ('click' in action) return 'click';
  if ('fill' in action) return 'fill';
  if ('upload' in action) return 'upload';
  if ('select' in action) return 'select';
  if ('wait' in action) return 'wait';
  if ('expect' in action) return 'expect';
  if ('screenshot' in action) return 'screenshot';
  return 'eval';
}

export function matchesExpectedBrowserRequest(
  request: { url?: string; status?: number },
  expected: readonly ExpectedBrowserRequest[],
): boolean {
  return typeof request.url === 'string'
    && typeof request.status === 'number'
    && expected.some((item) => request.status === item.status && request.url?.includes(item.path));
}

export function resolveBrowserRequestExpectations(
  expected: readonly ExpectedBrowserRequest[],
  responses: readonly { url: string; status: number }[],
): BrowserRequestExpectationResult[] {
  return expected.map((item) => {
    if (responses.some((response) => response.status === item.status && response.url.includes(item.path))) {
      return { ...item, ok: true };
    }
    const seen = responses.filter((response) => response.url.includes(item.path)).map((response) => response.status);
    return {
      ...item,
      ok: false,
      error: seen.length
        ? `Expected ${item.path} to return ${item.status}; saw ${[...new Set(seen)].join(', ')}.`
        : `Expected a request containing ${item.path} with status ${item.status}; no matching request was observed.`,
    };
  });
}
