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
