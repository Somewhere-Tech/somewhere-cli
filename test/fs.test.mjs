import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, { cwd = repoRoot, env, input } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.end(input);
    child.on('close', (status) => resolvePromise({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function writeConfig(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_fs_test',
    user: { email: 'fs@example.com', username: 'fs' },
  }) + '\n');
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function collect(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks;
}

test('fs put/get/ls/rm streams a multi-MB file and round-trips identical bytes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-fs-home-'));
  const fixture = mkdtempSync(join(tmpdir(), 'sw-fs-fixture-'));
  writeConfig(home);
  writeFileSync(join(fixture, '.somewhere.json'), JSON.stringify({
    project_id: 'project-slug',
    name: 'FS test',
    subdomain: 'project-slug',
  }) + '\n');

  const input = Buffer.allocUnsafe(5 * 1024 * 1024 + 137);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  const source = join(fixture, 'large.bin');
  const destination = join(fixture, 'roundtrip.bin');
  writeFileSync(source, input);

  const files = new Map();
  let uploadChunkCount = 0;
  let largestUploadChunk = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const filePath = '/v1/fs/project-slug/files/large.bin';
    if (req.method === 'PUT' && url.pathname === filePath) {
      const chunks = await collect(req);
      uploadChunkCount = chunks.length;
      largestUploadChunk = Math.max(...chunks.map((chunk) => chunk.length));
      const content = Buffer.concat(chunks);
      files.set(filePath, content);
      sendJson(res, 201, {
        ok: true,
        data: { path: '/files/large.bin', size_bytes: content.length, content_type: 'application/octet-stream', version: 1 },
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === filePath) {
      const content = files.get(filePath);
      if (!content) {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: 'File not found.' });
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(content.length));
      for (let offset = 0; offset < content.length; offset += 32 * 1024) {
        res.write(content.subarray(offset, offset + 32 * 1024));
      }
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/fs/project-slug/files') {
      sendJson(res, 200, {
        ok: true,
        data: {
          path: '/files/',
          type: 'directory',
          entries: files.has(filePath) ? [{
            path: '/files/large.bin',
            name: 'large.bin',
            type: 'file',
            size_bytes: files.get(filePath).length,
            content_type: 'application/octet-stream',
            version: 1,
            updated_at: new Date(0).toISOString(),
          }] : [],
          next_cursor: null,
        },
      });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === filePath) {
      files.delete(filePath);
      sendJson(res, 200, { ok: true, data: { deleted: 1, type: 'file', path: '/files/large.bin' } });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: `${req.method} ${url.pathname}` });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  const env = {
    HOME: home,
    USERPROFILE: home,
    SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
  };

  try {
    const put = await run(['fs', 'put', source, '/files/large.bin'], { cwd: fixture, env });
    assert.equal(put.status, 0, `stdout:\n${put.stdout}\nstderr:\n${put.stderr}`);
    assert.equal(uploadChunkCount > 1, true, 'upload arrived as multiple chunks');
    assert.equal(largestUploadChunk < input.length, true, 'no single in-memory argument-sized upload chunk');
    assert.deepEqual(files.get('/v1/fs/project-slug/files/large.bin'), input);

    const get = await run(['fs', 'get', '/files/large.bin', destination], { cwd: fixture, env });
    assert.equal(get.status, 0, `stdout:\n${get.stdout}\nstderr:\n${get.stderr}`);
    assert.deepEqual(readFileSync(destination), input);

    const ls = await run(['fs', 'ls', '/files', '--json'], { cwd: fixture, env });
    assert.equal(ls.status, 0, `stdout:\n${ls.stdout}\nstderr:\n${ls.stderr}`);
    assert.equal(JSON.parse(ls.stdout).entries[0].path, '/files/large.bin');

    const rm = await run(['fs', 'rm', '/files/large.bin'], { cwd: fixture, env });
    assert.equal(rm.status, 0, `stdout:\n${rm.stdout}\nstderr:\n${rm.stderr}`);
    assert.equal(files.size, 0);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('api --data-file streams from disk and accepts stdin with -', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-api-file-home-'));
  const fixture = mkdtempSync(join(tmpdir(), 'sw-api-file-fixture-'));
  writeConfig(home);
  const diskBody = Buffer.alloc(3 * 1024 * 1024 + 71, 0x61);
  const stdinBody = Buffer.alloc(2 * 1024 * 1024 + 29, 0x62);
  const source = join(fixture, 'body.bin');
  writeFileSync(source, diskBody);
  const received = [];
  const chunkCounts = [];

  const server = createServer(async (req, res) => {
    const chunks = await collect(req);
    received.push(Buffer.concat(chunks));
    chunkCounts.push(chunks.length);
    sendJson(res, 200, { ok: true, data: { received: received.at(-1).length } });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  const env = {
    HOME: home,
    USERPROFILE: home,
    SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`,
  };

  try {
    const disk = await run(['api', 'POST', '/v1/import', '--data-file', source], { env });
    assert.equal(disk.status, 0, `stdout:\n${disk.stdout}\nstderr:\n${disk.stderr}`);
    assert.deepEqual(received[0], diskBody);
    assert.equal(chunkCounts[0] > 1, true);

    const stdin = await run(['api', 'POST', '/v1/import', '--data-file', '-'], { env, input: stdinBody });
    assert.equal(stdin.status, 0, `stdout:\n${stdin.stdout}\nstderr:\n${stdin.stderr}`);
    assert.deepEqual(received[1], stdinBody);
    assert.equal(chunkCounts[1] > 1, true);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
