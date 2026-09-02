import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('CLI presents preview vocabulary and retains the load-bearing --draft alias', () => {
  const promote = read('src/commands/promote.ts');
  const dev = read('src/commands/dev.ts');
  const project = read('src/commands/project.ts');

  assert.match(promote, /command\('promote <preview_session_id> <preview_id>'\)/);
  assert.match(promote, /preview_session_id: draftId/);
  assert.match(promote, /preview_id: candidateReleaseId/);

  assert.match(dev, /preview_session_id: draftId/);
  assert.match(dev, /preview_operation_id: firstOperationId/);
  assert.match(dev, /expected_preview_id: null/);
  assert.match(dev, /res\.preview_session_id \?\? res\.draft_id/);
  assert.match(dev, /res\.preview_id \?\? res\.candidate_release_id/);

  assert.match(project, /option\('--preview', 'Create without deploying to production'\)/);
  assert.match(project, /option\('--draft', 'Deprecated alias for --preview'\)/);
});

test('`somewhere preview` is the command and `dev --cloud` is a quiet alias', () => {
  const dev = read('src/commands/dev.ts');
  const index = read('src/index.ts');

  // The hosted loop has its own command, and it runs the SAME function the
  // alias runs — not a copy that can drift.
  assert.match(dev, /export function registerPreview\(program: Command\)/);
  assert.match(dev, /\.command\('preview'\)/);
  assert.match(index, /registerPreview\(program\)/);
  const previewBody = dev.slice(
    dev.indexOf('export function registerPreview'),
    dev.indexOf('export function registerDev'),
  );
  assert.match(previewBody, /runHotDeploy\(opts\)/);

  // The alias still works, and says the new name exactly once.
  assert.match(dev, /\.option\('--cloud', 'Alias for `somewhere preview`'\)/);
  assert.match(dev, /This is `somewhere preview`\./);
  const aliasBranch = dev.slice(dev.indexOf('if (opts.cloud)'), dev.indexOf('return runLocalDev'));
  assert.match(aliasBranch, /runHotDeploy\(opts\)/);
});

test('customer-facing CLI copy uses exactly two words: dev and preview', () => {
  const banned = [/cloud dev/i, /cloud preview/i, /draft environment/i, /\bwatcher\b/i];
  // Every string a customer can read: command/option help, the README, and the
  // entitlement refusal. `--cloud` may appear ONLY as the alias's own name.
  const dev = read('src/commands/dev.ts');
  const readme = read('README.md');

  for (const re of banned) {
    assert.equal(re.test(readme), false, `README still says ${re}`);
  }
  // In dev.ts only chokidar's variable names may match /watcher/; check the
  // customer-visible strings instead of the whole file.
  const strings = dev.match(/'[^'\\\n]{12,}'/g) ?? [];
  for (const s of strings) {
    for (const re of banned) {
      assert.equal(re.test(s), false, `customer-facing string still says ${re}: ${s}`);
    }
  }

  // The refusal names the command, not the flag, and is customer voice.
  const refusal = dev.slice(dev.indexOf('CLOUD_DEV_UNAVAILABLE_MESSAGE ='), dev.indexOf('CLOUD_DEV_UNAVAILABLE_MESSAGE =') + 300);
  assert.match(refusal, /`somewhere preview` is available on the Pro and Scale plans/);
  assert.doesNotMatch(refusal, /--cloud/);
});

// tsk_74375b3c — a promote ends the preview, and the loop says so in the two
// words the product uses. None of OUR nouns reach the terminal.
test('after a promote the preview loop ends cleanly, in product language', () => {
  const dev = read('src/commands/dev.ts');

  // The loop recognises the end of a preview instead of relaying a refusal.
  assert.match(dev, /class PreviewFinishedError/);
  assert.match(dev, /err\.code !== 'DRAFT_SESSION_TERMINAL'/);
  assert.match(dev, /terminal_status/);

  // It stops, rather than failing identically on every later save.
  assert.match(dev, /await watcher\.close\(\)/);

  // The two lines a person reads.
  assert.match(dev, /Promoted — this preview is now your live app, and the preview has finished\./);
  assert.match(dev, /Run \$\{teal\('somewhere preview'\)\} to keep previewing\./);
});

test('no internal field name is printable from the preview loop', () => {
  const dev = read('src/commands/dev.ts');
  // Prose the CLI prints, as opposed to request keys and identifiers: a quoted
  // sentence starting with a capital letter and containing words.
  const prose = [...dev.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)]
    .map((m) => m[1])
    .filter((text) => /^[A-Z]/.test(text) && /[a-z] [a-z]/.test(text));
  assert.ok(prose.length > 10, 'expected to find the printed copy');
  for (const line of prose) {
    for (const noun of [
      'draft_id',
      'candidate_release_id',
      'expected_candidate_release_id',
      'expected_preview_id',
      'draft_operation_id',
      'snapshot',
    ]) {
      assert.ok(!line.includes(noun), `customer copy names our field "${noun}": ${line}`);
    }
  }
});

// tsk_14c5408c — a burst of saves must produce ONE preview update, not several
// overlapping ones. chokidar picks up whatever a formatter or a build tool
// drops in the tree, so a burst is normal, not pathological.
test('a burst of saves coalesces into one preview update', () => {
  const dev = read('src/commands/dev.ts');

  // Saves inside the debounce window accumulate into one batch...
  assert.match(dev, /const DEBOUNCE_MS = \d+;/);
  assert.match(dev, /pendingChanged\.add\(rel\)/);
  assert.match(dev, /pendingDeleted\.add\(rel\)/);

  // ...and a save that lands WHILE an update is in flight re-arms instead of
  // sending a second one. Dropping this guard is what puts two candidates in
  // flight at once.
  assert.match(dev, /if \(deploying\) \{\s*\n\s*schedule\(\); \/\/ re-arm; a deploy is in flight\s*\n\s*return;/);
  assert.match(dev, /deploying = true;/);
  // Whatever arrived during the update goes out next, as one batch.
  assert.match(dev, /deploying = false;\s*\n\s*if \(pendingChanged\.size \|\| pendingDeleted\.size\) schedule\(\);/);
});
