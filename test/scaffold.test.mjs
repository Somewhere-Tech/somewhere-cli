import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScaffoldTsconfig,
  buildScaffoldPackageJson,
  sanitizePackageName,
  extractDeps,
} from '../dist/lib/scaffold.js';

test('scaffold tsconfig is valid JSON with the lenient knobs', () => {
  const cfg = JSON.parse(buildScaffoldTsconfig());
  const co = cfg.compilerOptions;
  assert.equal(co.noEmit, true);
  assert.equal(co.skipLibCheck, true);
  assert.equal(co.noImplicitAny, false);
  assert.equal(co.jsx, 'react-jsx');
  assert.equal(co.moduleResolution, 'bundler');
});

test('scaffold package.json carries provided deps and is private', () => {
  const pkg = JSON.parse(buildScaffoldPackageJson('My App', { zod: '^3.22.0' }));
  assert.equal(pkg.private, true);
  assert.equal(pkg.name, 'my-app');
  assert.deepEqual(pkg.dependencies, { zod: '^3.22.0' });
});

test('sanitizePackageName lowercases and strips unsafe chars', () => {
  assert.equal(sanitizePackageName('My Cool App!'), 'my-cool-app');
  assert.equal(sanitizePackageName('  ---  '), 'somewhere-project');
  assert.equal(sanitizePackageName(''), 'somewhere-project');
});

test('extractDeps pulls dependencies from a package.json string, tolerating junk', () => {
  assert.deepEqual(extractDeps(JSON.stringify({ dependencies: { a: '1', b: '2' } })), {
    a: '1',
    b: '2',
  });
  assert.deepEqual(extractDeps(undefined), {});
  assert.deepEqual(extractDeps('not json'), {});
  assert.deepEqual(extractDeps(JSON.stringify({ name: 'x' })), {});
});
