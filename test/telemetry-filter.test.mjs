import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  installTelemetryFilter,
  isPlatformTelemetry,
  telemetryVisible,
  TELEMETRY_ENV,
} from '../dist/local/telemetry-filter.js';

// The exact lines the vendored runtime printed into a developer's terminal
// during the 0.30.0 journey (tsk_eef0a0ef), copied verbatim.
const OBSERVATION_403 = '[SW_QUERY_OBSERVATIONS] deferred flush failed: HTTP 403';
const FIRST_TOUCH =
  '[SW_DB_FIRST_TOUCH] {"event":"SW_DB_FIRST_TOUCH","operation":"sw.db.query","total_ms":437,' +
  '"engine_ms":0.351,"engine_duration_complete":true,"non_engine_ms":436.649,' +
  '"non_engine_includes":"activation, placement, transport, queueing, binding, and elapsed backoff",' +
  '"execution_path":"rest","edge_region":null,"database_region":"WNAM","retry_count":0,' +
  '"retry_backoff_requested_ms":0,"statement_kind":"SELECT"}';
const NON_ENGINE =
  '[SW_DB_NON_ENGINE_LATENCY] {"event":"SW_DB_NON_ENGINE_LATENCY","operation":"sw.db.insert","total_ms":733}';
const QUERY_LINE =
  '{"event":"SW_QUERY","fp":"4326610aafd8033b","op":"insert","table":"metrics","fn":null,"ms":733,"rows":1,"ok":true}';

test('every telemetry line the runtime emitted is recognised as ours', () => {
  for (const line of [OBSERVATION_403, FIRST_TOUCH, NON_ENGINE, QUERY_LINE]) {
    assert.equal(isPlatformTelemetry([line]), true, line.slice(0, 40));
  }
  // The slow-query and unattributed-latency events take the same shape and are
  // matched by shape, not by an enumerated name — a re-vendor that adds an
  // event must not silently start leaking again.
  assert.equal(
    isPlatformTelemetry(['[SW_A_BRAND_NEW_EVENT] {"event":"SW_A_BRAND_NEW_EVENT","x":1}']),
    true,
  );
});

test("the developer's own output is never mistaken for ours", () => {
  const mine = [
    'hello',
    '',
    'GET /api/todos 200',
    '{"event":"user_signed_up","id":7}',
    '{"totally":"ordinary json"}',
    'not json at all {',
    '[SW_QUERY] this is my own string, not our JSON line',
    '[MY_APP] {"event":"MY_APP"}',
  ];
  for (const line of mine) {
    assert.equal(isPlatformTelemetry([line]), false, line);
  }
  // Objects, errors and multi-argument logs are the app's, always.
  assert.equal(isPlatformTelemetry([{ event: 'SW_QUERY' }]), false);
  assert.equal(isPlatformTelemetry([new Error('boom')]), false);
  assert.equal(isPlatformTelemetry([]), false);
});

test('a bracketed line whose JSON names a DIFFERENT event is not ours', () => {
  // The pairing is the signal. A developer echoing one of our prefixes over
  // their own payload keeps their line.
  assert.equal(isPlatformTelemetry(['[SW_DB_FIRST_TOUCH] {"event":"my_own_event"}']), false);
});

test('the filter silences the platform channel and passes the app through', () => {
  const seen = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a) => seen.push(['log', ...a]);
  console.warn = (...a) => seen.push(['warn', ...a]);
  const restore = installTelemetryFilter({});
  try {
    console.warn(OBSERVATION_403);
    console.warn(FIRST_TOUCH);
    console.log(QUERY_LINE);
    console.log('todo created', { id: 1 });
    console.warn('your handler returned undefined');
  } finally {
    restore();
    console.log = realLog;
    console.warn = realWarn;
  }
  assert.deepEqual(seen, [
    ['log', 'todo created', { id: 1 }],
    ['warn', 'your handler returned undefined'],
  ]);
});

test('the opt-in prints every line through untouched', () => {
  assert.equal(telemetryVisible({}), false);
  assert.equal(telemetryVisible({ [TELEMETRY_ENV]: '0' }), false);
  assert.equal(telemetryVisible({ [TELEMETRY_ENV]: 'false' }), false);
  assert.equal(telemetryVisible({ [TELEMETRY_ENV]: '' }), false);
  assert.equal(telemetryVisible({ [TELEMETRY_ENV]: '1' }), true);

  const seen = [];
  const realWarn = console.warn;
  console.warn = (...a) => seen.push(a);
  const restore = installTelemetryFilter({ [TELEMETRY_ENV]: '1' });
  try {
    console.warn(OBSERVATION_403);
  } finally {
    restore();
    console.warn = realWarn;
  }
  assert.deepEqual(seen, [[OBSERVATION_403]]);
});
