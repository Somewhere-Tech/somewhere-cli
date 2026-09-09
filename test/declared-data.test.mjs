import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_VIRTUAL_ID, DATA_DECLARATION_FILE, declaredDataPlugin, prepareDeclaredData } from '../dist/lib/declared-data.js';
import { FRONTEND_DATA_PATH, frontendProxy } from '../dist/lib/frontend-dev.js';
import { runTypecheck } from '../dist/lib/typecheck.js';
import { collectFiles } from '../dist/lib/files.js';

const schema = `export default schema({
  notes: table({ id: id(), title: text(), optional: text({ nullable: true }), enabled: boolean({ default: true }), secret: text({ default: 'hidden' }) }, {
    scope: owner(), client: { read: ['id', 'title', 'optional', 'enabled'], create: ['title', 'optional'], update: ['title'], delete: true },
  }),
  inbox: table({ id: id(), message: text() }, { scope: shared(), client: { create: ['message'] } }),
  internal: table({ id: id(), secret: text() }, { scope: serverOnly() }),
});`;
const compilerOptions = { strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
test('deploy carries schema source without generated editor declarations, preserving authored declarations', t => {
  const root = fixture(t);
  prepareDeclaredData(root);
  let collected = collectFiles(root);
  assert.equal(collected.files['db/schema.ts'], schema);
  assert.equal(collected.files['src/' + DATA_DECLARATION_FILE], undefined);
  writeFileSync(join(root, 'src', DATA_DECLARATION_FILE), 'declare const authored: string;');
  collected = collectFiles(root);
  assert.equal(collected.files['src/' + DATA_DECLARATION_FILE], 'declare const authored: string;');
});
function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sw-declared-data-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({ 'tsconfig.json': JSON.stringify({ compilerOptions, include: ['src'] }), 'db/schema.ts': schema, 'src/main.ts': 'export {};', ...files })) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), value);
  }
  return root;
}
const check = root => runTypecheck(root, { installTypePackages: false });

test('vendored parser/generator artifact is pinned and its bytes match provenance', () => {
  const manifest = JSON.parse(readFileSync(new URL('../runtime/DECLARED-DATA-VENDOR.json', import.meta.url), 'utf8'));
  const artifact = readFileSync(new URL('../runtime/declared-data.cjs', import.meta.url));
  assert.equal(manifest.sha256, createHash('sha256').update(artifact).digest('hex'));
  for (const part of ['client-contract-source.ts', 'extract-schema-ts.ts', 'typed-data.cjs', 'schema-types.cjs', 'runtime-types.cjs']) {
    assert.ok(Object.keys(manifest.source_files).some(file => file.endsWith('/' + part)));
  }
  assert.equal(manifest.esbuild, '0.24.0');
});

test('same compiler context types server writes without widening browser operations', async t => {
  const root = fixture(t, { 'src/server.ts': `
export type Contract = { input: { id: string }; output: { changes: number } };
export default (async (req, sw) => {
  const { id } = await req.json();
  await sw.db.server.insert('notes', { custom_owner: id, title: 'hello' });
  await sw.db.server.insert('inbox', { _sw_author_id: null, message: 'system' });
  const results = await sw.db.server.tx([
    { op: 'update', table: 'notes', set: { custom_owner: id }, where: { id } },
    { op: 'remove', table: 'notes', where: { id: 'old' } },
  ]);
  return { changes: results[0].changes };
}) satisfies ServerFunction<Contract>;
` });
  assert.equal((await check(root)).ok, true);
  writeFileSync(join(root, 'src', 'bad.ts'), `
import { data } from 'somewhere:data';
declare const sw: SomewhereRuntimeContext;
sw.db.server.tx([{ op: 'query', sql: 'DELETE FROM notes' }]);
sw.db.server.tx(async () => []);
sw.db.server.from('notes', { asServer: true });
sw.db.server.query('DELETE FROM notes');
sw.db.from('notes', { asServer: false });
sw.db.count('notes', { asServer: false });
data.server;
`);
  const bad = await check(root);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 7, bad.raw);
});

test('named operations and schema helpers typecheck with src-only configuration', async t => {
  const root = fixture(t, { 'src/main.ts': `import { data } from 'somewhere:data';
async function example() {
  const page = await data.notes.list({ limit: 20, where: { enabled: true } });
  const title: string = page.data[0].title;
  const optional: string | null = page.data[0].optional;
  await data.notes.create({ title, optional });
  await data.notes.update(1, { title });
  await data.notes.delete(1);
  await data.inbox.create({ message: title });
}` });
  const before = readFileSync(join(root, 'tsconfig.json'), 'utf8');
  const result = await check(root);
  assert.equal(result.ok, true, result.raw);
  assert.match(readFileSync(join(root, 'src', DATA_DECLARATION_FILE), 'utf8'), /declare module "somewhere:data"/);
  assert.equal(readFileSync(join(root, 'tsconfig.json'), 'utf8'), before);
  assert.ok(!readdirSync(root).some(name => name.startsWith('.__somewhere_typecheck_')));
});

test('wrong values, undeclared fields, hidden rows and disabled operations fail the real typechecker', async t => {
  const root = fixture(t, { 'src/main.ts': `import { data } from 'somewhere:data';
data.notes.create({ title: 123 });
data.notes.create({ title: 'hello', secret: 'forged' });
data.notes.update(1, { enabled: true });
data.notes.list({ where: { secret: 'hidden' } });
data.inbox.list();
data.internal;
data.notes.get(1).then(result => result.data?.secret);
` });
  const result = await check(root);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 7, result.raw);
  assert.ok(result.errors.every(error => error.file === 'src/main.ts'));
  assert.match(result.raw, /number.*string/);
});

test('config inheritance and explicit files preserve original diagnostics and add the declaration', async t => {
  const root = fixture(t, {
    'config/base.json': JSON.stringify({ compilerOptions, files: ['../src/extra.ts'] }),
    'tsconfig.json': '// customer JSONC\n' + JSON.stringify({ extends: './config/base.json', files: ['src/main.ts', 'src/extra.ts'] }),
    'src/extra.ts': `const broken: string = 1;`,
    'src/main.ts': `import { data } from 'somewhere:data'; data.notes.create({ title: 'ok' });`,
  });
  const result = await check(root);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1, result.raw);
  assert.equal(result.errors[0].file, 'src/extra.ts');
  writeFileSync(join(root, 'src/extra.ts'), `const fixed: string = 'ok';`);
  const fixed = await check(root);
  assert.equal(fixed.ok, true, fixed.raw);
});

test('imported DSL and changed schema regenerate the actual field types before checking', async t => {
  const root = fixture(t, {
    'db/schema.ts': `import { schema, table, id, text, owner, boolean, shared, serverOnly } from 'somewhere/db';\n${schema}`,
    'src/main.ts': `import { data } from 'somewhere:data'; data.notes.create({ title: 'ok' });`,
  });
  const first = await check(root);
  assert.equal(first.ok, true, first.raw);
  const oldDigest = prepareDeclaredData(root).client.contract_digest;
  writeFileSync(join(root, 'db/schema.ts'), schema.replace('title: text()', 'title: number()'));
  const changed = await check(root);
  assert.equal(changed.ok, false);
  assert.match(changed.raw, /string.*number/);
  assert.notEqual(prepareDeclaredData(root).client.contract_digest, oldDigest);
});

test('no schema remains untouched while unresolved somewhere:data is never filtered away', async t => {
  const root = fixture(t);
  rmSync(join(root, 'db/schema.ts'));
  assert.equal(prepareDeclaredData(root), undefined);
  assert.equal(existsSync(join(root, 'src', DATA_DECLARATION_FILE)), false);
  assert.equal((await check(root)).ok, true);
  writeFileSync(join(root, 'src/main.ts'), `import { data } from 'somewhere:data'; data.notes.list();`);
  const missing = await check(root);
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].code, 'TS2307');
  assert.match(missing.errors[0].message, /somewhere:data/);
});

test('static schema rejection stops checking and removes stale declarations without executing source', async t => {
  const root = fixture(t);
  prepareDeclaredData(root);
  writeFileSync(join(root, 'db/schema.ts'), `globalThis.__somewhere_bad_schema = true;\n${schema}`);
  const bad = await check(root);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, 'SCHEMA_DECLARATION_INVALID');
  assert.equal(globalThis.__somewhere_bad_schema, undefined);
  assert.equal(existsSync(join(root, 'src', DATA_DECLARATION_FILE)), false);
});

test('Vite regenerates and invalidates named data operations on add/change/unlink, failing closed on malformed schema', t => {
  const root = fixture(t);
  const plugin = declaredDataPlugin(root);
  assert.equal(plugin.resolveId('somewhere:data'), DATA_VIRTUAL_ID);
  assert.equal(plugin.resolveId('somewhere:data/unsafe'), undefined);
  const first = plugin.load(DATA_VIRTUAL_ID);
  assert.match(first, /\/__sw\/data/);
  const watcher = new EventEmitter(); watcher.add = () => {};
  const invalidations = [], events = [], module = {};
  plugin.configureServer({ watcher, moduleGraph: { getModuleById: () => module, invalidateModule: value => invalidations.push(value) }, ws: { send: event => events.push(event) } });
  writeFileSync(join(root, 'db/schema.ts'), schema.replace("update: ['title']", 'update: false'));
  watcher.emit('change', join(root, 'db/schema.ts'));
  assert.notEqual(plugin.load(DATA_VIRTUAL_ID), first);
  assert.equal(events.at(-1).type, 'full-reload');
  assert.equal(invalidations.length, 1);
  writeFileSync(join(root, 'db/schema.ts'), 'invalid');
  watcher.emit('change', join(root, 'db/schema.ts'));
  assert.throws(() => plugin.load(DATA_VIRTUAL_ID), /Invalid db\/schema.ts/);
  assert.equal(events.at(-1).type, 'error');
  rmSync(join(root, 'db/schema.ts'));
  watcher.emit('unlink', join(root, 'db/schema.ts'));
  assert.throws(() => plugin.load(DATA_VIRTUAL_ID), /requires db\/schema.ts/);
  writeFileSync(join(root, 'db/schema.ts'), schema);
  watcher.emit('add', join(root, 'db/schema.ts'));
  assert.equal(plugin.load(DATA_VIRTUAL_ID), first);
  plugin.closeBundle();
  assert.equal(watcher.listenerCount('change'), 0);
});

test('only the exact declared data endpoint crosses the same-origin proxy', () => {
  const selector = new RegExp(FRONTEND_DATA_PATH);
  for (const path of ['/__sw/data', '/__sw/data?q=1']) assert.equal(selector.test(path), true);
  for (const path of ['/__sw/data/', '/__sw/database', '/__sw/data/anything', '/__sw/data%2fother', '/__sw/auth', '/v1/db/query']) assert.equal(selector.test(path), false);
  const proxy = frontendProxy('https://fixture.somewhere.site', 'http://localhost:8787');
  const res = { writeHead(status) { this.status = status; }, end() { this.ended = true; } };
  const foreign = { url: '/__sw/data', headers: { host: 'localhost:8787', origin: 'https://foreign.invalid' } };
  proxy.bypass(foreign, res);
  assert.equal(res.status, 403);
  const local = { url: '/__sw/data', headers: { host: 'localhost:8787', origin: 'http://localhost:8787', cookie: 'app=synthetic', 'x-forwarded-origin': 'forged' } };
  assert.equal(proxy.bypass(local, res), undefined);
  assert.equal(local.headers.origin, 'https://fixture.somewhere.site');
  assert.equal(local.headers.cookie, 'app=synthetic');
  assert.equal(local.headers.authorization, undefined);
  assert.equal(local.headers['x-forwarded-origin'], undefined);
});
