// Run with SOMEWHERE_TEST_PLATFORM_ROOT pointing to the reviewed platform checkout.
// Executes the emitted starter hook/service with its canonical generated browser client;
// only fetch and React's hook scheduler are controlled. No provider calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';
import { resolveInitSelection } from '../dist/lib/init-features.js';
import { writeInitScaffold } from '../dist/lib/init-scaffold.js';
import { runTypecheck } from '../dist/lib/typecheck.js';

const platform = process.env.SOMEWHERE_TEST_PLATFORM_ROOT;
const starterDependencies = process.env.SOMEWHERE_TEST_STARTER_NODE_MODULES;

function hookHost() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  return {
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }];
    },
    useRef(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect(effect, deps) {
      const at = cursor++;
      if (!slots[at] || deps.some((v, i) => v !== slots[at][i])) { slots[at] = deps; effects.push(effect); }
    },
    render(hook) { cursor = 0; const value = hook(); const queued = effects; effects = []; queued.forEach(f => f()); return value; },
  };
}

const transpile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
async function prepare(ui) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-note-save-journey-'));
  const files = createFeatureTemplate(resolveInitSelection('private-data', ui), { appName: 'Notes' });
  writeInitScaffold(dir, files);
  const req = createRequire(join(platform, 'worker/package.json'));
  const { build } = req('esbuild');
  const parser = await build({ absWorkingDir: platform, stdin: { resolveDir: platform, contents: "export {clientAuthorityFromSource} from './worker/src/utils/db-schema-deploy/client-contract-source.ts';" }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', parser.outputFiles[0].text)(req, mod, mod.exports);
  const authority = mod.exports.clientAuthorityFromSource({ 'db/schema.ts': files.find(f => f.path === 'db/schema.ts').content });
  const generated = req(join(platform, 'worker/containers/compile/typed-data.cjs')).generateDataClient(authority, 'insert-v1');
  assert.match(generated.runtime, /createWithReceipt/);
  writeFileSync(join(dir, 'data.mjs'), generated.runtime);
  writeFileSync(join(dir, 'notes.mjs'), transpile(readFileSync(join(dir, 'src/services/notes.ts'), 'utf8')).replace("'somewhere:data'", "'./data.mjs'"));
  writeFileSync(join(dir, 'react.mjs'), 'export const useState=v=>globalThis.__notesHost.useState(v); export const useRef=v=>globalThis.__notesHost.useRef(v); export const useEffect=(f,d)=>globalThis.__notesHost.useEffect(f,d);');
  writeFileSync(join(dir, 'auth.mjs'), 'export const useAuth=()=>globalThis.__notesAuth;');
  writeFileSync(join(dir, 'hook.mjs'), transpile(readFileSync(join(dir, 'src/data/useNotes.ts'), 'utf8'))
    .replace("'react'", "'./react.mjs'").replace("'@somewhere-tech/sdk/react'", "'./auth.mjs'").replace("'../services/notes'", "'./notes.mjs'"));
  const { useNotes } = await import(pathToFileURL(join(dir, 'hook.mjs')).href);
  assert.match(files.find(f => f.path === 'src/ui/NotesBoard.tsx').content, /Retry original save/);
  if (starterDependencies) {
    symlinkSync(resolve(starterDependencies), join(dir, 'node_modules'), 'dir');
    const checked = await runTypecheck(dir, { installTypePackages: false });
    assert.equal(checked.ok, true, checked.raw);
  }
  return { useNotes, dir };
}

function fixture(useNotes, mode, existing = false) {
  const host = hookHost();
  const rows = new Map(existing ? [[41, { id: 41, title: 'Existing', body: 'Before' }]] : []);
  const receipts = new Map();
  const writes = [];
  const updates = [];
  let calls = 0;
  let reads = 0;
  globalThis.__notesHost = host;
  globalThis.__notesAuth = { getUser() {} };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.operation === 'list') { reads++; return Response.json({ data: [...rows.values()], has_more: false }); }
    if (body.operation === 'update') {
      updates.push(body);
      const note = { ...rows.get(body.id), ...body.values };
      rows.set(body.id, note);
      return Response.json({ data: note, changes: 1, count: 1 });
    }
    assert.equal(body.operation, 'create');
    writes.push(init.body);
    calls++;
    if (mode === 'committed-error') return Response.json({ error: 'DB_COMMITTED_RESULT_FAILED', message: 'Saved but result unavailable', outcome: 'committed', write_committed: true }, { status: 503 });
    if (mode === 'no-handle') return Response.json({ data: { id: 1, ...body.values } }); // malformed success: committed, no receipt/handle
    let result = receipts.get(body.idempotency_key);
    if (!result) {
      const created_at = Date.now();
      const note = { id: rows.size + 1, ...body.values };
      rows.set(note.id, note);
      result = { data: mode === 'null-success' ? null : note, count: 1, changes: 1,
        idempotency: { created_at, result_until: created_at + 86400000, refuse_until: created_at + 691200000, replayed: false } };
      receipts.set(body.idempotency_key, result);
    }
    if (mode === 'lost' && calls === 1) throw new TypeError('simulated response loss after commit');
    if (mode === 'lost-then-refused' && calls === 1) throw new TypeError('simulated response loss after commit');
    if (mode === 'lost-then-refused' && calls === 2) return Response.json({ error: 'DATA_CONTRACT_MISMATCH', message: 'App changed' }, { status: 409 });
    return Response.json({ ...result, idempotency: { ...result.idempotency, replayed: calls > 1 } });
  };
  let controller;
  const render = () => controller = host.render(useNotes);
  return { rows, writes, updates, render, get reads() { return reads; }, async start() { render(); await new Promise(resolve => setImmediate(resolve)); render(); controller.setDraft({ title: 'Original', body: 'Body' }); return render(); } };
}

test('emitted private-data starter preserves keyed saves across uncertainty', { skip: !platform }, async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const ui of ['styled', 'headless']) {
      const { useNotes } = await prepare(ui);
      for (const edited of [false, true]) {
        const f = fixture(useNotes, 'lost');
        let c = await f.start();
        await c.save(); c = f.render();
        assert.equal(f.rows.size, 1); assert.equal(f.writes.length, 1, 'no automatic retry');
        assert.equal(c.retryingCreate, true); assert.equal(c.canSave, true);
        if (edited) { c.setDraft({ title: 'Edited', body: '' }); c = f.render(); }
        await c.save(); c = f.render();
        assert.equal(f.writes[0], f.writes[1], 'explicit retry uses exact original key and serialized values');
        assert.equal(f.rows.size, 1); assert.equal(c.notes.length, 1); assert.equal(c.notes[0].title, 'Original');
        assert.deepEqual(c.draft, edited ? { title: 'Edited', body: '' } : { title: '', body: '' });
        assert.equal(c.retryingCreate, false);
      }
      for (const mode of ['committed-error', 'no-handle', 'null-success']) {
        const f = fixture(useNotes, mode); let c = await f.start();
        await c.save(); c = f.render();
        assert.equal(c.canSave, false, mode + ' blocks a fresh create');
        assert.equal(c.retryingCreate, false); assert.match(c.notice.text, /Check your notes/);
        c.cancelEdit(); c = f.render(); c.setDraft({ title: 'Changed', body: '' }); c = f.render();
        await c.save(); assert.equal(f.writes.length, 1, mode + ' survives cancel and edits');
      }
      // A pending add must never hijack an existing note's Save changes.
      for (const mode of ['lost', 'committed-error', 'no-handle']) {
        const f = fixture(useNotes, mode, true); let c = await f.start();
        await c.save(); c = f.render();
        c.startEdit(c.notes.find(note => note.id === 41)); c = f.render();
        assert.equal(c.retryingCreate, false, mode + ': editing shows Save changes');
        c.setDraft({ title: 'Updated existing', body: 'After' }); c = f.render();
        assert.equal(c.canSave, true, mode + ': existing update stays available');
        await c.save(); c = f.render();
        assert.equal(f.updates.length, 1); assert.equal(f.writes.length, 1, 'update never sends a pending create');
        assert.equal(f.rows.get(41).title, 'Updated existing');
        assert.equal(c.editingId, null, 'successful update returns to adding');
        assert.equal(c.retryingCreate, mode === 'lost');
        assert.equal(c.canSave, mode === 'lost', 'pending add remains guarded after update');
        c.startEdit(c.notes.find(note => note.id === 41)); c = f.render();
        c.cancelEdit(); c = f.render();
        assert.equal(c.retryingCreate, mode === 'lost', 'cancel also preserves pending add');
        await c.save(); c = f.render();
        if (mode === 'lost') {
          assert.equal(f.writes[1], f.writes[0], 'returning to Retry preserves original key/body');
          assert.equal(f.rows.size, 2, 'existing note plus one original create');
          assert.equal(c.notes.length, 2);
        } else assert.equal(f.writes.length, 1, 'committed/no-handle add stays blocked');
      }
      const uncertain = fixture(useNotes, 'lost-then-refused'); let c = await uncertain.start();
      await c.save(); c = uncertain.render(); await c.save(); c = uncertain.render();
      assert.equal(c.retryingCreate, true, 'later refusal retains earlier unknown outcome and handle');
      await c.save(); c = uncertain.render();
      assert.equal(new Set(uncertain.writes).size, 1); assert.equal(uncertain.rows.size, 1); assert.equal(c.notes.length, 1);
      const normal = fixture(useNotes, 'normal'); c = await normal.start();
      await c.save(); c = normal.render();
      assert.equal(c.notes.length, 1); assert.equal(normal.writes.length, 1); assert.equal(c.notice.text, 'Added.');
      assert.equal(normal.reads, 1, 'normal success appends without reloading the list');
      assert.deepEqual(c.draft, { title: '', body: '' });
    }
  } finally { globalThis.fetch = originalFetch; delete globalThis.__notesHost; delete globalThis.__notesAuth; }
});
