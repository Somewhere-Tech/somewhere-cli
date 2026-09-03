import test from 'node:test';
import assert from 'node:assert/strict';

import {
  promoteCommandForShell,
  promoteCommandLines,
  promoteCommands,
  promotedDataNotes,
} from '../dist/lib/promote-handoff.js';
import { promoteDataNotesFromResponse } from '../dist/commands/promote.js';

const SESSION = 'draft_11111111-1111-4111-8111-111111111111';
const PREVIEW = 'rel_candidate_1';
const PROJECT = 'preview-project';

// Parity finding #9 — the CLI printed a promote command that `somewhere
// promote` then refused in the same shell.

test('DIRECTION 1: a non-interactive shell is handed a command it can actually run', () => {
  const commands = promoteCommands({ previewSessionId: SESSION, previewId: PREVIEW, projectRef: PROJECT, interactive: false });
  assert.equal(commands.length, 1);
  assert.equal(commands[0], `somewhere promote ${SESSION} ${PREVIEW} --project ${PROJECT} --yes`);
  // This is the exact thing the bug got wrong: the printed command lacked the
  // one flag promote requires when there is no terminal to confirm with.
  assert.match(commands[0], /--yes$/);
  assert.equal(
    promoteCommandForShell({ previewSessionId: SESSION, previewId: PREVIEW, projectRef: PROJECT, interactive: false }),
    commands[0],
  );
});

test('DIRECTION 2: a person at a terminal is not handed an unattended promote first', () => {
  const commands = promoteCommands({ previewSessionId: SESSION, previewId: PREVIEW, projectRef: PROJECT, interactive: true });
  assert.deepEqual(commands, [
    `somewhere promote ${SESSION} ${PREVIEW} --project ${PROJECT}`,
    `somewhere promote ${SESSION} ${PREVIEW} --project ${PROJECT} --yes`,
  ]);
  // The plain form leads — the confirmation is the point of being at a keyboard.
  assert.doesNotMatch(commands[0], /--yes/);
  // But the script form is still there, named, for whoever scrolls back.
  assert.equal(
    promoteCommandForShell({ previewSessionId: SESSION, previewId: PREVIEW, projectRef: PROJECT, interactive: true }),
    commands[0],
  );
});

test('the printed lines label both variants so two lines are not two mysteries', () => {
  const script = promoteCommandLines({ previewSessionId: SESSION, previewId: PREVIEW, projectRef: PROJECT, interactive: false });
  assert.equal(script.length, 1);
  assert.match(script[0], /promote command: `somewhere promote .+ --yes`/);

  const human = promoteCommandLines({ previewSessionId: SESSION, previewId: PREVIEW, projectRef: PROJECT, interactive: true });
  assert.equal(human.length, 2);
  assert.match(human[0], /promote command: `somewhere promote [^`]*[^ ]`/);
  assert.match(human[1], /scripts, agents.*--yes/);
});

test('project names are shell-quoted in the copyable command', () => {
  const [command] = promoteCommands({
    previewSessionId: SESSION,
    previewId: PREVIEW,
    projectRef: "Builder's Preview",
    interactive: false,
  });
  assert.equal(
    command,
    `somewhere promote ${SESSION} ${PREVIEW} --project 'Builder'"'"'s Preview' --yes`,
  );
});

// Parity finding #7 — promotion moved the app and said nothing about the data.

test('a landed promote states that the preview rows stayed behind', () => {
  const notes = promotedDataNotes(undefined);
  assert.ok(notes.length >= 1);
  const all = notes.join(' ');
  assert.match(all, /Only the app was promoted/);
  assert.match(all, /preview database/);
  assert.match(all, /production is serving the data it already had/);
  // And it names the next step rather than leaving the developer to find it.
  assert.match(all, /check it end to end|seed/);
  // Product language only — no infrastructure nouns in a customer sentence.
  assert.doesNotMatch(all, /D1|R2|KV|SQLite|Cloudflare|Worker/i);
});

test('the platform s own wording wins when it sends one, so the line can be fixed without a release', () => {
  const verbatim = '  Promoting publishes files, not preview rows.  ';
  assert.deepEqual(promotedDataNotes(verbatim), [verbatim]);
  assert.deepEqual(
    promotedDataNotes('Preview rows are not promoted; production data is untouched.'),
    ['Preview rows are not promoted; production data is untouched.'],
  );
  // An empty or non-string field is not an override — fall back, never print nothing.
  assert.ok(promotedDataNotes('   ').length >= 1);
  assert.ok(promotedDataNotes(null).length >= 1);
  assert.ok(promotedDataNotes(42).length >= 1);
});

test('promote response note fixtures prefer the platform field and ignore malformed values', () => {
  const fallback = promotedDataNotes(undefined);
  const fixtures = [
    {
      name: 'new platform field',
      response: { data_notice: '  Platform notice, exactly as sent.  ' },
      expected: ['  Platform notice, exactly as sent.  '],
    },
    {
      name: '0.31.3 compatibility field',
      response: { data_note: 'Legacy field remains readable.' },
      expected: ['Legacy field remains readable.'],
    },
    { name: 'older response', response: {}, expected: fallback },
    { name: 'malformed response', response: { data_notice: { text: 'do not print me' } }, expected: fallback },
  ];

  for (const fixture of fixtures) {
    assert.deepEqual(promoteDataNotesFromResponse(fixture.response), fixture.expected, fixture.name);
  }
});
