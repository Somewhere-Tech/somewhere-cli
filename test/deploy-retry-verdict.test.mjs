import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatErrorReference, unclassifiedResponseMessage } from '../dist/lib/client.js';

// tsk_9c5ed7f8. Two failures one screen apart on the same deploy: the platform
// answered "retry, nothing changed" and the CLI stopped anyway, and an error
// body it could not classify was rendered as the bare word "Unknown error"
// with no id anyone could look up afterwards.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function run(args, { cwd = repoRoot, env }) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(
      sourceRunner ?? process.execPath,
      sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args],
      { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function fixture(name) {
  const HOME = mkdtempSync(join(tmpdir(), `sw-${name}-home-`));
  const dir = mkdtempSync(join(tmpdir(), `sw-${name}-fixture-`));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(
    join(HOME, '.somewhere', 'config.json'),
    JSON.stringify({ token: 'smt_verdict_test', user: { email: 'v@example.com', username: 'v' } }) + '\n',
  );
  writeFileSync(
    join(dir, '.somewhere.json'),
    JSON.stringify({ project_id: `proj_${name}`, name, subdomain: name }) + '\n',
  );
  writeFileSync(join(dir, 'index.html'), `<html><body>${name}</body></html>\n`);
  return { HOME, dir };
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function sendJson(res, status, payload, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

test('a deploy the platform marks retry:true is sent again, and the second attempt lands', async () => {
  const { HOME, dir } = fixture('retryverdict');
  let deployCalls = 0;

  await withServer(
    (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: { project_id: 'proj_retryverdict', notices: [] } });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployCalls += 1;
        if (deployCalls === 1) {
          // The exact shape the worker's errorResponse produces: `retry` at the
          // TOP LEVEL, beside a `data` payload of the route's own. The CLI used
          // to fold unknown top-level fields into `data` and then drop them
          // whenever the route had sent its own — the case that matters.
          sendJson(
            res,
            503,
            {
              ok: false,
              error: 'PUBLISH_FROZEN',
              message: 'Publishing is briefly frozen for this project.',
              retry: true,
              data: { project_id: 'proj_retryverdict' },
            },
            { 'X-Request-Id': 'ray-frozen', 'X-Trace-Id': 'trace-frozen' },
          );
          return;
        }
        sendJson(res, 200, {
          ok: true,
          data: { files: 1, url: 'https://retryverdict.somewhere.tech', has_functions: false },
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    },
    async (apiUrl) => {
      const result = await run(['deploy'], {
        cwd: dir,
        env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      });
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(deployCalls, 2, 'the platform said retry; the CLI must retry exactly once');
      assert.match(result.stdout, /retryable failure \(PUBLISH_FROZEN\)/);
      assert.match(result.stdout, /retrying once/);
      assert.match(result.stdout, /Live at https:\/\/retryverdict\.somewhere\.tech/);
    },
  );
});

test('retry:false is a refusal — the deploy is not sent twice', async () => {
  const { HOME, dir } = fixture('noretry');
  let deployCalls = 0;

  await withServer(
    (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: { project_id: 'proj_noretry', notices: [] } });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        deployCalls += 1;
        sendJson(
          res,
          400,
          { ok: false, error: 'QUOTA_EXCEEDED', message: 'Out of build minutes.', retry: false },
          { 'X-Request-Id': 'ray-quota' },
        );
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    },
    async (apiUrl) => {
      const result = await run(['deploy'], {
        cwd: dir,
        env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      });
      assert.equal(result.status, 1);
      assert.equal(deployCalls, 1, 'an explicit refusal must never be retried');
      // ...and the id is on screen even for a failure nobody retries.
      assert.match(result.stdout + result.stderr, /request ray-quota/);
    },
  );
});

test('an error body the CLI cannot classify prints the status, the body and the ids', async () => {
  const { HOME, dir } = fixture('unclassified');

  await withServer(
    (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: { project_id: 'proj_unclassified', notices: [] } });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        // Structured JSON with neither `error` nor `message` — the shape that
        // produced "✗ Unknown error [UNKNOWN, HTTP 503]" and nothing else.
        sendJson(res, 503, { ok: false, detail: 'upstream publisher refused', stage: 'publish' }, {
          'X-Request-Id': 'ray-503',
          'X-Trace-Id': 'trace-503',
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    },
    async (apiUrl) => {
      const result = await run(['deploy'], {
        cwd: dir,
        env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      });
      const out = result.stdout + result.stderr;
      assert.equal(result.status, 1);
      assert.doesNotMatch(out, /Unknown error/);
      assert.match(out, /answered 503/);
      assert.match(out, /upstream publisher refused/);
      assert.match(out, /request ray-503 · trace trace-503/);
    },
  );
});

test('--json carries the correlation ids as machine-readable fields', async () => {
  const { HOME, dir } = fixture('jsonids');

  await withServer(
    (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: { project_id: 'proj_jsonids', notices: [] } });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        sendJson(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: 'Deploy failed.' }, {
          'X-Request-Id': 'ray-json',
          'X-Trace-Id': 'trace-json',
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    },
    async (apiUrl) => {
      const result = await run(['deploy', '--json'], {
        cwd: dir,
        env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
      });
      assert.equal(result.status, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.error, 'INTERNAL_ERROR');
      assert.equal(payload.request_id, 'ray-json');
      assert.equal(payload.trace_id, 'trace-json');
    },
  );
});

test('the unclassified message names the status and stays one line', () => {
  assert.match(unclassifiedResponseMessage(503, '{"a":1}'), /answered 503/);
  assert.match(unclassifiedResponseMessage(503, '   '), /body was empty/);
  const long = unclassifiedResponseMessage(500, JSON.stringify({ x: 'y'.repeat(1000) }));
  assert.ok(long.length < 420, `stays a line, not a dump (${long.length})`);
  assert.match(long, /…$/);
});

test('the reference names whichever ids the response carried', () => {
  assert.equal(formatErrorReference({ requestId: 'r', traceId: 't' }), 'request r · trace t');
  assert.equal(formatErrorReference({ traceId: 't' }), 'trace t');
  assert.equal(formatErrorReference({}), null);
  assert.equal(formatErrorReference(undefined), null);
});
