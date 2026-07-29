import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDeploySuccess } from '../dist/commands/deploy.js';

test('formats the current release activation deploy response with its real count and URL', () => {
  const response = {
    project_id: 'proj_release_v1',
    version: 1,
    release_id: 'rel_release_v1',
    active_release_id: 'rel_release_v1',
    base_release_id: null,
    files_deployed: 7,
    has_functions: false,
    warnings: [],
    status: 'success',
    release_publish: true,
  };

  const formatted = formatDeploySuccess(response, {
    functionCount: 0,
    totalBytes: 1024,
    subdomain: 'release-v1-app',
  });

  assert.equal(formatted.staticFileCount, 7);
  assert.equal(formatted.headline, '7 static file(s) deployed (1 KB)');
  assert.equal(formatted.liveUrl, 'https://release-v1-app.somewhere.site');
  assert.equal(formatted.liveMessage, 'Live at https://release-v1-app.somewhere.site');
});

test('reports missing deploy fields honestly without rendering undefined', () => {
  const formatted = formatDeploySuccess(
    { has_functions: false },
    { functionCount: 0, totalBytes: 1024 },
  );

  assert.equal(formatted.staticFileCount, null);
  assert.equal(formatted.headline, 'Static files deployed (1 KB)');
  assert.equal(formatted.liveUrl, null);
  assert.equal(formatted.liveMessage, 'Deployed — check the dashboard for the live URL.');
  assert.doesNotMatch(JSON.stringify(formatted), /undefined/);
});
