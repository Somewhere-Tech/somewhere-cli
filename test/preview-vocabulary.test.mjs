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
