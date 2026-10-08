import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const vendored = createRequire(import.meta.url)('../runtime/declared-data.cjs');

test('vendored strict server inserts accept optional shared authorship and require owners', t => {
  const files = { 'db/schema.ts': `import { schema, table, id, text, owner, shared } from 'somewhere/db';
export default schema({
  notes: table({ key: id({ uuid: true }), body: text() }, { scope: owner() }),
  posts: table({ key: id({ uuid: true }), body: text() }, { scope: shared() }),
});` };
  const dir = mkdtempSync(join(tmpdir(), 'sw-shared-server-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'ambient.d.ts'), vendored.runtimeDeclarationFromFiles(files) + '\n' + vendored.declaredTablesFromFiles(files));
  writeFileSync(join(dir, 'usage.ts'), `declare const sw: SomewhereRuntimeContext;
async function valid() {
  await sw.db.server.insert('posts', { body: 'system' });
  await sw.db.server.insert('posts', { body: 'system', _sw_author_id: null });
  await sw.db.server.insert('posts', { body: 'alice', _sw_author_id: 'alice' });
  await sw.db.server.insert('notes', { body: 'owned', user_id: 'alice' });
  await sw.db.insert('posts', { body: 'caller' });
  await sw.db.server.tx([{ op: 'insert', table: 'posts', values: { body: 'system' } }]);
  // @ts-expect-error owner tables require an explicit server identity
  await sw.db.server.insert('notes', { body: 'missing owner' });
  // @ts-expect-error owner identity cannot be null
  await sw.db.server.insert('notes', { body: 'missing owner', user_id: null });
  // @ts-expect-error callers cannot spoof shared authorship
  await sw.db.insert('posts', { body: 'spoof', _sw_author_id: 'bob' });
  // @ts-expect-error callers cannot supply null shared authorship
  await sw.db.insert('posts', { body: 'spoof', _sw_author_id: null });
  // @ts-expect-error explicit shared authorship must be a string or null
  await sw.db.server.insert('posts', { body: 'bad', _sw_author_id: 42 });
}`);
  const program = ts.createProgram([join(dir, 'ambient.d.ts'), join(dir, 'usage.ts')], {
    noEmit: true, strict: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [],
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
