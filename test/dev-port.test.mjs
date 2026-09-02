import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chooseDevPort, PortInUseError } from '../dist/local/loopback.js';

async function listen(port) {
  const server = createServer((_req, res) => res.end('occupied'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function freeConsecutivePorts() {
  for (let port = 39000; port < 65000; port += 2) {
    const first = createServer();
    const second = createServer();
    try {
      await new Promise((resolve, reject) => {
        first.once('error', reject);
        first.listen(port, '127.0.0.1', resolve);
      });
      await new Promise((resolve, reject) => {
        second.once('error', reject);
        second.listen(port + 1, '127.0.0.1', resolve);
      });
      await Promise.all([
        new Promise((resolve) => first.close(resolve)),
        new Promise((resolve) => second.close(resolve)),
      ]);
      return port;
    } catch {
      if (first.listening) await new Promise((resolve) => first.close(resolve));
      if (second.listening) await new Promise((resolve) => second.close(resolve));
    }
  }
  throw new Error('Could not find two consecutive fixture ports');
}

test('an omitted port moves to the next free port when the default is busy', async (t) => {
  const start = await freeConsecutivePorts();
  const blocker = await listen(start);
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  assert.deepEqual(await chooseDevPort(undefined, start), {
    port: start + 1,
    movedFrom: start,
  });
});

test('an explicitly requested busy port is a strict error naming its owner when discoverable', async (t) => {
  const start = await freeConsecutivePorts();
  const blocker = await listen(start);
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  await assert.rejects(
    chooseDevPort(start),
    (err) => {
      assert.ok(err instanceof PortInUseError);
      assert.equal(err.port, start);
      assert.match(err.message, new RegExp(`Port ${start} is already in use`));
      assert.match(err.message, /--port <n>/);
      if (process.platform === 'darwin') assert.match(err.message, /node \(PID \d+\)/);
      return true;
    },
  );
});

test('an explicitly requested free port is kept unchanged', async () => {
  const start = await freeConsecutivePorts();
  assert.deepEqual(await chooseDevPort(start), { port: start, movedFrom: null });
});
