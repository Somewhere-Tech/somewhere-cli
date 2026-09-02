/**
 * `somewhere preview` must never change what is live as a side effect.
 *
 * A private preview builds on the project's live version, so a project that has
 * never been published needs one published for it. That publish is a REAL
 * production release — the only thing this command can do to a customer's live
 * site — and every path into it is fixtured here.
 *
 * The bug this file now pins (tsk_5504e045, tsk_f4236589): the live-version read
 * answered `null` for BOTH "nothing is live" and "I could not tell", and the
 * caller published on `null`. A Free account's own production deploy status
 * answers 403 today, so on a published Free project the CLI read 403 -> null ->
 * "never published" and went to publish the working directory over a live app.
 *
 * What is under test is the ORDER and the WRITE, not the call shape: `publish`
 * is injected, so "nothing was created" is proven by it never being invoked.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BaseReleaseUnknownError,
  CloudDevUnavailableError,
  PublishConsentRequiredError,
  readBaseReleaseState,
  readCloudDevAllowed,
  resolveBaseRelease,
} from '../dist/commands/dev.js';

/** A publish spy that records whether a production release was ever created. */
function publishSpy() {
  const calls = [];
  return {
    calls,
    publish: async () => {
      calls.push('published');
    },
  };
}

/** Everything resolveBaseRelease needs, with the safe answer to every question. */
function args(overrides = {}) {
  return {
    cloudDevAllowed: async () => true,
    readBaseReleaseState: async () => ({ known: true, activeReleaseId: null }),
    confirmPublish: async () => 'granted',
    publish: async () => {},
    ...overrides,
  };
}

/* ─── The entitlement is read before anything is written ─────────────────── */

test('an account without private previews is refused and nothing is published', async () => {
  const spy = publishSpy();
  const announced = [];
  let releaseWasRead = false;

  await assert.rejects(
    resolveBaseRelease(args({
      cloudDevAllowed: async () => false,
      publish: spy.publish,
      readBaseReleaseState: async () => {
        releaseWasRead = true;
        return { known: true, activeReleaseId: null };
      },
      announce: (m) => announced.push(m),
    })),
    (err) => {
      assert.ok(err instanceof CloudDevUnavailableError);
      assert.equal(err.code, 'CLOUD_DEV_NOT_ENABLED');
      assert.match(err.message, /Pro and Scale plans/);
      return true;
    },
  );

  assert.deepEqual(spy.calls, [], 'no production release may be created for an unentitled account');
  assert.deepEqual(announced, [], 'and nothing is announced about publishing');
  assert.equal(releaseWasRead, false, 'the refusal lands before any other platform read');
});

/* ─── An unreadable live version never publishes ─────────────────────────── */

test('a live version that cannot be read stops the command instead of publishing', async () => {
  // THE REGRESSION. Before the fix this exact state — the Free 403 on the
  // project's own deploy status — read as "never published" and published the
  // working directory to production over a live app.
  const spy = publishSpy();

  await assert.rejects(
    resolveBaseRelease(args({
      readBaseReleaseState: async () => ({
        known: false,
        reason: '`somewhere preview` is available on the Pro and Scale plans.',
      }),
      publish: spy.publish,
    })),
    (err) => {
      assert.ok(err instanceof BaseReleaseUnknownError);
      assert.equal(err.code, 'BASE_RELEASE_UNKNOWN');
      assert.match(err.message, /Could not tell whether this project already has a live version/);
      assert.match(err.message, /nothing was published/i);
      return true;
    },
  );

  assert.deepEqual(spy.calls, [], 'an unknown live version may never be published over');
});

test('an unknown live version refuses even when the account is entitled and consenting', async () => {
  // Consent covers "publish this directory", never "publish it over whatever
  // might already be there". Unknown is unknown.
  const spy = publishSpy();
  await assert.rejects(
    resolveBaseRelease(args({
      cloudDevAllowed: async () => true,
      confirmPublish: async () => 'granted',
      readBaseReleaseState: async () => ({ known: false, reason: 'network down' }),
      publish: spy.publish,
    })),
    (err) => err instanceof BaseReleaseUnknownError,
  );
  assert.deepEqual(spy.calls, []);
});

/* ─── A published project is never published over ────────────────────────── */

test('a project that already has a live version publishes nothing', async () => {
  const spy = publishSpy();
  const announced = [];
  let asked = false;

  const resolved = await resolveBaseRelease(args({
    readBaseReleaseState: async () => ({ known: true, activeReleaseId: 'rel_live' }),
    publish: spy.publish,
    confirmPublish: async () => {
      asked = true;
      return 'granted';
    },
    announce: (m) => announced.push(m),
  }));

  assert.deepEqual(resolved, { baseReleaseId: 'rel_live', published: false });
  assert.deepEqual(spy.calls, [], 'the live version is built on, never replaced');
  assert.deepEqual(announced, [], 'and nothing about publishing is said');
  assert.equal(asked, false, 'nobody is asked to consent to a publish that is not happening');
});

test('an unknown entitlement on an already-published project does not block the preview', async () => {
  // The narrow rule-9 guarantee: a read that did not answer must not tell a
  // working account to upgrade. Only the WRITE path tightened.
  const spy = publishSpy();
  const resolved = await resolveBaseRelease(args({
    cloudDevAllowed: async () => null,
    readBaseReleaseState: async () => ({ known: true, activeReleaseId: 'rel_live' }),
    publish: spy.publish,
  }));
  assert.equal(resolved.baseReleaseId, 'rel_live');
  assert.deepEqual(spy.calls, []);
});

/* ─── The publish itself requires consent ────────────────────────────────── */

test('a never-published project publishes once, announced, after consent', async () => {
  const spy = publishSpy();
  const announced = [];
  const reads = [];

  const resolved = await resolveBaseRelease(args({
    cloudDevAllowed: async () => true,
    readBaseReleaseState: async () => {
      reads.push('read');
      return reads.length === 1
        ? { known: true, activeReleaseId: null }
        : { known: true, activeReleaseId: 'rel_first' };
    },
    confirmPublish: async () => 'granted',
    publish: spy.publish,
    announce: (m) => announced.push(m),
  }));

  assert.deepEqual(resolved, { baseReleaseId: 'rel_first', published: true });
  assert.deepEqual(spy.calls, ['published'], 'exactly one publish');
  assert.equal(announced.length, 2, 'the publish is announced, never silent');
  assert.match(announced.join(' '), /never been published/);
  assert.match(announced.join(' '), /in front of your users/);
});

test('a declined confirmation publishes nothing', async () => {
  const spy = publishSpy();
  await assert.rejects(
    resolveBaseRelease(args({ confirmPublish: async () => 'declined', publish: spy.publish })),
    (err) => {
      assert.ok(err instanceof PublishConsentRequiredError);
      assert.equal(err.code, 'PUBLISH_CONSENT_REQUIRED');
      assert.equal(err.why, 'declined');
      return true;
    },
  );
  assert.deepEqual(spy.calls, []);
});

test('a shell that cannot be asked publishes nothing', async () => {
  // Consent that cannot be given is not consent. An agent or CI run gets the
  // refusal and the flag that grants it up front.
  const spy = publishSpy();
  await assert.rejects(
    resolveBaseRelease(args({ confirmPublish: async () => 'not-asked', publish: spy.publish })),
    (err) => err instanceof PublishConsentRequiredError && err.why === 'not-asked',
  );
  assert.deepEqual(spy.calls, []);
});

test('a publish whose result cannot be read back is reported, not guessed at', async () => {
  const spy = publishSpy();
  const reads = [];
  await assert.rejects(
    resolveBaseRelease(args({
      readBaseReleaseState: async () => {
        reads.push('read');
        return reads.length === 1
          ? { known: true, activeReleaseId: null }
          : { known: false, reason: 'network down' };
      },
      publish: spy.publish,
    })),
    (err) => {
      assert.ok(err instanceof BaseReleaseUnknownError);
      assert.match(err.message, /published, but the live version could not be read back/);
      return true;
    },
  );
  assert.deepEqual(spy.calls, ['published'], 'the publish that did happen is not denied');
});

/* ─── Reading the live version: every answer, in both directions ─────────── */

test('a live release id is read as known', async () => {
  const call = async () => ({ ok: true, data: { published: true, active_release_id: 'rel_live' } });
  assert.deepEqual(await readBaseReleaseState('proj_1', call), {
    known: true,
    activeReleaseId: 'rel_live',
  });
});

test('an explicit "not published" is the one answer that may lead to a publish', async () => {
  const call = async () => ({ ok: true, data: { published: false, active_release_id: null } });
  assert.deepEqual(await readBaseReleaseState('proj_1', call), {
    known: true,
    activeReleaseId: null,
  });
});

test('a refused status read is unknown, never "never published"', async () => {
  // The live 403: a Free account cannot read its own production deploy status
  // (tsk_f4236589). The CLI must not turn that into a claim about publish state.
  const call = async () => {
    throw new Error('CLOUD_DEV_NOT_ENABLED: `somewhere preview` is available on the Pro and Scale plans.');
  };
  const state = await readBaseReleaseState('proj_1', call);
  assert.equal(state.known, false);
  assert.match(state.reason, /Pro and Scale plans/);
});

test('a dropped connection is unknown', async () => {
  const call = async () => {
    throw new Error('fetch failed');
  };
  assert.equal((await readBaseReleaseState('proj_1', call)).known, false);
});

test('a published project that does not name its version is unknown, not empty', async () => {
  // The asymmetry that keeps a live app safe: published with no id readable is
  // still a live app, and must never be treated as a blank project to publish
  // over.
  const call = async () => ({ ok: true, data: { published: true, active_release_id: null } });
  assert.equal((await readBaseReleaseState('proj_1', call)).known, false);
});

test('a status shape this CLI does not recognise is unknown', async () => {
  const call = async () => ({ ok: true, data: { something_else: 1 } });
  assert.equal((await readBaseReleaseState('proj_1', call)).known, false);
});

test('the live-version read asks the platform about this project', async () => {
  const calls = [];
  const call = async (name, callArgs, options) => {
    calls.push({ name, args: callArgs, options });
    return { ok: true, data: { published: false } };
  };
  await readBaseReleaseState('proj_1', call);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'deploy_status');
  assert.deepEqual(calls[0].args, { project_id: 'proj_1' });
});

/* ─── Reading the entitlement ────────────────────────────────────────────── */

test('the entitlement check reads the platform answer for this project', async () => {
  const calls = [];
  const call = async (name, callArgs, options) => {
    calls.push({ name, args: callArgs, options });
    return { ok: true, data: { id: 'proj_1', cloud_dev_allowed: false } };
  };

  assert.equal(await readCloudDevAllowed('proj_1', call), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'project_get');
  assert.deepEqual(calls[0].args, { project_id: 'proj_1' });
});

test('the entitlement check reports true when the account has private previews', async () => {
  const call = async () => ({ ok: true, data: { cloud_dev_allowed: true } });
  assert.equal(await readCloudDevAllowed('proj_1', call), true);
});

test('a platform that does not report the field answers unknown, not denied', async () => {
  const call = async () => ({ ok: true, data: { id: 'proj_1' } });
  assert.equal(await readCloudDevAllowed('proj_1', call), null);
});

test('a failed read answers unknown, not denied', async () => {
  const call = async () => {
    throw new Error('network down');
  };
  assert.equal(await readCloudDevAllowed('proj_1', call), null);
});

/* ─── The refusal copy states only what was actually read ────────────────── */

test('no refusal claims this project has not been published', async () => {
  // The line that shipped in 0.31.0 — "Nothing was created — this project has
  // not been published." — was printed on a project that WAS published, because
  // it was derived from the read that had just failed. A refusal may say what
  // it did (nothing) and never what it could not read.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/commands/dev.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /this project has not been published/);
  assert.match(source, /Nothing was created or changed — whatever is live stays live\./);
});
