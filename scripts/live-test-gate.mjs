// tsk_fc1afab0: the one gate for tests and scripts that deploy to the real
// platform. Both an explicit opt-in and an explicit test credential are
// required, and both come from the environment only. The signed-in
// ~/.somewhere/config.json is never read, so nothing behind this gate deploys
// implicitly or acts on the developer's account. It covers only the
// entrypoints that use it; it does not make the rest of the suite offline.

export const LIVE_DEPLOY_OPT_IN = 'SOMEWHERE_LIVE_DEPLOY_TEST';
export const LIVE_TEST_TOKEN = 'SOMEWHERE_TEST_TOKEN';

/** `{ ok: true, token }` only when `SOMEWHERE_LIVE_DEPLOY_TEST=1` and
 *  `SOMEWHERE_TEST_TOKEN` are both set; otherwise `{ ok: false, reason }`. */
export function liveDeployCredential(env = process.env) {
  if (env[LIVE_DEPLOY_OPT_IN] !== '1') {
    return {
      ok: false,
      reason: `SOMEWHERE_LIVE_DEPLOY_SKIPPED: ${LIVE_DEPLOY_OPT_IN}=1 is not set. This deploys to the real platform, so it runs only on explicit opt-in.`,
    };
  }
  const token = typeof env[LIVE_TEST_TOKEN] === 'string' ? env[LIVE_TEST_TOKEN].trim() : '';
  if (!token) {
    return {
      ok: false,
      reason: `SOMEWHERE_LIVE_DEPLOY_SKIPPED: ${LIVE_TEST_TOKEN} is not set. Live tests use only an explicit test credential, never the signed-in ~/.somewhere/config.json.`,
    };
  }
  return { ok: true, token };
}
