import assert from 'node:assert/strict';
import test from 'node:test';
import {
  callDraftCandidate,
  mintPreviewHandoff,
  previewPlatformState,
  previewSessionStateFromDeployment,
  runPreviewPhase,
} from '../dist/commands/dev.js';
import { CliApiError } from '../dist/lib/client.js';

test('draft transport retries one exact operation after a lost response', async () => {
  const calls = [];
  const body = {
    project_id: 'proj_draft',
    draft_id: 'draft_11111111-1111-4111-8111-111111111111',
    draft_operation_id: 'draftop_same',
    expected_candidate_release_id: 'rel_previous',
  };
  const client = {
    async call(method, path, requestBody) {
      calls.push({ method, path, requestBody });
      if (calls.length === 1) throw new CliApiError('NETWORK_ERROR', 'lost response', 0);
      return { candidate_release_id: 'rel_next' };
    },
  };

  const result = await callDraftCandidate(client, '/deploy/patch', body);
  assert.equal(result.candidate_release_id, 'rel_next');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestBody, body);
  assert.equal(calls[1].requestBody, body);
  assert.equal(calls[1].requestBody.draft_operation_id, 'draftop_same');
});

test('draft transport retries one exact operation after typed preverify unavailability', async () => {
  const calls = [];
  const body = {
    project_id: 'proj_draft',
    draft_id: 'draft_11111111-1111-4111-8111-111111111111',
    draft_operation_id: 'draftop_preverify',
    expected_candidate_release_id: 'rel_previous',
  };
  const client = {
    async call(method, path, requestBody) {
      calls.push({ method, path, requestBody });
      if (calls.length === 1) {
        throw new CliApiError(
          'RELEASE_PREVERIFY_UNAVAILABLE',
          'The uploaded preview function could not be verified yet.',
          503,
        );
      }
      return { candidate_release_id: 'rel_next' };
    },
  };

  const result = await callDraftCandidate(client, '/deploy/patch', body);
  assert.equal(result.candidate_release_id, 'rel_next');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestBody, body);
  assert.equal(calls[1].requestBody, body);
});

test('draft transport never retries a server refusal', async () => {
  let calls = 0;
  const client = {
    async call() {
      calls += 1;
      throw new CliApiError('DRAFT_CANDIDATE_CONFLICT', 'stale candidate', 409);
    },
  };

  await assert.rejects(
    callDraftCandidate(client, '/deploy', {
      draft_id: 'draft_11111111-1111-4111-8111-111111111111',
      draft_operation_id: 'draftop_conflict',
      expected_candidate_release_id: null,
    }),
    (error) => error?.code === 'DRAFT_CANDIDATE_CONFLICT',
  );
  assert.equal(calls, 1);
});

test('preview handoff exposes the exact candidate capability and promote command', async () => {
  const calls = [];
  const client = {
    async call(method, path, body) {
      calls.push({ method, path, body });
      return { preview_url: 'https://fixture-dev.somewhere.site/__sw_cap?t=one-time' };
    },
  };

  const handoff = await mintPreviewHandoff(client, 'project id', 'draft-current', 'rel-current');
  assert.deepEqual(calls, [{
    method: 'POST',
    path: '/projects/project%20id/preview/mint',
    body: { draft_id: 'draft-current', candidate_release_id: 'rel-current' },
  }]);
  assert.equal(handoff.draftId, 'draft-current');
  assert.equal(handoff.candidateReleaseId, 'rel-current');
  assert.equal(handoff.projectRef, 'project id');
  assert.equal(handoff.capabilityUrl, 'https://fixture-dev.somewhere.site/__sw_cap?t=one-time');
  // The command is shaped for the shell that will read it (parity finding #9):
  // a test runner has no TTY, so the runnable form is the `--yes` one. A bare
  // `somewhere promote …` here would be a command promote itself refuses.
  assert.equal(
    handoff.promoteCommand,
    process.stdin.isTTY === true
      ? "somewhere promote draft-current rel-current --project 'project id'"
      : "somewhere promote draft-current rel-current --project 'project id' --yes",
  );
});

test('preview session state fixtures distinguish active, promoted, closed and unreadable', () => {
  const session = 'draft-current';
  const preview = 'rel-current';
  assert.equal(previewSessionStateFromDeployment({
    preview_candidates: [{ draft_id: session, candidate_release_id: preview, status: 'active' }],
  }, session, preview), 'active');
  assert.equal(previewSessionStateFromDeployment({
    active_release_id: 'rel-production',
    promoted_from_candidate_id: preview,
    preview_candidates: [],
  }, session, preview), 'promoted');
  assert.equal(previewSessionStateFromDeployment({
    preview_candidates: [{ draft_id: session, candidate_release_id: preview, terminal_status: 'expired' }],
  }, session, preview), 'closed');
  assert.equal(previewSessionStateFromDeployment({ preview_candidates: [] }, session, preview), 'missing');
  assert.equal(previewSessionStateFromDeployment('bad response', session, preview), 'unknown');
});

test('publish-first progress prints elapsed heartbeats and successful typed platform states', async () => {
  const oldHeartbeat = process.env.SOMEWHERE_PREVIEW_HEARTBEAT_MS;
  const oldLog = console.log;
  const oldError = console.error;
  const lines = [];
  process.env.SOMEWHERE_PREVIEW_HEARTBEAT_MS = '5';
  console.log = (...parts) => lines.push(parts.join(' '));
  console.error = (...parts) => lines.push(parts.join(' '));
  try {
    const result = await runPreviewPhase('Publishing the first production version', async () => {
      await new Promise((resolve) => setTimeout(resolve, 18));
      return { status: 'success', release_publish: true };
    });
    assert.equal(result.release_publish, true);
  } finally {
    console.log = oldLog;
    console.error = oldError;
    if (oldHeartbeat === undefined) delete process.env.SOMEWHERE_PREVIEW_HEARTBEAT_MS;
    else process.env.SOMEWHERE_PREVIEW_HEARTBEAT_MS = oldHeartbeat;
  }
  assert.match(lines.join('\n'), /\(0\.0s\)/);
  assert.match(lines.join('\n'), /still running after/);
  assert.match(lines.join('\n'), /platform state: status=success, release_publish=true/);
});

test('publish-first failures retain the platform code and phase', () => {
  const failure = new CliApiError(
    'RELEASE_PUBLISH_FAILED',
    'The release could not be published.',
    409,
    { phase: 'release_publish', status: 'failed' },
  );
  assert.equal(
    previewPlatformState(failure),
    'code=RELEASE_PUBLISH_FAILED, phase=release_publish, status=failed',
  );
});
