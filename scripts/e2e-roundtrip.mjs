#!/usr/bin/env node
/**
 * Round-trip invariant gate (tsk_dbc8f506, bug-class family 10):
 *
 *   deploy(tree) → pull → pulled tree is BYTE-IDENTICAL to what was deployed
 *   → deploy --dry-run of the pulled tree reports NO changes.
 *
 * Three fixtures: static-only, functions-only (with _lib/), and mixed with a
 * compiled SPA (src/*.tsx + package.json) — the case where serving state
 * (rewritten index.html, _compiled/ chunks) must NOT leak into pull output.
 *
 * Each fixture runs on a fresh THROWAWAY project, archived afterwards.
 * Requires a logged-in CLI. Run: node scripts/e2e-roundtrip.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://api.somewhere.tech/v1';
const { token } = JSON.parse(readFileSync(join(homedir(), '.somewhere', 'config.json'), 'utf8'));
if (!token) throw new Error('Not logged in');

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const somewhereBin = join(cliRoot, 'bin', 'somewhere.js');
const { classifyKey } = await import(pathToFileURL(join(cliRoot, 'dist', 'lib', 'files.js')).href);

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.data;
}

function cli(args, cwd) {
  return execFileSync('node', [somewhereBin, ...args], { cwd, encoding: 'utf8' });
}

/**
 * Recursive file map keyed by the DEPLOY key (kind:key via the CLI's own
 * classifier) → Buffer. `functions/api/x.ts` and `api/x.ts` are the same
 * deploy key by convention — pull writes the functions/ layout, deploy
 * normalizes it back, so the invariant compares classified keys, not raw
 * relpaths. Skips CLI bookkeeping files.
 */
function treeOf(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === '.somewhere.json' || name === '.DS_Store') continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(dir, full).split('\\').join('/');
        const { kind, key } = classifyKey(rel);
        out.set(`${kind}:${key}`, readFileSync(full));
      }
    }
  };
  walk(dir);
  return out;
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1×1 transparent PNG — binary round-trip coverage.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const FIXTURES = {
  'static-only': (d) => {
    writeFileSync(join(d, 'index.html'), '<!doctype html><html><body><h1>static</h1></body></html>');
    mkdirSync(join(d, 'css'));
    writeFileSync(join(d, 'css', 'style.css'), 'h1 { color: teal; }');
    writeFileSync(join(d, 'logo.png'), PNG);
  },
  'functions-only': (d) => {
    mkdirSync(join(d, 'api'));
    mkdirSync(join(d, '_lib'));
    writeFileSync(join(d, '_lib', 'secret.ts'), 'export const SERVER_ONLY = "do-not-serve";\n');
    writeFileSync(
      join(d, 'api', 'hello.ts'),
      'import { SERVER_ONLY } from "../_lib/secret";\nexport default async function (req, sw) {\n  return Response.json({ ok: SERVER_ONLY.length > 0 });\n}\n',
    );
  },
  'mixed-compiled': (d) => {
    writeFileSync(
      join(d, 'index.html'),
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    );
    mkdirSync(join(d, 'src'));
    writeFileSync(
      join(d, 'src', 'main.tsx'),
      'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
    );
    writeFileSync(
      join(d, 'src', 'App.tsx'),
      'export default function App() { return <h1>mixed</h1>; }\n',
    );
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ name: 'rt-fixture', dependencies: { react: '^18.3.0', 'react-dom': '^18.3.0' } }, null, 2) + '\n',
    );
    mkdirSync(join(d, 'api'));
    writeFileSync(
      join(d, 'api', 'ping.ts'),
      'export default async function (req, sw) { return Response.json({ pong: true }); }\n',
    );
  },
};

const stamp = Date.now().toString(36);
for (const [fixtureName, build] of Object.entries(FIXTURES)) {
  const name = `cli-rt-${fixtureName.replace(/[^a-z]/g, '')}-${stamp}`;
  console.log(`\n── fixture: ${fixtureName} (${name})`);
  const project = await api('POST', '/projects', { name, subdomain: name });
  try {
    const srcDir = mkdtempSync(join(tmpdir(), 'sw-rt-src-'));
    build(srcDir);
    const original = treeOf(srcDir);

    console.log('  deploying...');
    cli(['deploy', '--project', project.id], srcDir);

    const pullDir = mkdtempSync(join(tmpdir(), 'sw-rt-pull-'));
    console.log('  pulling...');
    cli(['pull', project.id, '--out', '.', '--force'], pullDir);
    const pulled = treeOf(pullDir);

    // 1. Byte-identical: same file set, same bytes — and no serving-state
    //    leakage (_compiled/, _internal/, rewritten index.html).
    const missing = [...original.keys()].filter((k) => !pulled.has(k));
    const extra = [...pulled.keys()].filter((k) => !original.has(k));
    const differing = [...original.keys()].filter(
      (k) => pulled.has(k) && !original.get(k).equals(pulled.get(k)),
    );
    check('pull returns every deployed file', missing.length === 0, `missing: ${missing.join(', ')}`);
    check('pull adds no extra files', extra.length === 0, `extra: ${extra.join(', ')}`);
    check('all files byte-identical', differing.length === 0, `differ: ${differing.join(', ')}`);
    check(
      'no serving-state artifacts in pull',
      ![...pulled.keys()].some((k) => {
        const path = k.slice(k.indexOf(':') + 1);
        return path.startsWith('_compiled/') || path.startsWith('_internal/') || path.startsWith('_source/');
      }),
    );

    // 2. deploy --dry-run of the pulled tree must be a no-op.
    const dryRun = cli(['deploy', '--project', project.id, '--dry-run'], pullDir);
    check(
      'deploy(pull(p)) dry-run reports no changes',
      dryRun.includes('No changes'),
      dryRun.split('\n').filter((l) => /Added|Modified|Removed/.test(l)).join(' | ') || dryRun.slice(0, 300),
    );

    // 3. Server-only code never publicly served (pfb_f8d58b19 class).
    if (fixtureName === 'functions-only') {
      const res = await fetch(`https://${project.subdomain}.somewhere.tech/_lib/secret.ts`);
      const text = await res.text();
      check(
        '_lib/ source not publicly served',
        !text.includes('do-not-serve'),
        `GET /_lib/secret.ts → ${res.status}`,
      );
    }

    rmSync(srcDir, { recursive: true, force: true });
    rmSync(pullDir, { recursive: true, force: true });
  } finally {
    await api('POST', `/projects/${project.id}/archive`).catch((e) => console.error('  archive failed:', e.message));
  }
}

console.log(failures === 0 ? '\nROUND-TRIP GATE PASS' : `\nROUND-TRIP GATE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
