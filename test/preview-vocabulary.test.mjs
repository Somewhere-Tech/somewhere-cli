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
