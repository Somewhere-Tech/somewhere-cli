import test from 'node:test';
import assert from 'node:assert/strict';
import { main as swpxMain } from '../dist/swpx-bin.js';
import { main as swpmMain } from '../dist/swpm-bin.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function capture() {
  const out = [];
  const err = [];
  return {
    log: (s) => out.push(s),
    errLog: (s) => err.push(s),
    pollVerdictSummary: async () => null,
    outText: () => strip(out.join('\n')),
    errText: () => strip(err.join('\n')),
  };
}
function spyRun(code = 0) {
  const calls = [];
  const fn = async (cmd, args) => (calls.push({ cmd, args }), code);
  fn.calls = calls;
  return fn;
}

test('swpx-bin — `check` routes to inspection (no run) with --json', async () => {
  const cap = capture();
  const runReal = spyRun();
  const code = await swpxMain(['check', 'foo', '--json'], {
    ...cap,
    runReal,
    resolveVersion: async () => '2.1.0',
    getVerdict: async () => ({ package: 'foo', version: '2.1.0', verdict: 'unverified', has_provenance: false }),
  });
  assert.equal(code, 1); // unverified
  assert.equal(runReal.calls.length, 0); // check never runs the package
  assert.equal(JSON.parse(cap.outText()).verdict, 'unverified');
});

test('swpx-bin — a bare package routes to run (verified → npx)', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const code = await swpxMain(['create-next-app', 'my-app'], {
    ...cap,
    runReal,
    resolveVersion: async () => '15.2.0',
    getVerdict: async () => ({ package: 'create-next-app', version: '15.2.0', verdict: 'verified' }),
  });
  assert.equal(code, 0);
  assert.deepEqual(runReal.calls, [{ cmd: 'npx', args: ['create-next-app', 'my-app'] }]);
});

test('swpx-bin — `check` with no package exits 3', async () => {
  const cap = capture();
  const code = await swpxMain(['check'], { ...cap, runReal: spyRun() });
  assert.equal(code, 3);
  assert.match(cap.errText(), /Usage: somewhere check/);
});

test('swpm-bin — forwards argv to the npm gate (non-install passthrough)', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const code = await swpmMain(['run', 'build'], { ...cap, runReal });
  assert.equal(code, 0);
  assert.deepEqual(runReal.calls, [{ cmd: 'npm', args: ['run', 'build'] }]);
});
