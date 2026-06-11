import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvFile } from '../dist/local/envfile.js';

test('parses simple, quoted, exported, and comment lines', () => {
  const parsed = parseEnvFile(
    [
      '# comment',
      'PLAIN=hello',
      'QUOTED="with spaces"',
      "SINGLE='single'",
      'export EXPORTED=yes',
      'EQ_IN_VALUE=a=b=c',
      'EMPTY=',
      'bad-key=skipped',
      '   ',
    ].join('\n'),
  );
  assert.deepEqual(parsed, {
    PLAIN: 'hello',
    QUOTED: 'with spaces',
    SINGLE: 'single',
    EXPORTED: 'yes',
    EQ_IN_VALUE: 'a=b=c',
    EMPTY: '',
  });
});
