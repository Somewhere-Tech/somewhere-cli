// Vendored parser/generator parity with the platform candidate: reusable schema
// constants, integer() as number, bigint() as exact text, and transcription
// options, exercised through the real vendored generator and `somewhere typecheck`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTypecheck } from '../dist/lib/typecheck.js';

const vendored = createRequire(import.meta.url)('../runtime/declared-data.cjs');
const compilerOptions = { strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };

// One payments table, written with reusable top-level constants…
const withConstants = `const ownRows = owner();
const money = { amount_cents: integer(), ledger_id: bigint() };
export default schema({
  payments: table({ id: id(), label: text(), ...money }, {
    scope: ownRows,
    client: { read: ['id', 'label', 'amount_cents', 'ledger_id'], create: ['label', 'amount_cents', 'ledger_id'] },
  }),
});`;
// A reused field-list constant ("as const", readonly) — the declaration accepts
// readonly Field[] for client read/create/update.
const withFieldListConstant = withConstants
  .replace('export default schema({', "const readable = ['id', 'label', 'amount_cents', 'ledger_id'] as const;\nexport default schema({")
  .replace("read: ['id', 'label', 'amount_cents', 'ledger_id']", 'read: readable');
// …and the same table spelled inline.
const inline = `export default schema({
  payments: table({ id: id(), label: text(), amount_cents: integer(), ledger_id: bigint() }, {
    scope: owner(),
    client: { read: ['id', 'label', 'amount_cents', 'ledger_id'], create: ['label', 'amount_cents', 'ledger_id'] },
  }),
});`;

function fixture(t, schema, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sw-schema-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({ 'tsconfig.json': JSON.stringify({ compilerOptions, include: ['src'] }), 'db/schema.ts': schema, ...files })) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), value);
  }
  return root;
}
const check = root => runTypecheck(root, { installTypePackages: false });

test('reusable schema constants generate exactly the inline declaration in the vendored generator', () => {
  const fromConstants = vendored.generateFromFiles({ 'db/schema.ts': withConstants });
  const fromInline = vendored.generateFromFiles({ 'db/schema.ts': inline });
  assert.ok(fromConstants, 'the vendored parser reads top-level constants');
  assert.deepEqual(fromConstants, fromInline);
  assert.deepEqual(
    vendored.declaredTablesFromFiles({ 'db/schema.ts': withConstants }),
    vendored.declaredTablesFromFiles({ 'db/schema.ts': inline }),
  );
});

test('integer() is a number for cents math and bigint() is exact text, through somewhere typecheck', async t => {
  const root = fixture(t, withConstants, { 'src/main.ts': `import { data } from 'somewhere:data';
export async function total(): Promise<number> {
  const page = await data.payments.list({ limit: 50 });
  const cents: number = page.data.reduce((sum, row) => sum + row.amount_cents, 0);
  const ledger: string = page.data[0].ledger_id;
  await data.payments.create({ label: ledger, amount_cents: 1999, ledger_id: '9007199254740993' });
  return cents / 100;
}` });
  const ok = await check(root);
  assert.equal(ok.ok, true, ok.raw);

  writeFileSync(join(root, 'src', 'bad.ts'), `import { data } from 'somewhere:data';
export async function wrong() {
  const page = await data.payments.list();
  const asNumber: number = page.data[0].ledger_id;
  const asText: string = page.data[0].amount_cents;
  await data.payments.create({ label: 'x', amount_cents: '1999', ledger_id: 9007199254740993 });
  return [asNumber, asText];
}`);
  const bad = await check(root);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.every(error => error.file === 'src/bad.ts'), bad.raw);
  assert.ok(bad.errors.length >= 3, bad.raw);
});

test('a reused field-list constant is read by the vendored generator', () => {
  assert.deepEqual(vendored.generateFromFiles({ 'db/schema.ts': withFieldListConstant }), vendored.generateFromFiles({ 'db/schema.ts': inline }));
});

test('a reused "as const" field-list constant typechecks in db/schema.ts', async t => {
  const root = fixture(t, withFieldListConstant, { 'src/main.ts': 'export {};' });
  const result = await check(root);
  assert.equal(result.ok, true, result.raw);
});

test('transcription accepts language and prompt with audio or audio_url, and refuses no audio', async t => {
  const root = fixture(t, inline, { 'src/server.ts': `
export type Contract = { input: { url: string }; output: { text: string } };
export default (async (req, sw) => {
  const { url } = await req.json();
  const fromUrl = await sw.ai.transcribe({ audio_url: url, language: 'en', prompt: 'Somewhere, cents' });
  const fromBase64 = await sw.ai.transcribe({ audio: 'UklGRg==', model: 'default' });
  return { text: fromUrl.text + fromBase64.text };
}) satisfies ServerFunction<Contract>;
` });
  const ok = await check(root);
  assert.equal(ok.ok, true, ok.raw);
  writeFileSync(join(root, 'src', 'bad.ts'), `declare const sw: SomewhereRuntimeContext;
sw.ai.transcribe({ language: 'en', prompt: 'no audio' });
`);
  const bad = await check(root);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(error => error.file === 'src/bad.ts'), bad.raw);
});

const rowLinkSchema = `import { schema, table, id, text, integer, owner, parent, hasMany } from 'somewhere/db';
export default schema({
  notes: table({ id: id(), title: text(), body: text(), private_note: text() }, {
    scope: owner(), relations: { comments: hasMany('comments', 'note_id') },
    client: { read: ['id', 'title', 'body', 'private_note'], create: ['title', 'body', 'private_note'], update: ['body'],
      links: { read: ['id', 'title', 'body'], edit: ['body'], children: ['comments'], maxDays: 7 } },
  }),
  comments: table({ id: id(), note_id: integer({ references: 'notes' }), body: text(), secret: text({ default: '' }) }, {
    scope: parent({ via: 'note_id' }), client: { read: ['id', 'body'], create: ['note_id', 'body'], update: ['body'] },
  }),
  read_notes: table({ id: id(), title: text() }, {
    scope: owner(), client: { read: ['id', 'title'], links: { read: true, edit: false } },
  }),
});`;

test('row-link declarations typecheck owner and restricted recipient clients without exposing private fields', async t => {
  const root = fixture(t, rowLinkSchema, { 'src/main.ts': `import { data } from 'somewhere:data';
const made = await data.notes.createLink(1, { access: 'edit', expiresInDays: 2, returnTo: '/' });
const url: string = made.url;
await data.notes.links(1);
await data.notes.revokeLink(1, made.link_id);
const opened = data.links.opened();
const sessions = await data.links.sessions();
await data.links.forget(made.link_id);
const recipient = data.linked(made.link_id);
const note = await recipient.notes.get(1);
const title: string | undefined = note.data?.title;
await recipient.notes.update(1, { body: 'Changed' });
await recipient.notes.relations.comments.list(1);
await recipient.comments.create({ note_id: 1, body: 'Comment' });
await recipient.comments.update(1, { body: 'Edited' });
await data.read_notes.createLink(1, { access: 'read' });
await recipient.read_notes.get(1);
export { url, title, opened, sessions };` });
  const good = await check(root);
  assert.equal(good.ok, true, good.raw);
  writeFileSync(join(root, 'src', 'bad.ts'), `import { data } from 'somewhere:data';
const recipient = data.linked('lnk_test');
(await recipient.notes.get(1)).data?.private_note;
await recipient.notes.update(1, { private_note: 'Private' });
await recipient.comments.update(1, { note_id: 2 });
await data.read_notes.createLink(1, { access: 'edit' });
await recipient.read_notes.update(1, { title: 'No edit permission' });
`);
  const bad = await check(root);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 5, bad.raw);
  assert.ok(bad.errors.every(error => error.file === 'src/bad.ts'), bad.raw);
});

test('row-link declarations refuse an undeclared shared field through the actual vendored parser', () => {
  assert.throws(() => vendored.generateFromFiles({ 'db/schema.ts': rowLinkSchema.replace("read: ['id', 'title', 'body'], edit:", "read: ['id', 'missing'], edit:") }), /client\.links\.read.*missing/);
});
