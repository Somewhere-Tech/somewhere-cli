// somewhere:files local types (pfb_3a25c9e8d7db). The declaration comes from the
// vendored platform compiler (typed-files.cjs describeFilesClient over the
// worker's declaredFilesFromSource), so a local typecheck sees exactly the
// collections and operations the deploy compile generates. Both directions:
// declared operations typecheck; undeclared operations and wrong input fail;
// a project without file collections stays valid and never gains the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATA_DECLARATION_FILE, FILES_DECLARATION_FILE, GENERATED_DATA_HEADER, prepareDeclaredData,
} from '../dist/lib/declared-data.js';
import { runTypecheck } from '../dist/lib/typecheck.js';
import { collectFiles } from '../dist/lib/files.js';

const generator = createRequire(import.meta.url)('../runtime/declared-data.cjs');

const tables = `teams: table({ id: id(), name: text() }, { scope: owner(), client: { read: ['id', 'name'], create: ['name'] } }),
  team_members: table({ id: id(), team_id: text(), user_id: text() }, { scope: serverOnly() }),`;
const schema = `import { schema, table, id, text, owner, member, anyOf, serverOnly, files } from 'somewhere/db';
export default schema({
  ${tables}
}, {
  files: {
    uploads: files({ path: '/uploads', scope: owner(), client: { read: true, upload: true },
                     limits: { maxSize: '25MB', types: ['image/*', 'application/pdf'] } }),
    attachments: files({
      path: '/attachments',
      scope: anyOf(owner(), member({
        group: 'team_id', membership: 'team_members', member_user: 'user_id', member_group: 'team_id',
        operations: ['read', 'upload'],
      })),
      client: { read: true, upload: true, replace: true, delete: true },
    }),
    avatars: files({ path: '/avatars', scope: owner(), public: true,
                     client: { upload: true, replace: true, delete: true }, limits: { maxSize: '2MB', types: ['image/*'] } }),
    assets: files({ path: '/assets', scope: serverOnly(), public: true }),
  },
});`;
const tablesOnly = `import { schema, table, id, text, owner, serverOnly } from 'somewhere/db';
export default schema({
  ${tables}
});`;
const compilerOptions = { strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'] };

function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sw-declared-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({ 'tsconfig.json': JSON.stringify({ compilerOptions, include: ['src'] }), 'db/schema.ts': schema, 'src/main.ts': 'export {};', ...files })) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), value);
  }
  return root;
}
const check = root => runTypecheck(root, { installTypePackages: false });
const codes = result => result.errors.map(e => `${e.file}:${e.line} ${e.code}`);

test('the generated declaration is the compiler declaration for the same schema, never deployed', t => {
  const root = fixture(t);
  const prepared = prepareDeclaredData(root);
  const path = join(root, 'src', FILES_DECLARATION_FILE);
  assert.equal(FILES_DECLARATION_FILE, '__somewhere_files.d.ts');
  assert.equal(prepared.filesDeclarationPath, path);
  assert.equal(readFileSync(path, 'utf8'), GENERATED_DATA_HEADER + generator.filesDeclarationFromFiles({ 'db/schema.ts': schema }));
  assert.match(readFileSync(path, 'utf8'), /declare module "somewhere:files"/);
  assert.equal(collectFiles(root).files['src/' + FILES_DECLARATION_FILE], undefined, 'the compiler regenerates it on deploy');
  writeFileSync(path, 'declare const authored: string;');
  assert.equal(collectFiles(root).files['src/' + FILES_DECLARATION_FILE], 'declare const authored: string;', 'an authored file at that path still deploys');
  assert.throws(() => prepareDeclaredData(root), /reserved for a generated declaration/);
});

test('declared collection operations typecheck locally', async t => {
  const root = fixture(t, { 'src/main.ts': `import { files } from 'somewhere:files';
export async function run(blob: Blob) {
  const listed = await files.uploads.list({ limit: 10 });
  if (listed.error) return listed.error.message;
  const first: string | undefined = listed.data.items[0]?.id;
  const up = await files.uploads.upload(blob, { name: 'a.pdf', onProgress: p => p.loaded / p.total });
  const link = await files.uploads.shareLink('f1', { expiresIn: 60 });
  const team = await files.attachments.upload(blob, { team_id: 't1' });
  await files.attachments.list({ team_id: 't1' });
  await files.attachments.replace('f1', blob);
  await files.attachments.delete('f1');
  await files.avatars.upload(blob);
  const avatar: string = files.avatars.publicUrl('f1', 'me.png');
  const asset: string = files.assets.publicUrl('/assets/logo.svg');
  return [first, up.data?.url, link.data?.expires_at, team.data?.id, avatar, asset, files.uploads.url('f1')];
}
` });
  const result = await check(root);
  assert.deepEqual(codes(result), [], result.raw);
  assert.equal(result.ok, true);
});

test('undeclared operations and invalid input are type errors', async t => {
  const root = fixture(t, { 'src/main.ts': `import { files } from 'somewhere:files';
export async function run(blob: Blob) {
  await files.uploads.delete('f1');
  await files.avatars.list();
  await files.assets.upload(blob);
  await files.attachments.upload(blob);
  await files.uploads.get(42);
  await files.missing.list();
}
` });
  const result = await check(root);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [
    'src/main.ts:3 TS2339', // uploads declares no delete
    'src/main.ts:4 TS2339', // avatars are not readable through the client
    'src/main.ts:5 TS2339', // serverOnly assets have no browser upload
    'src/main.ts:6 TS2554', // a member collection needs its group on upload
    'src/main.ts:7 TS2345', // ids are strings
    'src/main.ts:8 TS2339', // undeclared collection
  ], result.raw);
});

test('projects without file declarations stay valid and never gain somewhere:files', async t => {
  const root = fixture(t, { 'db/schema.ts': tablesOnly });
  assert.equal(prepareDeclaredData(root).filesDeclarationPath, undefined);
  assert.equal(existsSync(join(root, 'src', FILES_DECLARATION_FILE)), false);
  assert.equal(existsSync(join(root, 'src', DATA_DECLARATION_FILE)), true);
  assert.equal((await check(root)).ok, true);

  writeFileSync(join(root, 'src/main.ts'), `import { files } from 'somewhere:files'; files;`);
  const missing = await check(root);
  assert.equal(missing.ok, false, 'an unresolved somewhere:files import is never filtered away');
  assert.equal(missing.errors[0].code, 'TS2307');
  assert.match(missing.errors[0].message, /somewhere:files/);
});

test('removing the files block or the schema removes the stale generated declaration', async t => {
  const root = fixture(t);
  prepareDeclaredData(root);
  const path = join(root, 'src', FILES_DECLARATION_FILE);
  assert.equal(existsSync(path), true);
  writeFileSync(join(root, 'db/schema.ts'), tablesOnly);
  prepareDeclaredData(root);
  assert.equal(existsSync(path), false);
  writeFileSync(join(root, 'db/schema.ts'), schema);
  prepareDeclaredData(root);
  assert.equal(existsSync(path), true);
  rmSync(join(root, 'db/schema.ts'));
  assert.equal(prepareDeclaredData(root), undefined);
  assert.equal(existsSync(path), false);
});

test('an invalid file collection is a schema error, not a silent pass', async t => {
  const root = fixture(t, { 'db/schema.ts': schema.replace("path: '/uploads'", "path: 'uploads'") });
  const result = await check(root);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'SCHEMA_DECLARATION_INVALID');
  assert.equal(existsSync(join(root, 'src', FILES_DECLARATION_FILE)), false);
});

test('the data declaration keeps one sw global and the vendored endpoint types', t => {
  const root = fixture(t, { 'db/schema.ts': tablesOnly });
  prepareDeclaredData(root);
  const data = readFileSync(join(root, 'src', DATA_DECLARATION_FILE), 'utf8');
  assert.equal(data.match(/declare const sw: \{/g)?.length, 1);
  assert.equal(data.match(/interface SomewhereEndpointUser \{/g)?.length, 1);
  assert.ok(data.includes(generator.ENDPOINT_DECLARATION), 'endpoint input types are the compiler bytes');
});
