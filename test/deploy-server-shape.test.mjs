import test from 'node:test';
import assert from 'node:assert/strict';
import { detectNodeServerShape, isNextAppShapeSignal } from '../dist/commands/deploy.js';

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

test('fires on Next.js app and pages router signatures', () => {
  const appSignal = detectNodeServerShape({ 'src/app/dashboard/page.tsx': 'export default function Page() {}' }, {});
  assert.ok(appSignal, 'expected an app router signal');
  assert.ok(isNextAppShapeSignal(appSignal));

  const pagesSignal = detectNodeServerShape({ 'pages/api/hello.ts': 'export default function handler() {}' }, {});
  assert.ok(pagesSignal, 'expected a pages router signal');
  assert.ok(isNextAppShapeSignal(pagesSignal));
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
