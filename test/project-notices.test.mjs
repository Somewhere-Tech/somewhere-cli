import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatProjectNotice, showProjectNotices } from '../dist/lib/project-notices.js';

const notice = {
  id: 'ant_rate_limit_20260629',
  title: 'Rate-limit requests now reuse the fixed window correctly',
  body_md: 'Some projects may still have the earlier request-counting behavior.',
  severity: 'action_required',
  action_hint: 'Redeploy to pick up the fix.',
  target_runtime_version: 2026070901,
  current_runtime_version: 2026062900,
  created_at: 1783630000000,
};

test('CLI project notice prints once per day per project and stays on stderr-shaped output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somewhere-project-notices-'));
  const statePath = join(dir, 'project-notices.json');
  const lines = [];
  const client = {
    async call() {
      return { project_id: 'project-stale', notices: [notice] };
    },
  };

  const first = await showProjectNotices(client, 'project-stale', {
    now: new Date(2026, 6, 9, 10).getTime(),
    statePath,
    write: (line) => lines.push(line),
  });
  assert.equal(first.length, 1);
  assert.deepEqual(lines, [formatProjectNotice(notice)]);

  const second = await showProjectNotices(client, 'project-stale', {
    now: new Date(2026, 6, 9, 18).getTime(),
    statePath,
    write: (line) => lines.push(line),
  });
  assert.equal(second.length, 0);
  assert.equal(lines.length, 1);

  const nextDay = await showProjectNotices(client, 'project-stale', {
    now: new Date(2026, 6, 10, 10).getTime(),
    statePath,
    write: (line) => lines.push(line),
  });
  assert.equal(nextDay.length, 1);
  assert.equal(lines.length, 2);
  assert.match(readFileSync(statePath, 'utf8'), /ant_rate_limit_20260629/);
});

test('CLI stays silent after the project runtime has picked up the fix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somewhere-project-notices-clear-'));
  const lines = [];
  const client = {
    async call() {
      return { project_id: 'project-rebaked', notices: [] };
    },
  };
  const shown = await showProjectNotices(client, 'project-rebaked', {
    statePath: join(dir, 'project-notices.json'),
    write: (line) => lines.push(line),
  });
  assert.deepEqual(shown, []);
  assert.deepEqual(lines, []);
});
