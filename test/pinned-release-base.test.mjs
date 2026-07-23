import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('CLI never substitutes the current release into an unanchored request', () => {
  assert.equal(
    existsSync(new URL('../src/lib/pinned-release-retry.ts', import.meta.url)),
    false,
    'the hidden base-release retry helper must be absent',
  );

  const deploySource = readFileSync(new URL('../src/commands/deploy.ts', import.meta.url), 'utf8');
  const devSource = readFileSync(new URL('../src/commands/dev.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(deploySource, /pinnedReleaseRetryBody|BASE_RELEASE_REQUIRED/);
  assert.match(deploySource, /client\.call<T>\('POST', '\/deploy', body/);
  assert.doesNotMatch(devSource, /callWithPinnedReleaseRetry|BASE_RELEASE_REQUIRED/);
  assert.match(devSource, /callDraftCandidate<DeployResult>\(client, '\/deploy', body\)/);
  assert.match(devSource, /callDraftCandidate<PatchResult>\(client, '\/deploy\/patch', body\)/);
  assert.match(devSource, /draft_operation_id: firstOperationId/);
  assert.match(devSource, /expected_candidate_release_id: null/);
  assert.match(devSource, /expected_candidate_release_id: expectedCandidateReleaseId/);
  assert.doesNotMatch(devSource, /current_release|active_release|base_release/);
});
