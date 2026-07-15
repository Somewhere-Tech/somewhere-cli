import test from 'node:test';
import assert from 'node:assert/strict';
import { runSwpx } from '../dist/swpx/run-swpx.js';
import { runSwpm } from '../dist/swpx/run-swpm.js';
import { runCheck } from '../dist/swpx/check.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A spy for the real-tool launcher: records calls, returns a fixed exit code.
function spyRun(code = 0) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    return code;
  };
  fn.calls = calls;
  return fn;
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (s) => out.push(s),
    errLog: (s) => err.push(s),
    pollVerdictSummary: async () => null,
    outText: () => strip(out.join('\n')),
    errText: () => strip(err.join('\n')),
  };
}

const VERIFIED = {
  package: 'create-next-app',
  version: '15.2.0',
  verdict: 'verified',
  capabilities: ['network', 'fs', 'child_process'],
  description: 'Create Next.js apps',
  description_match: 'match',
  summary: 'Established package with readable source.',
};
const BLOCKED = {
  package: '@ctrl/tinycolor',
  version: '4.1.1',
  verdict: 'blocked',
  mal: [{ id: 'MAL-2025-09-384', summary: 'credential-harvesting via preinstall hook' }],
};
const UNVERIFIED = {
  package: 'foo',
  version: '2.1.0',
  verdict: 'unverified',
  has_provenance: false,
  is_minified: true,
  summary: 'The source is minified and has no provenance.',
};

// ---------------- swpx ----------------

test('swpx — verified delegates to npx with original args', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['create-next-app', 'my-app'], {
    ...cap,
    resolveVersion: async () => '15.2.0',
    getVerdict: async () => VERIFIED,
    runReal,
  });
  assert.equal(r.action, 'ran');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(runReal.calls, [{ cmd: 'npx', args: ['create-next-app', 'my-app'] }]);
  assert.match(cap.errText(), /^✓ create-next-app@15\.2\.0/);
});

test('swpx — blocked refuses, never runs npx', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['@ctrl/tinycolor@4.1.1'], {
    ...cap,
    resolveVersion: async () => '4.1.1',
    getVerdict: async () => BLOCKED,
    runReal,
  });
  assert.equal(r.action, 'blocked');
  assert.equal(r.exitCode, 1);
  assert.equal(runReal.calls.length, 0);
  assert.match(cap.errText(), /✖ @ctrl\/tinycolor@4\.1\.1/);
  assert.match(cap.errText(), /Confirmed malware\. Do not install\./);
});

test('swpx — unverified stops with evidence, never runs npx', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['foo'], {
    ...cap,
    resolveVersion: async () => '2.1.0',
    getVerdict: async () => UNVERIFIED,
    runReal,
  });
  assert.equal(r.action, 'stopped');
  assert.equal(r.exitCode, 1);
  assert.equal(runReal.calls.length, 0);
  assert.match(cap.errText(), /⚠ foo@2\.1\.0/);
  assert.match(cap.errText(), /✖ Minified \(unreadable\)/);
  assert.match(cap.errText(), /Run npx foo to proceed unverified\./);
});

test('swpx — verdict unavailable falls back to npx (gate not wall)', async () => {
  const cap = capture();
  const runReal = spyRun(7);
  const r = await runSwpx(['foo'], {
    ...cap,
    resolveVersion: async () => '2.1.0',
    getVerdict: async () => {
      throw new Error('down');
    },
    runReal,
  });
  assert.equal(r.action, 'fallback');
  assert.equal(r.exitCode, 7); // passes the child's code through
  assert.deepEqual(runReal.calls, [{ cmd: 'npx', args: ['foo'] }]);
});

test('swpx — unresolvable name falls back to npx', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['ghost'], {
    ...cap,
    resolveVersion: async () => {
      throw new Error('404');
    },
    getVerdict: async () => VERIFIED,
    runReal,
  });
  assert.equal(r.action, 'fallback');
  assert.equal(runReal.calls.length, 1);
});

test('swpx — no package arg is a usage error', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx([], { ...cap, runReal });
  assert.equal(r.exitCode, 1);
  assert.equal(runReal.calls.length, 0);
  assert.match(cap.errText(), /Usage: swpx/);
});

test('swpx — polls and renders a pending LLM summary before running', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const polls = [];
  const r = await runSwpx(['foo'], {
    ...cap,
    resolveVersion: async () => '1.0.0',
    getVerdict: async () => ({ package: 'foo', version: '1.0.0', verdict: 'verified' }),
    pollVerdictSummary: async (name, version) => {
      polls.push([name, version]);
      return { package: name, version, verdict: 'verified', summary: 'The generated assessment is ready.' };
    },
    runReal,
  });
  assert.equal(r.action, 'ran');
  assert.deepEqual(polls, [['foo', '1.0.0']]);
  assert.match(cap.errText(), /Generating LLM summary…/);
  assert.match(cap.errText(), /The generated assessment is ready\./);
  assert.doesNotMatch(cap.errText(), /timed out/);
});

test('swpx — summary timeout falls back to raw verdict metadata', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['foo'], {
    ...cap,
    resolveVersion: async () => '1.0.0',
    getVerdict: async () => ({ package: 'foo', version: '1.0.0', verdict: 'verified' }),
    pollVerdictSummary: async () => null,
    runReal,
  });
  assert.equal(r.action, 'ran');
  assert.match(cap.errText(), /Generating LLM summary…/);
  assert.match(cap.errText(), /LLM summary timed out — continuing with raw verdict metadata\./);
  assert.deepEqual(runReal.calls, [{ cmd: 'npx', args: ['foo'] }]);
});

// ---------------- swpm ----------------

test('swpm — non-install passes straight through to npm', async () => {
  const runReal = spyRun(0);
  const r = await runSwpm(['run', 'build'], { ...capture(), runReal });
  assert.equal(r.action, 'passthrough');
  assert.deepEqual(runReal.calls, [{ cmd: 'npm', args: ['run', 'build'] }]);
});

test('swpm install — clean tree runs npm install', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpm(['install'], {
    ...cap,
    readTree: () => ({
      directNames: ['left-pad'],
      ranges: {},
      locked: [{ package: 'left-pad', version: '1.3.0' }],
    }),
    getVerdictBatch: async () => [{ package: 'left-pad', version: '1.3.0', verdict: 'verified' }],
    runReal,
  });
  assert.equal(r.action, 'ran');
  assert.deepEqual(runReal.calls, [{ cmd: 'npm', args: ['install'] }]);
  assert.match(cap.errText(), /✓ {2}1 verified/);
});

test('swpm install — a blocked package halts install (exit 1)', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpm(['install'], {
    ...cap,
    readTree: () => ({
      directNames: ['@ctrl/tinycolor'],
      ranges: {},
      locked: [{ package: '@ctrl/tinycolor', version: '4.1.1' }],
    }),
    getVerdictBatch: async () => [BLOCKED],
    runReal,
  });
  assert.equal(r.action, 'blocked');
  assert.equal(r.exitCode, 1);
  assert.equal(runReal.calls.length, 0);
  assert.match(cap.errText(), /✖ {2}1 blocked/);
  assert.match(cap.errText(), /Remove or replace blocked packages/);
});

test('swpm install — a missing verdict row counts as unverified, not verified', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpm(['install'], {
    ...cap,
    readTree: () => ({
      directNames: ['mystery'],
      ranges: {},
      locked: [{ package: 'mystery', version: '9.9.9' }],
    }),
    getVerdictBatch: async () => [], // service returned nothing for it
    runReal,
  });
  assert.equal(r.action, 'ran'); // unverified doesn't block install
  assert.match(cap.errText(), /⚠ {2}1 unverified/);
  assert.match(cap.errText(), /Generating LLM summary…/);
  assert.match(cap.errText(), /LLM summary timed out/);
});

test('swpm install — polls pending direct-package summaries and renders them', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const polls = [];
  const r = await runSwpm(['install', 'foo'], {
    ...cap,
    resolveVersion: async () => '1.0.0',
    getVerdictBatch: async () => [{ package: 'foo', version: '1.0.0', verdict: 'unverified' }],
    pollVerdictSummary: async (name, version) => {
      polls.push([name, version]);
      return { package: name, version, verdict: 'unverified', summary: 'Review this package before installing.' };
    },
    runReal,
  });
  assert.equal(r.action, 'ran');
  assert.deepEqual(polls, [['foo', '1.0.0']]);
  assert.match(cap.errText(), /Generating LLM summary…/);
  assert.match(cap.errText(), /Review this package before installing\./);
  assert.doesNotMatch(cap.errText(), /timed out/);
});

test('swpm install — polls and renders a pending summary for a verified direct package', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const polls = [];
  const r = await runSwpm(['install', 'cli-truncate@4.0.0'], {
    ...cap,
    resolveVersion: async () => '4.0.0',
    getVerdictBatch: async () => [{
      package: 'cli-truncate',
      version: '4.0.0',
      verdict: 'verified',
      summary: null,
    }],
    pollVerdictSummary: async (name, version) => {
      polls.push([name, version]);
      return {
        package: name,
        version,
        verdict: 'verified',
        summary: 'This verified package has a generated assessment.',
      };
    },
    runReal,
  });
  assert.equal(r.action, 'ran');
  assert.deepEqual(polls, [['cli-truncate', '4.0.0']]);
  assert.match(cap.errText(), /Generating LLM summary…/);
  assert.match(cap.errText(), /cli-truncate@4\.0\.0/);
  assert.match(cap.errText(), /This verified package has a generated assessment\./);
  assert.doesNotMatch(cap.errText(), /timed out/);
  assert.deepEqual(runReal.calls, [{ cmd: 'npm', args: ['install', 'cli-truncate@4.0.0'] }]);
});

test('swpm install — explicit packages are resolved and checked', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const seen = [];
  const r = await runSwpm(['install', 'foo@^1', 'bar'], {
    ...cap,
    resolveVersion: async (n, v) => {
      seen.push([n, v]);
      return n === 'foo' ? '1.5.0' : '2.0.0';
    },
    getVerdictBatch: async (pkgs) => pkgs.map((p) => ({ ...p, verdict: 'verified' })),
    runReal,
  });
  assert.equal(r.action, 'ran');
  assert.deepEqual(seen.sort(), [['bar', undefined], ['foo', '^1']]);
});

test('swpm install — batch unavailable falls back to npm', async () => {
  const cap = capture();
  const runReal = spyRun(3);
  const r = await runSwpm(['install'], {
    ...cap,
    readTree: () => ({ directNames: ['x'], ranges: {}, locked: [{ package: 'x', version: '1' }] }),
    getVerdictBatch: async () => {
      throw new Error('down');
    },
    runReal,
  });
  assert.equal(r.action, 'fallback');
  assert.equal(r.exitCode, 3);
  assert.deepEqual(runReal.calls, [{ cmd: 'npm', args: ['install'] }]);
});

test('swpm install — no deps passes through', async () => {
  const runReal = spyRun(0);
  const r = await runSwpm(['install'], {
    ...capture(),
    readTree: () => ({ directNames: [], ranges: {}, locked: [] }),
    runReal,
  });
  assert.equal(r.action, 'passthrough');
  assert.deepEqual(runReal.calls, [{ cmd: 'npm', args: ['install'] }]);
});

// ---------------- check ----------------

test('check — verified exits 0 and prints the green line', async () => {
  const cap = capture();
  const code = await runCheck('create-next-app', {}, {
    ...cap,
    resolveVersion: async () => '15.2.0',
    getVerdict: async () => VERIFIED,
  });
  assert.equal(code, 0);
  assert.match(cap.outText(), /^✓ create-next-app@15\.2\.0/);
});

test('check — blocked exits 2', async () => {
  const cap = capture();
  const code = await runCheck('@ctrl/tinycolor@4.1.1', {}, {
    ...cap,
    resolveVersion: async () => '4.1.1',
    getVerdict: async () => BLOCKED,
  });
  assert.equal(code, 2);
  assert.match(cap.outText(), /✖ @ctrl\/tinycolor@4\.1\.1/);
  assert.match(cap.outText(), /Confirmed malware\. Do not install\./);
});

test('check — unverified exits 1', async () => {
  const cap = capture();
  const code = await runCheck('foo', {}, {
    ...cap,
    resolveVersion: async () => '2.1.0',
    getVerdict: async () => UNVERIFIED,
  });
  assert.equal(code, 1);
});

test('check --json emits the stable signals projection', async () => {
  const cap = capture();
  const code = await runCheck('foo', { json: true }, {
    ...cap,
    resolveVersion: async () => '2.1.0',
    getVerdict: async () => ({
      ...UNVERIFIED,
      install_script_types: ['postinstall'],
      capabilities: ['network'],
    }),
  });
  assert.equal(code, 1);
  const parsed = JSON.parse(cap.outText());
  assert.equal(parsed.verdict, 'unverified');
  assert.equal(parsed.signals.provenance, false);
  assert.equal(parsed.signals.readable, false);
  assert.deepEqual(parsed.signals.install_scripts, ['postinstall']);
});

test('check — verdict unavailable exits 3', async () => {
  const cap = capture();
  const code = await runCheck('foo', {}, {
    ...cap,
    resolveVersion: async () => '2.1.0',
    getVerdict: async () => {
      throw new Error('down');
    },
  });
  assert.equal(code, 3);
});

test('check — no arg exits 3 with usage', async () => {
  const cap = capture();
  const code = await runCheck(undefined, {}, cap);
  assert.equal(code, 3);
  assert.match(cap.errText(), /Usage: somewhere check/);
});

// ---------------- enforce / loud fail-open ----------------

test('swpx — enforce + unavailable REFUSES (no run, exit 1, loud)', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['foo'], {
    ...cap, enforce: true,
    resolveVersion: async () => '1.0.0',
    getVerdict: async () => { throw new Error('down'); },
    runReal,
  });
  assert.equal(r.action, 'blocked');
  assert.equal(r.exitCode, 1);
  assert.equal(runReal.calls.length, 0);
  assert.match(cap.errText(), /COULD NOT VERIFY foo/);
  assert.match(cap.errText(), /Refusing/);
});

test('swpx — default + unavailable falls back with a LOUD warning', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['foo'], {
    ...cap, enforce: false,
    resolveVersion: async () => '1.0.0',
    getVerdict: async () => { throw new Error('The operation was aborted due to timeout'); },
    runReal,
  });
  assert.equal(r.action, 'fallback');
  assert.equal(runReal.calls.length, 1);
  assert.match(cap.errText(), /COULD NOT VERIFY foo/);
  // the underlying cause must be surfaced (a timeout vs an outage vs a 503) — not swallowed
  assert.match(cap.errText(), /Reason: The operation was aborted due to timeout/);
});

test('swpx — --enforce is stripped from the npx passthrough', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['--enforce', 'create-next-app', 'my-app'], {
    ...cap,
    resolveVersion: async () => '1',
    getVerdict: async () => ({ package: 'create-next-app', version: '1', verdict: 'verified' }),
    runReal,
  });
  assert.equal(r.action, 'ran');
  assert.deepEqual(runReal.calls, [{ cmd: 'npx', args: ['create-next-app', 'my-app'] }]);
});

test('swpm — enforce + tree-unavailable refuses (no npm)', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpm(['install'], {
    ...cap, enforce: true,
    readTree: () => ({ directNames: ['x'], ranges: {}, locked: [{ package: 'x', version: '1' }] }),
    getVerdictBatch: async () => { throw new Error('down'); },
    runReal,
  });
  assert.equal(r.action, 'blocked');
  assert.equal(r.exitCode, 1);
  assert.equal(runReal.calls.length, 0);
});

// ---------------- review hardening (fix/cli-review-hardening) ----------------

test('swpm — flags before the subcommand still gate (no silent passthrough)', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpm(['-g', 'install', '@ctrl/tinycolor@4.1.1'], {
    ...cap,
    resolveVersion: async () => '4.1.1',
    getVerdictBatch: async () => [BLOCKED],
    runReal,
  });
  assert.equal(r.action, 'blocked');
  assert.equal(runReal.calls.length, 0); // did NOT silently passthrough to npm
});

test('swpx — an unrecognized verdict level stops, never runs', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpx(['foo'], {
    ...cap,
    resolveVersion: async () => '1.0.0',
    getVerdict: async () => ({ package: 'foo', version: '1.0.0', verdict: 'quarantined' }),
    runReal,
  });
  assert.equal(r.action, 'stopped');
  assert.equal(runReal.calls.length, 0);
});

test('swpm — an unrecognized verdict level halts the install', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const r = await runSwpm(['install'], {
    ...cap,
    readTree: () => ({ directNames: ['x'], ranges: {}, locked: [{ package: 'x', version: '1' }] }),
    getVerdictBatch: async () => [{ package: 'x', version: '1', verdict: 'quarantined' }],
    runReal,
  });
  assert.equal(r.action, 'blocked');
  assert.equal(runReal.calls.length, 0);
});

test('swpx — grades the --package value, not the positional command', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  let graded;
  const r = await runSwpx(['--package=@ctrl/tinycolor@4.1.1', 'tinycolor'], {
    ...cap,
    resolveVersion: async () => '4.1.1',
    getVerdict: async (n) => {
      graded = n;
      return BLOCKED;
    },
    runReal,
  });
  assert.equal(graded, '@ctrl/tinycolor'); // graded the --package target, not "tinycolor"
  assert.equal(r.action, 'blocked');
  assert.equal(runReal.calls.length, 0);
});

test('swpm install — a dep added to package.json after the lockfile is still checked', async () => {
  const cap = capture();
  const runReal = spyRun(0);
  const checked = [];
  const r = await runSwpm(['install'], {
    ...cap,
    readTree: () => ({
      directNames: ['locked-dep', 'new-dep'],
      ranges: { 'new-dep': '^1' },
      locked: [{ package: 'locked-dep', version: '1.0.0' }],
    }),
    resolveVersion: async () => '2.0.0',
    getVerdictBatch: async (pkgs) => {
      for (const p of pkgs) checked.push(p.package);
      return pkgs.map((p) => ({ ...p, verdict: 'verified' }));
    },
    runReal,
  });
  assert.ok(checked.includes('new-dep')); // the drift dep got checked, not skipped
  assert.equal(r.action, 'ran');
});
