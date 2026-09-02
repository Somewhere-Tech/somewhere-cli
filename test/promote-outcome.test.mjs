import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CliApiError } from '../dist/lib/client.js';
import {
  describeUnreadablePromote,
  isUnreadablePromoteResponse,
  promoteVerdictFromPointer,
  refusalContradictsProduction,
} from '../dist/lib/promote-outcome.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// tsk_33023348 — a promote that lands must never be reported as a failure, and
// a refusal must never assert "production was not changed" unchecked.

test('a readable refusal is a decision; anything else leaves the outcome unknown', () => {
  // The platform read the request and refused it — its word stands.
  assert.equal(
    isUnreadablePromoteResponse(new CliApiError('DRAFT_VERSION_MISMATCH', 'no', 409)),
    false,
  );
  assert.equal(isUnreadablePromoteResponse(new CliApiError('PROMOTION_CONFLICT', 'no', 409)), false);

  // No HTTP response at all: the flip may have landed before the socket died.
  assert.equal(isUnreadablePromoteResponse(new CliApiError('NETWORK_ERROR', 'x', 0)), true);
  assert.equal(isUnreadablePromoteResponse(new CliApiError('TIMEOUT', 'x', 0)), true);
  // The platform broke mid-flight, or answered a shape we cannot classify.
  assert.equal(isUnreadablePromoteResponse(new CliApiError('INTERNAL', 'x', 503)), true);
  assert.equal(isUnreadablePromoteResponse(new CliApiError('UNKNOWN', 'Unknown error', 502)), true);
  assert.equal(isUnreadablePromoteResponse(new CliApiError('INVALID_RESPONSE', 'html', 200)), true);
  // Not even an API error — a thrown Error from anywhere in the path.
  assert.equal(isUnreadablePromoteResponse(new Error('boom')), true);
});

test('DIRECTION 1: a transport failure AFTER the flip is reported as the success it was', () => {
  const verdict = promoteVerdictFromPointer({
    before: { known: true, releaseId: 'rel_2b0ddfc5', version: 1 },
    after: { known: true, releaseId: 'rel_a7538b61', version: 2 },
  });
  assert.deepEqual(verdict, { kind: 'applied', activeReleaseId: 'rel_a7538b61' });

  const described = describeUnreadablePromote(verdict);
  assert.equal(described.succeeded, true);
  assert.match(described.headline, /Promoted to production/);
  // Rule 8: the customer sentence carries no release id and no internal noun.
  assert.doesNotMatch(`${described.headline} ${described.detail}`, /rel_|draft_|active_release_id/);
  // The exact falsehood the bug printed must not be reachable from a success.
  assert.doesNotMatch(described.headline, /Promote failed|Unknown error/);
});

test('DIRECTION 2: a real failure with production untouched is still reported as a failure', () => {
  const verdict = promoteVerdictFromPointer({
    before: { known: true, releaseId: 'rel_2b0ddfc5', version: 1 },
    after: { known: true, releaseId: 'rel_2b0ddfc5', version: 1 },
  });
  assert.deepEqual(verdict, { kind: 'not_applied', activeReleaseId: 'rel_2b0ddfc5' });

  const described = describeUnreadablePromote(verdict);
  assert.equal(described.succeeded, false);
  assert.match(described.headline, /Production was not changed/);
});

test('a pointer the CLI could not read never becomes evidence in either direction', () => {
  for (const args of [
    { before: { known: false }, after: { known: true, releaseId: 'rel_b', version: 2 } },
    { before: { known: true, releaseId: 'rel_a', version: 1 }, after: { known: false } },
    { before: { known: false }, after: { known: false } },
  ]) {
    assert.equal(promoteVerdictFromPointer(args).kind, 'unknown');
  }
  const described = describeUnreadablePromote({ kind: 'unknown' });
  assert.equal(described.succeeded, false);
  assert.match(described.headline, /unknown/i);
  // It must not claim either outcome.
  assert.doesNotMatch(described.headline, /Production was not changed/);
  assert.doesNotMatch(described.detail, /Production was not changed/);
});

test('DIRECTION 3: a real refusal is passed through, and only corrected when production moved', () => {
  const refusal =
    'This preview is no longer open or ready. Production was not changed.';

  // The honest case: production is exactly where the CLI left it, so the
  // platform's claim stands untouched.
  assert.equal(
    refusalContradictsProduction({
      message: refusal,
      expectedUnchanged: 'rel_a',
      after: { known: true, releaseId: 'rel_a', version: 1 },
    }),
    false,
  );

  // The bug: an earlier attempt DID land, so "Production was not changed" is
  // false and the CLI must say so.
  assert.equal(
    refusalContradictsProduction({
      message: refusal,
      expectedUnchanged: 'rel_a',
      after: { known: true, releaseId: 'rel_b', version: 2 },
    }),
    true,
  );

  // Never contradict on a guess: no baseline, or no readable pointer.
  assert.equal(
    refusalContradictsProduction({
      message: refusal,
      expectedUnchanged: null,
      after: { known: true, releaseId: 'rel_b', version: 2 },
    }),
    false,
  );
  assert.equal(
    refusalContradictsProduction({
      message: refusal,
      expectedUnchanged: 'rel_a',
      after: { known: false },
    }),
    false,
  );

  // A refusal that makes no claim about production is never rewritten.
  assert.equal(
    refusalContradictsProduction({
      message: 'Preview is still building.',
      expectedUnchanged: 'rel_a',
      after: { known: true, releaseId: 'rel_b', version: 2 },
    }),
    false,
  );
});

test('promote reads the production pointer on both sides of the call', () => {
  const promote = read('src/commands/promote.ts');
  // The baseline must be taken BEFORE the request, or there is nothing to
  // compare against afterwards.
  const beforeIdx = promote.indexOf('const pointerBefore = await readActivePointer(projectId)');
  const callIdx = promote.indexOf("client.call<PromoteResult>('POST', '/promote'");
  assert.ok(beforeIdx > 0 && callIdx > beforeIdx);
  // A tri-state read: a failed read must not look like "nothing is live".
  assert.match(promote, /return \{ known: false \};/);
  assert.match(promote, /isUnreadablePromoteResponse\(err\)/);
  assert.match(promote, /refusalContradictsProduction\(/);
  // Every response, success or failure, can be traced back to one request.
  assert.match(promote, /formatErrorReference\(err\.meta\)/);
});
