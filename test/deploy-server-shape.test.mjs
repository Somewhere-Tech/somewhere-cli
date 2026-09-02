import test from 'node:test';
import assert from 'node:assert/strict';
import { detectNodeServerShape, isNextAppShapeSignal } from '../dist/commands/deploy.js';
import { createHappyPathTemplate } from '../dist/lib/init-template.js';

// tsk_8e8c6bc8 — the Express-instinct pre-flight. The rule-9 fixture pair:
// the intended target fires, real-world legitimate patterns pass clean.

test('fires on express in package.json dependencies with no functions/', () => {
  const files = {
    'package.json': JSON.stringify({ dependencies: { express: '^4.18.0' } }),
    'server.js': "const express = require('express');",
    'index.html': '<html></html>',
  };
  const signal = detectNodeServerShape(files, {});
  assert.ok(signal, 'expected a server signal');
  assert.match(signal, /express/);
});

test('fires on root app.listen without any framework dep', () => {
  const files = {
    'server.js': "const http = require('http');\nconst app = makeApp();\napp.listen(3000);",
  };
  const signal = detectNodeServerShape(files, {});
  assert.ok(signal);
  assert.match(signal, /server\.js/);
});

test('passes clean: plain static site', () => {
  const files = { 'index.html': '<html></html>', 'style.css': 'body{}' };
  assert.equal(detectNodeServerShape(files, {}), null);
});

test('passes clean: correct platform shape (functions/ present) even with a dev-server script', () => {
  const files = {
    'package.json': JSON.stringify({ dependencies: { express: '^4.18.0' } }),
    'dev-server.js': 'app.listen(3000);',
    'index.html': '<html></html>',
  };
  const functions = { 'functions/api/hello.js': 'export default async function (req, sw) {}' };
  assert.equal(detectNodeServerShape(files, functions), null);
});

test('fires on Next.js in package.json dependencies even when functions/ exists', () => {
  const files = {
    'package.json': JSON.stringify({ dependencies: { next: '^15.0.0', react: '^19.0.0' } }),
    'functions/hello.js': 'export default async function (req, sw) {}',
  };
  const functions = { 'functions/hello.js': 'export default async function (req, sw) {}' };
  const signal = detectNodeServerShape(files, functions);
  assert.ok(signal, 'expected a Next.js signal');
  assert.ok(isNextAppShapeSignal(signal));
  assert.match(signal, /next/);
});

test('fires on next.config files', () => {
  const files = {
    'next.config.mjs': 'export default {};',
    'index.html': '<html></html>',
  };
  const signal = detectNodeServerShape(files, {});
  assert.ok(signal, 'expected a Next.js signal');
  assert.ok(isNextAppShapeSignal(signal));
  assert.match(signal, /next\.config\.mjs/);
});

// tsk_8a9d2d1a — the pre-flight used to accuse our OWN starter of being a
// Next.js app, on a new developer's very first deploy, because it matched
// router PATHS (`src/pages/*.tsx`) with no corroborating signal. The rule now
// matches the platform's exactly: a next.config.*, or `next` in a dependency
// section. These are the both-direction fixtures rule 9 asks for — the
// intended target fires, and every real-world layout that tripped it is quiet.

test('the somewhere init scaffold is quiet — no framework notice on a first deploy', () => {
  // The actual scaffold, not a hand-written lookalike: the fixture has to move
  // when the scaffold moves, or this bug comes back the next time it changes.
  const scaffold = createHappyPathTemplate();
  const files = {};
  const functions = {};
  for (const { path, content } of scaffold) {
    if (path.startsWith('api/')) functions[path] = content;
    else files[path] = content;
  }

  assert.ok(
    Object.keys(files).some((p) => /^src\/pages\/.+\.tsx$/.test(p)),
    'the scaffold really does ship src/pages/*.tsx — the shape that used to trip this',
  );
  assert.equal(
    detectNodeServerShape(files, functions),
    null,
    'our own starter must deploy without being told it is a Next.js app',
  );
  // And still quiet with no functions at all, so the negative does not depend
  // on the trust gate alone.
  assert.equal(detectNodeServerShape(files, {}), null);
});

test('a plain Vite React app using src/pages/ is quiet', () => {
  const files = {
    'package.json': JSON.stringify({ dependencies: { react: '^19.2.0' }, devDependencies: { vite: '^8.0.0' } }),
    'index.html': '<html></html>',
    'src/main.tsx': 'export {};',
    'src/pages/HomePage.tsx': 'export default function HomePage() { return null; }',
    'src/pages/AboutPage.tsx': 'export default function AboutPage() { return null; }',
  };
  assert.equal(detectNodeServerShape(files, {}), null);
});

test('an app-router-shaped path with no next dependency is quiet', () => {
  // `src/app/dashboard/page.tsx` is a perfectly ordinary Vite path. Without
  // `next` anywhere it is not evidence of anything.
  const files = { 'src/app/dashboard/page.tsx': 'export default function Page() { return null; }' };
  assert.equal(detectNodeServerShape(files, {}), null);
});

test('a static HTML site is quiet', () => {
  assert.equal(detectNodeServerShape({ 'index.html': '<html></html>', 'style.css': 'body{}' }, {}), null);
});

test('a functions-only project is quiet', () => {
  assert.equal(
    detectNodeServerShape({ 'package.json': '{}' }, { 'api/hello.ts': 'export default async () => new Response("ok");' }),
    null,
  );
});

test('a real Next.js app still fires — via its dependency', () => {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const files = {
      'package.json': JSON.stringify({ [section]: { next: '^15.0.0' } }),
      'src/app/page.tsx': 'export default function Page() {}',
    };
    const signal = detectNodeServerShape(files, {});
    assert.ok(signal, `expected a Next.js signal from ${section}`);
    assert.ok(isNextAppShapeSignal(signal));
    assert.match(signal, new RegExp(section));
  }
});

test('a bare next.config still fires, in any directory and any extension', () => {
  for (const path of ['next.config.mjs', 'next.config.ts', 'next.config.js', 'app/next.config.mjs']) {
    const signal = detectNodeServerShape({ [path]: 'export default {};' }, {});
    assert.ok(signal, `expected a Next.js signal from ${path}`);
    assert.ok(isNextAppShapeSignal(signal));
  }
});

test('passes clean: app.listen deep in a vendored tree is not a signal', () => {
  const files = {
    'index.html': '<html></html>',
    'vendor/some-lib/server.js': 'app.listen(3000);',
  };
  assert.equal(detectNodeServerShape(files, {}), null);
});

test('passes clean: frontend framework deps are not server frameworks', () => {
  const files = {
    'package.json': JSON.stringify({ dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } }),
    'index.html': '<html></html>',
  };
  assert.equal(detectNodeServerShape(files, {}), null);
});

test('survives unparseable package.json', () => {
  const files = { 'package.json': '{not json', 'index.html': '<html></html>' };
  assert.equal(detectNodeServerShape(files, {}), null);
});
