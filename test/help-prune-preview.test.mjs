// tsk_cd5cbc86 (CLI help half): deploy and promote both state what happens to
// functions missing from the source. tsk_35c1bb78 / tsk_ac45ad01: the new
// preview and browser options are discoverable from --help.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const help = (...args) => {
  const home = mkdtempSync(join(tmpdir(), 'sw-help-home-'));
  const result = spawnSync(process.execPath, [distIndex, ...args, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\s+/g, ' ');
};

test('deploy and promote help state the opposite defaults for missing functions', () => {
  const deploy = help('deploy');
  assert.match(deploy, /a full `somewhere deploy` REMOVES deployed functions that are not in this directory/);
  assert.match(deploy, /`somewhere promote` is the opposite: it keeps them unless --prune/);
  const promote = help('promote');
  assert.match(promote, /promote KEEPS production functions the preview does not include, unless --prune/);
  assert.match(promote, /A full `somewhere deploy` is the opposite/);
});

test('preview help lists --once and the link subcommand; browser help lists --close and --auth-user', () => {
  const preview = help('preview');
  assert.match(preview, /--once Sync once, print the preview link and promote command, and exit/);
  assert.match(preview, /link \[options\] Mint a fresh single-use link to the open preview/);
  const link = help('preview', 'link');
  assert.match(link, /--preview-session <id>/);
  const browser = help('browser');
  assert.match(browser, /--close <session>/);
  assert.match(browser, /--auth-user <email\|user_id>/);
  assert.match(browser, /end after 5 min idle or 10 min in total/);
});
