import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTypecheck } from '../dist/lib/typecheck.js';

// The generated `sw` type is the platform's own runtime declaration, vendored by
// scripts/vendor-declared-data.mjs (pfb_e53f8065214e). A handler written from the
// docs must typecheck clean against it, and an undeclared binding must still fail:
// the context is a real type, never `any`.
const schema = `export default schema({
  rounds: table({ id: id(), title: text(), votes: integer({ default: 0 }) }, { scope: serverOnly() }),
});`;
const compilerOptions = { strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'] };

function project(t, handler) {
  const root = mkdtempSync(join(tmpdir(), 'sw-runtime-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions, include: ['src', 'api'] }),
    'db/schema.ts': schema,
    'src/main.ts': 'export {};',
    'api/handler.ts': handler,
  };
  for (const [file, value] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), value);
  }
  return runTypecheck(root, { installTypePackages: false });
}

const docsHandler = `export default async function (req: Request, sw: SomewhereRuntimeContext) {
  const made = await sw.db.insert('rounds', { title: 'First round' });
  const round = made.data[0];
  if (!round) throw new Error('Insert returned no row');
  const id = String(round.id);
  await sw.db.update('rounds', { increment: { votes: 1 }, where: { id } });
  const open = await sw.db.server.from('rounds', { where: { votes: { gte: 1 } }, order: ['id', 'desc'], limit: 20 });
  const total: number = (await sw.db.server.count('rounds')).data;
  const raw = await sw.db.server.query('SELECT id, title FROM rounds WHERE id = ?', [id]);
  const own = await sw.db.query('SELECT id FROM rounds WHERE id = ?', [id]);
  const batch = await sw.db.server.batch([{ sql: 'SELECT COUNT(*) AS n FROM rounds' }]);
  const login = await sw.auth.loginWithCookie(req, { email: 'reader@example.test', password: 'password' });
  const signedIn = login.mfa_required ? null : login.user.email;
  await sw.db.remove('rounds', { where: { id } });
  return Response.json({ open: open.data, total, raw: raw.data, own: own.count, n: batch[0].data, signedIn });
}
`;

test('a docs-following handler typechecks clean against the generated sw type', async t => {
  const result = await project(t, docsHandler);
  assert.equal(result.ok, true, result.raw);
});

test('undeclared sw bindings still fail: the generated context is not any', async t => {
  const result = await project(t, `export default async function (req: Request, sw: SomewhereRuntimeContext) {
  sw.nonexistent;
  await sw.db.server.nonexistent('rounds');
  return new Response(null);
}
`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(error => [error.file, error.code]), [['api/handler.ts', 'TS2339'], ['api/handler.ts', 'TS2339']], result.raw);
  assert.match(result.raw, /Property 'nonexistent' does not exist on type 'SomewhereRuntimeContext'/);
  assert.match(result.raw, /Property 'nonexistent' does not exist on type 'SomewhereServerDb'/);
});

// Drift check: the vendored bytes must equal a fresh bundle of the platform's
// runtime-types source. Set SOMEWHERE_PLATFORM_SOURCE to a platform checkout
// (with the compiler's pinned esbuild installed) before cutting a CLI release.
const platformSource = process.env.SOMEWHERE_PLATFORM_SOURCE;
test('vendored runtime declaration matches the platform source', { skip: platformSource ? false : 'SOMEWHERE_PLATFORM_SOURCE is not set' }, () => {
  const script = new URL('../scripts/vendor-declared-data.mjs', import.meta.url).pathname;
  const output = execFileSync(process.execPath, [script, platformSource, '--check'], { encoding: 'utf8' });
  assert.match(output, /parity verified/);
});
