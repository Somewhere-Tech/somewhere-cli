import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chooseProjectRef, projectRefConflictMessage } from '../dist/lib/project-ref.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

// A dead port: these tests are about ARGUMENT PARSING. The command must get
// past commander and fail on the network, never on `unknown option`.
const DEAD_API = 'http://127.0.0.1:9/v1';

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function setup(prefix) {
  const HOME = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(
    join(HOME, '.somewhere', 'config.json'),
    JSON.stringify({ token: 'smt_projectref', user: { email: 'dev@example.com', username: 'dev' } }) + '\n',
  );
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}-fixture-`));
  return { env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: DEAD_API }, cwd };
}

// Parity finding #10 — `logs` and `errors` answered `unknown option
// '--project'` while a dozen other commands took the flag, so an agent that
// learned one syntax hit a wall on the next command.

test('DIRECTION 1: --project is accepted by every command that names a project', async () => {
  const commands = [
    ['logs', '--project', 'proj_flag'],
    ['errors', '--project', 'proj_flag'],
    ['status', '--project', 'proj_flag'],
    ['rollback', '--project', 'proj_flag', '--yes'],
  ];
  for (const args of commands) {
    const { env, cwd } = setup('sw-projectref-flag');
    const result = await run(args, { cwd, env });
    // It must reach the network, not die in the parser.
    assert.doesNotMatch(
      result.stderr,
      /unknown option/,
      `${args[0]} rejected --project:\n${result.stderr}`,
    );
    // And it must not fall through to "no project" — the flag selected one.
    assert.doesNotMatch(result.stderr, /No project(\.| specified)/, `${args[0]}:\n${result.stderr}`);
  }
});

test('DIRECTION 2: the positional form keeps working — nothing that ran stops running', async () => {
  const commands = [
    ['logs', 'proj_positional'],
    ['errors', 'proj_positional'],
    ['status', 'proj_positional'],
    ['rollback', 'proj_positional', '--yes'],
  ];
  for (const args of commands) {
    const { env, cwd } = setup('sw-projectref-positional');
    const result = await run(args, { cwd, env });
    assert.doesNotMatch(result.stderr, /unknown option|unknown command/, `${args[0]}:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /No project(\.| specified)/, `${args[0]}:\n${result.stderr}`);
  }
});

test('naming two different projects in one command is refused, not guessed', async () => {
  const { env, cwd } = setup('sw-projectref-conflict');
  const result = await run(['logs', 'proj_one', '--project', 'proj_two'], { cwd, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Two different projects named in one command/);
  assert.match(result.stderr, /proj_one/);
  assert.match(result.stderr, /proj_two/);
});

test('with neither form, an unlinked directory still says how to name a project', async () => {
  const { env, cwd } = setup('sw-projectref-none');
  const result = await run(['logs'], { cwd, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--project/);
});

// The pure chooser, both directions.

test('chooseProjectRef: flag, positional, both-agreeing, both-disagreeing, neither', () => {
  assert.deepEqual(chooseProjectRef(undefined, 'a'), { kind: 'ref', ref: 'a' });
  assert.deepEqual(chooseProjectRef('a', undefined), { kind: 'ref', ref: 'a' });
  // Repeating yourself is harmless.
  assert.deepEqual(chooseProjectRef('a', 'a'), { kind: 'ref', ref: 'a' });
  assert.deepEqual(chooseProjectRef('a', 'b'), { kind: 'conflict', positional: 'a', flag: 'b' });
  assert.deepEqual(chooseProjectRef(undefined, undefined), { kind: 'none' });
  // Whitespace-only is not a project name.
  assert.deepEqual(chooseProjectRef('  ', '  '), { kind: 'none' });
  assert.match(projectRefConflictMessage({ positional: 'a', flag: 'b' }), /Pass one/);
});
