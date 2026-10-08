// A project without db/schema.ts still gets the runtime context the platform
// compiler always declares, so a bare typed handler checks locally as it does
// on deploy (pfb_861a411cb4a6). Nothing about the database is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_DECLARATION_FILE, GENERATED_DATA_HEADER, prepareDeclaredData } from '../dist/lib/declared-data.js';
import { runTypecheck } from '../dist/lib/typecheck.js';
import { collectFiles } from '../dist/lib/files.js';

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', skipLibCheck: true }, include: ['src', 'api', 'db'] });
const BARE = `export default async function (req: Request, sw: SomewhereRuntimeContext) {
  const user = await sw.auth.fromRequest(req);
  return Response.json({ id: user?.id ?? null });
}
`;
const WRAPPED = `export default sw.endpoint({
  auth: 'required',
  body: { title: 'string' },
  handler: async ({ body, user }) => ({ title: body.title.trim(), by: user.id }),
});
`;
const SCHEMA = `import { id, owner, schema, table, text } from 'somewhere/db';
export default schema({
  notes: table({ id: id(), title: text() }, { scope: owner(), client: { read: ['id', 'title'], create: ['title'] } }),
});
`;

function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'sw-typecheck-no-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const check = (root) => runTypecheck(root, { installTypePackages: false });
const codes = (result) => result.errors.map((e) => `${e.file}:${e.code}`).sort();
const declarationOf = (root) => readFileSync(join(root, 'src', DATA_DECLARATION_FILE), 'utf8');

test('without db/schema.ts a bare typed handler and sw.endpoint typecheck', async (t) => {
  const root = project(t, { 'src/main.ts': 'export {};\n', 'api/hello.ts': BARE, 'api/wrapped.ts': WRAPPED });
  const result = await check(root);
  assert.equal(result.ok, true, result.raw);
  const declaration = declarationOf(root);
  assert.ok(declaration.startsWith(GENERATED_DATA_HEADER));
  assert.match(declaration, /interface SomewhereRuntimeContext/);
  assert.match(declaration, /declare const sw: \{/);
});

test('the runtime types still catch real mistakes without a schema', async (t) => {
  const root = project(t, {
    'src/main.ts': 'export {};\n',
    'api/typo.ts': BARE.replace('fromRequest', 'fromReqest'),
    'api/body.ts': WRAPPED.replace('body.title.trim()', 'body.title.toFixed(2)'),
    'api/auth.ts': `export default sw.endpoint({ auth: 'optional', handler: async ({ user }) => user.id });\n`,
  });
  const result = await check(root);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['api/auth.ts:TS18047', 'api/body.ts:TS2551', 'api/typo.ts:TS2551']);
});

test('nothing about the database is invented without a schema', async (t) => {
  const root = project(t, { 'src/main.ts': 'export {};\n', 'api/hello.ts': BARE });
  prepareDeclaredData(root);
  const declaration = declarationOf(root);
  assert.doesNotMatch(declaration, /declare module "somewhere:data"/);
  assert.doesNotMatch(declaration, /declare module "somewhere:files"/);
  assert.doesNotMatch(declaration, /declare module ['"]somewhere\/db['"]/);
  assert.match(declaration, /runtime types only/);
  // somewhere:data stays unresolved and is reported, never filtered away.
  writeFileSync(join(root, 'src/main.ts'), `import { data } from 'somewhere:data'; data;\n`);
  const result = await check(root);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'TS2307');
  assert.match(result.errors[0].message, /somewhere:data/);
});

test('adding and removing db/schema.ts switches the generated file both ways', async (t) => {
  const root = project(t, { 'src/main.ts': 'export {};\n', 'api/hello.ts': BARE });
  prepareDeclaredData(root);
  assert.doesNotMatch(declarationOf(root), /declare module "somewhere:data"/);
  mkdirSync(join(root, 'db'), { recursive: true });
  writeFileSync(join(root, 'db/schema.ts'), SCHEMA);
  const withSchema = prepareDeclaredData(root);
  assert.ok(withSchema.client);
  assert.match(declarationOf(root), /declare module "somewhere:data"/);
  assert.doesNotMatch(declarationOf(root), /runtime types only/);
  assert.equal((await check(root)).ok, true);
  rmSync(join(root, 'db/schema.ts'));
  const without = prepareDeclaredData(root);
  assert.equal(without.client, undefined);
  assert.match(declarationOf(root), /runtime types only/, 'rewritten, not left stale and not deleted');
  assert.doesNotMatch(declarationOf(root), /declare module "somewhere:data"/);
  assert.equal((await check(root)).ok, true);
});

test('a file of the user\'s own at the reserved path is left untouched without a schema', async (t) => {
  const own = '// my own declarations\nexport {};\n';
  const root = project(t, { 'src/main.ts': 'export {};\n', [`src/${DATA_DECLARATION_FILE}`]: own });
  assert.equal(prepareDeclaredData(root), undefined);
  assert.equal(declarationOf(root), own);
});

test('the runtime-only file is never deployed', (t) => {
  const root = project(t, { 'index.html': '<!doctype html><title>x</title>', 'src/main.ts': 'export {};\n', 'api/hello.ts': BARE });
  prepareDeclaredData(root);
  assert.ok(existsSync(join(root, 'src', DATA_DECLARATION_FILE)));
  const collected = collectFiles(root);
  assert.equal(collected.files[`src/${DATA_DECLARATION_FILE}`], undefined);
  assert.ok(collected.functions['api/hello.ts']);
});

test('current-user subscription helpers accept their options and reject authority selectors', async (t) => {
  const root = project(t, {
    'src/main.ts': 'export {};\n',
    'api/subscription.ts': `export default async function (req: Request, sw: SomewhereRuntimeContext) {
  await sw.payments.subscriptionForUser();
  await sw.payments.subscriptionForUser(null);
  const subscription = await sw.payments.subscriptionForUser({ env: 'dev' });
  const access: boolean = subscription.access;
  const period: string | null = subscription.current_period_end;
  await sw.payments.cancelForUser();
  await sw.payments.cancelForUser(null);
  const cancellation = await sw.payments.cancelForUser({ env: 'prod', immediately: true });
  const sync: 'applied' | 'pending' | 'not_applied' | 'not_confirmed' | 'not_needed' = cancellation.access_sync;
  return Response.json({ access, period, sync });
}\n`,
  });
  const good = await check(root);
  assert.equal(good.ok, true, good.raw);
  const invalidCalls = [
    "sw.payments.subscriptionForUser({ user_id: 'other' })",
    "sw.payments.subscriptionForUser({ customer_id: 'cus_other' })",
    "sw.payments.subscriptionForUser({ subscription_id: 'sub_other' })",
    "sw.payments.subscriptionForUser({ immediately: true })",
    "sw.payments.subscriptionForUser({ env: 'test' })",
    "sw.payments.cancelForUser({ user_id: 'other' })",
    "sw.payments.cancelForUser({ customer_id: 'cus_other' })",
    "sw.payments.cancelForUser({ subscription_id: 'sub_other' })",
    "sw.payments.cancelForUser({ env: 'test' })",
    "sw.payments.cancelForUser({ immediately: 'yes' })",
  ];
  writeFileSync(join(root, 'api/subscription.ts'),
    'export default async function (req: Request, sw: SomewhereRuntimeContext) {\n' +
    invalidCalls.map(call => `  await ${call};`).join('\n') + '\n}\n');
  const bad = await check(root);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map(error => error.line).sort((a, b) => a - b), invalidCalls.map((_, i) => i + 2));
  assert.ok(bad.errors.every(error => error.file.endsWith('api/subscription.ts')));
  assert.ok(bad.errors.every(error => ['TS2353', 'TS2322'].includes(error.code)), bad.raw);
});
