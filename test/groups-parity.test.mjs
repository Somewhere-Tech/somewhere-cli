// CLI declaration writer uses the same vendored schema/role generator as deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDeclaredData } from '../dist/lib/declared-data.js';
import { runTypecheck } from '../dist/lib/typecheck.js';
const generator = createRequire(import.meta.url)('../runtime/declared-data.cjs');
const rolesSchema = `import { schema, table, id, text, group, appRole } from 'somewhere/db';
export default schema({
  trips: table({ id: id(), group_id: text(), title: text() }, {
    scope: group({ roles: { read: ['owner', 'admin', 'member', 'editor'], create: ['editor'], update: ['owner', 'editor'], delete: ['owner'] } }),
  }),
  reports: table({ id: id(), title: text() }, {
    scope: appRole({ roles: { read: ['staff', 'auditor'], create: ['staff'], update: ['staff'] } }),
  }),
}, {
  groups: { roles: ['editor', 'viewer'], adminGrantableRoles: ['viewer'] },
  appRoles: { staff: {}, auditor: { grantableBy: ['staff'] } },
});`;
const builtinSchema = `import { schema, table, id, text, group } from 'somewhere/db';
export default schema({ trips: table({ id: id(), group_id: text() }, { scope: group() }) });`;
function fixture(t, schema, source = 'export {};') {
  const root = mkdtempSync(join(tmpdir(), 'sw-cli-groups-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'db'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'db/schema.ts'), schema);
  writeFileSync(join(root, 'src/main.ts'), source);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
  }, include: ['src'] }));
  return root;
}
const check = root => runTypecheck(root, { installTypePackages: false });

test('writer accepts group/appRole scopes and writes exact role-aware runtime declarations', async t => {
  const root = fixture(t, rolesSchema, `export async function useGroups(req: Request, sw: SomewhereRuntimeContext) {
    for (const role of ['owner', 'admin', 'member', 'editor', 'viewer'] as const) {
      const changed = await sw.groups.setRole(req, 'group1', 'user2', role);
      if (changed.error === null) { const role: SomewhereGroupRole = changed.data.role; void role; }
    }
    await sw.groups.create(req, { name: 'Crew' });
    await sw.groups.list(req, { limit: 10 });
    await sw.groups.get(req, 'group1');
    await sw.groups.members(req, 'group1', { cursor: 'next' });
    await sw.groups.appRoles.grant(req, 'user2', 'staff');
    await sw.groups.appRoles.revoke(req, 'user2', 'auditor');
    await sw.groups.appRoles.list(req);
  }`);
  const prepared = prepareDeclaredData(root);
  const text = readFileSync(prepared.declarationPath, 'utf8');
  assert.ok(text.includes(generator.runtimeDeclarationFromFiles({ 'db/schema.ts': rolesSchema })));
  assert.match(text, /type SomewhereGroupRole = "owner" \| "admin" \| "member" \| "editor" \| "viewer";/);
  assert.match(text, /type SomewhereAppRole = "auditor" \| "staff";/);
  const groupTypes = text.slice(text.indexOf('type SomewhereGroupRole'), text.indexOf('interface SomewhereRuntimeContext', text.indexOf('type SomewhereGroupRole')));
  assert.ok(!/\bany\b|role: string/.test(groupTypes.replace(/\/\*[\s\S]*?\*\//g, '')));
  const result = await check(root);
  assert.equal(result.ok, true, result.raw);
  writeFileSync(join(root, 'src/bad.ts'), `export async function wrong(req: Request, sw: SomewhereRuntimeContext) {
    await sw.groups.setRole(req, 'g', 'u', 'unknown');
    await sw.groups.setRole(req, 'g', 'u', 'staff');
    await sw.groups.appRoles.grant(req, 'u', 'editor');
    await sw.groups.appRoles.grant(req, 'u', 'owner');
    await sw.groups.appRoles.grant(req, 'u', 'missing');
  }`);
  const bad = await check(root);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 5, bad.raw);
  assert.ok(bad.errors.every(error => error.file === 'src/bad.ts'), bad.raw);
});

test('builtin-only schema permits exactly builtin group roles and no app roles', async t => {
  const root = fixture(t, builtinSchema, `export async function builtin(req: Request, sw: SomewhereRuntimeContext) {
    for (const role of ['owner', 'admin', 'member'] as const) await sw.groups.setRole(req, 'g', 'u', role);
  }`);
  assert.equal((await check(root)).ok, true);
  writeFileSync(join(root, 'src/bad.ts'), `export async function wrong(req: Request, sw: SomewhereRuntimeContext) {
    await sw.groups.setRole(req, 'g', 'u', 'editor');
    await sw.groups.appRoles.grant(req, 'u', 'staff');
  }`);
  const bad = await check(root);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2, bad.raw);
});

test('role vocabulary changes update written declarations; invalid schema removes stale types', t => {
  const root = fixture(t, rolesSchema);
  const initial = prepareDeclaredData(root);
  const path = initial.declarationPath;
  writeFileSync(join(root, 'db/schema.ts'), builtinSchema);
  prepareDeclaredData(root);
  assert.match(readFileSync(path, 'utf8'), /type SomewhereAppRole = never;/);
  assert.ok(!readFileSync(path, 'utf8').includes('"editor"'));
  for (const invalid of [
    rolesSchema.replace("roles: ['editor', 'viewer']", "roles: ['owner', 'viewer']"),
    rolesSchema.replace("adminGrantableRoles: ['viewer']", "adminGrantableRoles: ['missing']"),
    rolesSchema.replace("grantableBy: ['staff']", "grantableBy: ['missing']"),
    rolesSchema.replace("create: ['editor']", "create: ['missing']"),
    rolesSchema.replace("create: ['staff']", "create: ['missing']"),
  ]) {
    writeFileSync(join(root, 'db/schema.ts'), rolesSchema);
    prepareDeclaredData(root);
    writeFileSync(join(root, 'db/schema.ts'), invalid);
    assert.throws(() => prepareDeclaredData(root));
    assert.equal(existsSync(path), false, 'invalid roles cannot leave stale generated permissions');
  }
});
