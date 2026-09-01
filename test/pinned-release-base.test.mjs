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
  assert.match(devSource, /preview_operation_id: firstOperationId/);
  assert.match(devSource, /expected_preview_id: null/);
  assert.match(devSource, /expected_preview_id: expectedCandidateReleaseId/);
  // The first preview MUST anchor to its base release (backend contract
  // DRAFT_SOURCE_SNAPSHOT_REQUIRED): dev reads the current active release up
  // front from deploy_status and sends it once as base_release_id — the safe,
  // explicit anchor (matches the proven preview flow). What stays banned
  // is the HIDDEN retry that substituted the CURRENT release into an unanchored
  // request on error (the removed pinned-release-retry helper + BASE_RELEASE_REQUIRED
  // handling, both asserted absent above).
  assert.match(devSource, /base_release_id: baseReleaseId/);
  assert.doesNotMatch(devSource, /current_release/);
});
