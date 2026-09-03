export type BrowserSequenceAction =
  | { click: string }
  | { fill: string; value: string }
  | { select: string; value: string }
  | { wait: string | number }
  | { expect: { selector: string; text?: string; value?: string; visible?: boolean; count?: number } }
  | { eval: string };

export interface ExpectedBrowserRequest {
  path: string;
  status: number;
}

export interface BrowserRequestExpectationResult extends ExpectedBrowserRequest {
  ok: boolean;
  error?: string;
}

const ACTION_KEYS = ['click', 'fill', 'select', 'wait', 'expect', 'eval'] as const;

export function normalizeBrowserActions(raw: unknown):
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
    if (key === 'wait') {
      if (typeof actionValue === 'string' && actionValue) actions.push({ wait: actionValue });
      else if (typeof actionValue === 'number' && Number.isFinite(actionValue) && actionValue >= 0) actions.push({ wait: actionValue });
      else return { ok: false, error: `${at}: wait must be a CSS selector string or non-negative milliseconds number.` };
      continue;
    }
    if (key === 'eval') {
      if (typeof actionValue !== 'string' || !actionValue) return { ok: false, error: `${at}: eval must be a non-empty JavaScript string.` };
      actions.push({ eval: actionValue });
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

export function parseFillFlag(raw: string): BrowserSequenceAction {
  const parsed = splitSelectorValue(raw, '--fill');
  return { fill: parsed.selector, value: parsed.value };
}

export function parseSelectFlag(raw: string): BrowserSequenceAction {
  const parsed = splitSelectorValue(raw, '--select');
  return { select: parsed.selector, value: parsed.value };
}

export function parseExpectFlag(raw: string): BrowserSequenceAction {
  const match = raw.match(/^(.*):(text|visible|count)=(.*)$/s);
  if (!match || !match[1]) {
    throw new Error("--expect expects <selector>:text=<substring>, :visible=true|false, or :count=<n>.");
  }
  const [, selector, kind, rawValue] = match;
  if (kind === 'text') return { expect: { selector, text: rawValue } };
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
  if ('select' in action) return 'select';
  if ('wait' in action) return 'wait';
  if ('expect' in action) return 'expect';
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
