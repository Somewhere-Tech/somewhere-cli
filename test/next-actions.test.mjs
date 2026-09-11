/**
 * The contextual next steps the CLI prints after init, login, and deploy.
 *
 * The point of these assertions is that a suggestion can never drift away from
 * the CLI it is suggesting. `every suggested command is a real command with
 * real flags` re-derives each one from the binary's own `--help`, so renaming
 * `--screenshot` breaks the build instead of shipping copy that errors when an
 * agent pastes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const moduleUnderTest = process.env.SOMEWHERE_TEST_SOURCE
  ? '../src/lib/next-actions.ts'
  : '../dist/lib/next-actions.js';
const { nextActions, formatNextActions, shellQuote } = await import(moduleUnderTest);

function commandsOf(actions) {
  return actions.map((a) => a.command);
}

test('init sends a brand-new project to deploy first, and only then to dev', () => {
  const actions = nextActions({ stage: 'init', scaffolded: true });
  const commands = commandsOf(actions);

  assert.equal(commands[0], 'somewhere deploy');
  // `somewhere dev` proxies API calls to the DEPLOYED origin and refuses on a
  // project with no release (lib/project-urls.ts). Suggesting it first is the
  // bug this module was written for (pfb_9a035f5ac8e9) — it must stay last,
  // and it must say it comes after the deploy.
  const dev = actions.find((a) => a.command === 'somewhere dev');
  assert.ok(dev, `no dev step in ${JSON.stringify(commands)}`);
  assert.equal(commands.indexOf('somewhere dev'), commands.length - 1);
  assert.match(dev.why, /after that/i);
  assert.ok(commands.indexOf('somewhere deploy') < commands.indexOf('somewhere dev'));
});

test('init and deploy both name the browser check, so it is discoverable without being told', () => {
  for (const ctx of [
    { stage: 'init', scaffolded: true },
    { stage: 'init', scaffolded: false },
    { stage: 'deploy', projectLinked: true, liveUrl: 'https://app.somewhere.site', temporary: false },
  ]) {
    const commands = commandsOf(nextActions(ctx));
    assert.ok(
      commands.some((c) => c.startsWith('somewhere browser')),
      `${JSON.stringify(ctx)} → ${JSON.stringify(commands)}`,
    );
  }
});

test('a linked deploy suggests the project-default browser and verify runs', () => {
  assert.deepEqual(
    commandsOf(nextActions({ stage: 'deploy', projectLinked: true, liveUrl: 'https://app.somewhere.site', temporary: false })),
    ['somewhere browser --screenshot', 'somewhere verify'],
  );
});

test('an unlinked deploy screenshots BY URL, with the --store the public path requires', () => {
  // commands/browser.ts refuses `--screenshot` on a public URL without
  // `--store`; a suggestion missing it would fail the moment it was pasted.
  const commands = commandsOf(
    nextActions({ stage: 'deploy', projectLinked: false, liveUrl: 'https://temp-app.somewhere.site', temporary: false }),
  );
  assert.deepEqual(commands, ['somewhere browser https://temp-app.somewhere.site --screenshot --store']);
});

test('a temporary deploy is addressed BY URL even though a link may exist', () => {
  // `--temporary` beside a real login deliberately keeps the throwaway project
  // out of `.somewhere.json`, so the bare project form would open the
  // developer's own app. One step on this path, never two.
  assert.deepEqual(
    commandsOf(nextActions({ stage: 'deploy', projectLinked: true, liveUrl: 'https://temp-fresh.somewhere.site', temporary: true })),
    ['somewhere browser https://temp-fresh.somewhere.site --screenshot --store'],
  );
  assert.deepEqual(
    nextActions({ stage: 'deploy', projectLinked: true, liveUrl: null, temporary: true }),
    [],
  );
});

test('a URL that is not safe bare in a shell is quoted', () => {
  assert.equal(shellQuote('https://ok-app.somewhere.site/path'), 'https://ok-app.somewhere.site/path');
  assert.equal(shellQuote('https://a.example/?x=1&y=2'), `'https://a.example/?x=1&y=2'`);
  assert.equal(shellQuote("https://a.example/it's"), `'https://a.example/it'\\''s'`);
  const action = nextActions({
    stage: 'deploy',
    projectLinked: false,
    liveUrl: 'https://a.example/?x=1&y=2',
    temporary: true,
  })[0];
  assert.equal(action.command, `somewhere browser 'https://a.example/?x=1&y=2' --screenshot --store`);
});

test('a deploy with nothing to point at suggests nothing rather than guessing', () => {
  assert.deepEqual(nextActions({ stage: 'deploy', projectLinked: false, liveUrl: null, temporary: false }), []);
  assert.deepEqual(formatNextActions([]), []);
});

test('login points at init or deploy depending on whether this directory is a project', () => {
  assert.deepEqual(commandsOf(nextActions({ stage: 'login', linkedProject: false })), ['somewhere init']);
  assert.deepEqual(commandsOf(nextActions({ stage: 'login', linkedProject: true })), ['somewhere deploy']);
});

test('rendering stays short, aligned, and plain by default', () => {
  const actions = nextActions({ stage: 'deploy', projectLinked: true, liveUrl: null, temporary: false });
  const lines = formatNextActions(actions);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /^ {2}somewhere /);
    assert.doesNotMatch(line, /\x1B\[/); // no styling unless a caller asks
  }
  // Every explanation starts in the same column, whatever the command length.
  const columns = lines.map((line, i) => line.indexOf(actions[i].why));
  assert.ok(columns.every((c) => c > 0));
  assert.equal(new Set(columns).size, 1);
});

test('styles are applied only when a caller passes them', () => {
  const lines = formatNextActions(nextActions({ stage: 'login', linkedProject: true }), {
    command: (v) => `<c>${v}</c>`,
    why: (v) => `<w>${v}</w>`,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /<c>somewhere deploy<\/c>\s+<w>.+<\/w>$/);
});

test('no next step tells the developer to run somebody else\'s tool', () => {
  const every = [
    ...nextActions({ stage: 'init', scaffolded: true }),
    ...nextActions({ stage: 'init', scaffolded: false }),
    ...nextActions({ stage: 'login', linkedProject: true }),
    ...nextActions({ stage: 'login', linkedProject: false }),
    ...nextActions({ stage: 'deploy', projectLinked: true, liveUrl: 'https://app.somewhere.site', temporary: false }),
    ...nextActions({ stage: 'deploy', projectLinked: false, liveUrl: 'https://app.somewhere.site', temporary: false }),
  ];
  for (const action of every) {
    assert.match(action.command, /^somewhere /, action.command);
    assert.ok(action.why.length > 0 && action.why.length <= 90, `${action.command}: ${action.why}`);
  }
});

function runCli(args, home) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('every suggested command is a real command with real flags', { skip: process.env.SOMEWHERE_TEST_SOURCE ? 'needs dist' : false }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-next-actions-home-'));
  const suggested = new Set(
    [
      ...nextActions({ stage: 'init', scaffolded: true }),
      ...nextActions({ stage: 'init', scaffolded: false }),
      ...nextActions({ stage: 'login', linkedProject: true }),
      ...nextActions({ stage: 'login', linkedProject: false }),
      ...nextActions({ stage: 'deploy', projectLinked: true, liveUrl: 'https://app.somewhere.site', temporary: false }),
      ...nextActions({ stage: 'deploy', projectLinked: false, liveUrl: 'https://app.somewhere.site', temporary: false }),
    ].map((a) => a.command),
  );
  assert.ok(suggested.size >= 4);

  for (const command of suggested) {
    const [prefix, name, ...rest] = command.split(' ');
    assert.equal(prefix, 'somewhere', command);
    const help = await runCli([name, '--help'], home);
    assert.equal(help.status, 0, `${command}: ${help.stderr}`);
    assert.match(help.stdout, new RegExp(`^Usage: somewhere ${name}\\b`), command);
    for (const token of rest) {
      if (!token.startsWith('--')) continue;
      assert.match(
        help.stdout,
        new RegExp(`(^|\\s)${token}(\\s|,|$|\\[|<)`, 'm'),
        `${command}: ${name} has no ${token}`,
      );
    }
  }
});
