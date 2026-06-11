import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRoutes, compileRoutePattern, matchRoute, isRoutable } from '../dist/local/router.js';

const files = (...names) => names.map((n) => ({ file: n, absPath: '/x/' + n }));

test('static, param, catch-all display paths', () => {
  assert.equal(compileRoutePattern('api/hello.ts').displayPath, '/api/hello');
  assert.equal(compileRoutePattern('api/sites/[id].ts').displayPath, '/api/sites/:id');
  assert.equal(compileRoutePattern('api/files/[...path].ts').displayPath, '/api/files/*path');
  assert.equal(compileRoutePattern('[...path].ts').displayPath, '/*path');
});

test('routability matches deploy rules', () => {
  assert.ok(isRoutable('api/hello.ts'));
  assert.ok(isRoutable('[...path].ts'));
  assert.ok(isRoutable('[id].ts'));
  assert.ok(!isRoutable('_lib/db.ts'));
  assert.ok(!isRoutable('helpers.ts'));
});

test('specificity: static > param > rest', () => {
  const routes = compileRoutes(
    files('api/sites/[id].ts', 'api/sites/new.ts', 'api/[...rest].ts', '[...all].ts'),
  );
  assert.equal(matchRoute(routes, '/api/sites/new').route.file, 'api/sites/new.ts');
  const m = matchRoute(routes, '/api/sites/abc123');
  assert.equal(m.route.file, 'api/sites/[id].ts');
  assert.equal(m.params.id, 'abc123');
  const rest = matchRoute(routes, '/api/other/deep/path');
  assert.equal(rest.route.file, 'api/[...rest].ts');
  assert.equal(rest.params.rest, 'other/deep/path');
  const root = matchRoute(routes, '/anything/else');
  assert.equal(root.route.file, '[...all].ts');
  assert.equal(root.params.all, 'anything/else');
});

test('root catch-all matches /', () => {
  const routes = compileRoutes(files('[...all].ts'));
  const m = matchRoute(routes, '/');
  assert.equal(m.route.file, '[...all].ts');
  assert.equal(m.params.all, '');
});

test('params are URI-decoded', () => {
  const routes = compileRoutes(files('api/sites/[id].ts'));
  const m = matchRoute(routes, '/api/sites/a%20b');
  assert.equal(m.params.id, 'a b');
});

test('no match → null; ambiguous routes throw', () => {
  const routes = compileRoutes(files('api/hello.ts'));
  assert.equal(matchRoute(routes, '/api/nope'), null);
  assert.throws(
    () => compileRoutes(files('api/hello.ts', 'api/hello.js')),
    /same route/,
  );
});

test('catch-all must be last segment', () => {
  assert.throws(() => compileRoutePattern('api/[...x]/more.ts'), /must be the last/);
});
