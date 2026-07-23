import assert from 'node:assert/strict';
import test from 'node:test';
import { callDraftCandidate } from '../dist/commands/dev.js';
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
