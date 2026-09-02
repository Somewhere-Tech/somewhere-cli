/**
 * `somewhere dev --cloud` must not publish before it knows the account can use it.
 *
 * A private preview builds on the project's live version, so a never-published
 * project gets one published for it. That publish is a REAL production release.
 * Private previews are also a plan feature, enforced by the platform on the
 * preview request — the step after that publish. Before tsk_cf48f4ab an account
 * without private previews therefore got a live first version it never asked
 * for, and only then the refusal.
 *
 * What is under test here is the ORDER, not the call shape: `publish` is
 * injected, so "nothing was created" is proven by it never being invoked.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CloudDevUnavailableError,
  ensureBaseRelease,
  readCloudDevAllowed,
} from '../dist/commands/dev.js';

/** A publish spy that records whether the release was ever created. */
function publishSpy() {
  const calls = [];
  return {
    calls,
    publish: async () => {
      calls.push('published');
    },
  };
}

test('an account without private previews is refused and nothing is published', async () => {
  const spy = publishSpy();
  const announced = [];

  await assert.rejects(
    ensureBaseRelease({
      cloudDevAllowed: async () => false,
      publish: spy.publish,
      readActiveReleaseId: async () => 'rel_should_never_be_read',
      announce: (m) => announced.push(m),
    }),
    (err) => {
      assert.ok(err instanceof CloudDevUnavailableError);
      assert.equal(err.code, 'CLOUD_DEV_NOT_ENABLED');
      assert.match(err.message, /Pro and Scale plans/);
      return true;
    },
  );

  assert.deepEqual(spy.calls, [], 'no production release may be created for an unentitled account');
  assert.deepEqual(announced, [], 'and nothing is announced about publishing');
});

test('an entitled account on a never-published project publishes once, announced', async () => {
  const spy = publishSpy();
  const announced = [];

  const base = await ensureBaseRelease({
    cloudDevAllowed: async () => true,
    publish: spy.publish,
    readActiveReleaseId: async () => 'rel_first',
    announce: (m) => announced.push(m),
  });

  assert.equal(base, 'rel_first');
  assert.deepEqual(spy.calls, ['published'], 'exactly one publish');
  assert.equal(announced.length, 2, 'the publish is announced, never silent');
  assert.match(announced.join(' '), /never been published/);
  assert.match(announced.join(' '), /stays private to you/);
});

test('an unknown entitlement answer never refuses — it must not block a working account', async () => {
  // The platform not saying is not the platform saying no. A read that fails,
  // or a platform that stops reporting the field, must leave today's working
  // behaviour exactly as it is.
  const spy = publishSpy();

  const base = await ensureBaseRelease({
    cloudDevAllowed: async () => null,
    publish: spy.publish,
    readActiveReleaseId: async () => 'rel_first',
  });

  assert.equal(base, 'rel_first');
  assert.deepEqual(spy.calls, ['published']);
});

test('the entitlement check reads the platform answer for this project', async () => {
  const calls = [];
  const call = async (name, args, options) => {
    calls.push({ name, args, options });
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
