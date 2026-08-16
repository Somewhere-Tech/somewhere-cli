import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRollbackSuccess } from '../dist/commands/rollback.js';

test('rollback success includes the restored-file count when the API returns it', () => {
  const line = formatRollbackSuccess({ version: 4, files_restored: 3 });

  assert.equal(line, 'Rolled back to v4 (3 files restored)');
  assert.doesNotMatch(line, /null|undefined/);
});

test('rollback success omits the restored-file parenthetical when the API omits the count', () => {
  const line = formatRollbackSuccess({ version: 4 });

  assert.equal(line, 'Rolled back to v4');
  assert.doesNotMatch(line, /null|undefined/);
});
