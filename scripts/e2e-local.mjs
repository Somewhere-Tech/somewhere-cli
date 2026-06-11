#!/usr/bin/env node
/**
 * Live e2e for `somewhere exec` / the local function runtime.
 *
 * Creates a THROWAWAY project (cli-e2e-local-*), runs a sample function
 * locally via `somewhere exec` with sw.* proxied to the real platform, and
 * verifies: db query round-trip, fs write/read, env read (local .env value),
 * cross-file extensionless import, sw.endpoint wrapper, and the fail-loud
 * sw.env throw for platform keys with no local value. Archives the project
 * at the end. Never touches a real customer project.
 *
 * Requires a logged-in CLI (~/.somewhere/config.json).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.somewhere.tech/v1';
const { token } = JSON.parse(readFileSync(join(homedir(), '.somewhere', 'config.json'), 'utf8'));
if (!token) throw new Error('Not logged in (no token in ~/.somewhere/config.json)');

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const somewhereBin = join(cliRoot, 'bin', 'somewhere.js');

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

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const stamp = Date.now().toString(36);
const name = `cli-e2e-local-${stamp}`;
console.log(`Creating throwaway project ${name}...`);
const project = await api('POST', '/projects', { name, subdomain: name });
console.log(`  id: ${project.id}`);

let exitCode = 1;
try {
  // Platform env: one var we'll mirror locally, one we deliberately won't —
  // the second must THROW on access (fail-loud sw.env).
  await api('POST', '/env', { project_id: project.id, key: 'E2E_LOCAL_VALUE', value: 'platform-side' });
  await api('POST', '/env', { project_id: project.id, key: 'E2E_MISSING_VALUE', value: 'platform-side' });

  const dir = mkdtempSync(join(tmpdir(), 'sw-e2e-local-'));
  mkdirSync(join(dir, 'api'), { recursive: true });
  mkdirSync(join(dir, '_lib'), { recursive: true });

  writeFileSync(join(dir, '.env'), 'E2E_LOCAL_VALUE=local-side\n');
  writeFileSync(
    join(dir, '_lib', 'helper.ts'),
    `export function shout(s: string): string { return s.toUpperCase(); }\n`,
  );
  writeFileSync(
    join(dir, 'api', 'e2e.ts'),
    `import { shout } from '../_lib/helper';

export default async function (req: Request, sw: any) {
  const out: Record<string, unknown> = {};

  const r = await sw.db.query('SELECT 1 + 1 AS two');
  out.db = { two: r.data[0]?.two, count: r.count, changes: r.changes };

  await sw.fs.write('/e2e/probe.txt', 'hello-from-local', { contentType: 'text/plain' });
  const read = await sw.fs.read('/e2e/probe.txt');
  out.fs = await read.text();

  out.env = sw.env.E2E_LOCAL_VALUE;
  out.helper = shout('imported');
  out.ctx_alias_same = typeof sw.endpoint === 'function' || typeof (globalThis as any).sw?.endpoint === 'function';

  let envThrew = '';
  try {
    void sw.env.E2E_MISSING_VALUE;
  } catch (e: any) {
    envThrew = e.message;
  }
  out.env_throw = envThrew;

  return Response.json({ ok: true, out });
}
`,
  );
  writeFileSync(
    join(dir, 'api', 'wrapped.ts'),
    `export default (globalThis as any).sw.endpoint({
  auth: 'none',
  body: { name: 'string' },
  handler: async ({ body }: any) => ({ greeted: 'hi ' + body.name }),
});
`,
  );

  console.log('Running somewhere exec api/e2e.ts ...');
  const execOut = execFileSync(
    'node',
    [somewhereBin, 'exec', 'api/e2e.ts', '--project', project.id, '--method', 'POST', '--body', '{}'],
    { cwd: dir, encoding: 'utf8' },
  );
  console.log(execOut.split('\n').map((l) => '    ' + l).join('\n'));

  const jsonStart = execOut.indexOf('{');
  const parsed = JSON.parse(execOut.slice(jsonStart, execOut.lastIndexOf('}') + 1));
  const out = parsed.out ?? {};

  check('db query round-trip (r.data/r.count shape)', out.db?.two === 2 && out.db?.count === 1, JSON.stringify(out.db));
  check('fs write/read round-trip', out.fs === 'hello-from-local', JSON.stringify(out.fs));
  check('env read (local .env value)', out.env === 'local-side', JSON.stringify(out.env));
  check('cross-file extensionless import', out.helper === 'IMPORTED');
  check('sw.endpoint available at module load', out.ctx_alias_same === true);
  check(
    'sw.env fail-loud throw for platform-only key',
    typeof out.env_throw === 'string' && out.env_throw.includes('E2E_MISSING_VALUE'),
    JSON.stringify(out.env_throw),
  );

  console.log('Running somewhere exec api/wrapped.ts (sw.endpoint validation)...');
  const wrappedOut = execFileSync(
    'node',
    [somewhereBin, 'exec', 'api/wrapped.ts', '--project', project.id, '--method', 'POST', '--body', '{"name":"e2e"}'],
    { cwd: dir, encoding: 'utf8' },
  );
  check('sw.endpoint handler', wrappedOut.includes('"greeted": "hi e2e"'), wrappedOut.slice(0, 200));

  // validation rejection comes back as a 400 VALIDATION_ERROR envelope
  // (exec exits 0 on 4xx — only 5xx is a failure exit)
  const wrappedBad = execFileSync(
    'node',
    [somewhereBin, 'exec', 'api/wrapped.ts', '--project', project.id, '--method', 'POST', '--body', '{}'],
    { cwd: dir, encoding: 'utf8' },
  );
  check('sw.endpoint body validation rejects', wrappedBad.includes('VALIDATION_ERROR'), wrappedBad.slice(0, 200));

  rmSync(dir, { recursive: true, force: true });
  exitCode = failures === 0 ? 0 : 1;
} finally {
  console.log('Archiving throwaway project...');
  await api('POST', `/projects/${project.id}/archive`).catch((e) => console.error('  archive failed:', e.message));
}

console.log(failures === 0 ? 'E2E PASS' : `E2E FAIL (${failures} failures)`);
process.exit(exitCode);
