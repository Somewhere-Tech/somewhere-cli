import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = Boolean(process.env.SOMEWHERE_TEST_SOURCE);
const moduleRoot = source ? '../src' : '../dist';
const ext = source ? 'ts' : 'js';
const { resolveInitSelection } = await import(`${moduleRoot}/lib/init-features.${ext}`);
const { createFeatureTemplate, extensionPoints } = await import(`${moduleRoot}/lib/init-feature-template.${ext}`);
const { normalizeBrowserActions } = await import(`${moduleRoot}/lib/browser-actions.${ext}`);
const { preflightBrowserActions } = await import(`${moduleRoot}/lib/browser-flow-preflight.${ext}`);
const declaredData = createRequire(import.meta.url)('../runtime/declared-data.cjs');
const ts = (await import('typescript')).default;

function files(features, ui = 'styled') {
  return Object.fromEntries(createFeatureTemplate(resolveInitSelection(features, ui), { appName: 'Errands' }).map((f) => [f.path, f.content]));
}

async function importTs(dir, name, text) {
  const path = join(dir, name);
  writeFileSync(path, ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  return import(`${path}?t=${Date.now()}`);
}

test('agent resolves auth, and private-data keeps its notes table beside the agent tables', () => {
  assert.deepEqual(resolveInitSelection('agent').modules, ['auth', 'agent']);
  assert.equal(extensionPoints(resolveInitSelection('agent')).assistant, 'api/chat.ts, api/proposals.ts, src/data/useAssistant.ts, src/fixtures/assistant.ts');
  for (const features of ['agent', 'private-data,agent']) {
    const schema = files(features)['db/schema.ts'];
    const tables = declaredData.declaredTablesFromFiles({ 'db/schema.ts': schema });
    for (const table of ['tasks', 'proposals']) {
      // The owner column is platform-managed: present on rows, absent from browser/caller inserts.
      assert.match(tables, new RegExp(`"${table}": \\{\\n    row: \\{[^}]*"user_id": string \\};\\n    insert: \\{(?![^}]*user_id)`), `${features}: ${table} is owner()`);
    }
    assert.equal(/"notes":/.test(tables), features.includes('private-data'));
    assert.match(schema, /tool_call_id: text\(\{ unique: true \}\)/);
    // No client block for the agent tables: the browser reaches them only through api/*.
    const client = declaredData.generateFromFiles({ 'db/schema.ts': schema });
    assert.ok(!client || !/"(tasks|proposals)":/.test(client.declaration), features);
  }
});

test('fixture previews mount before the sign-in provider and import no network or auth module', () => {
  for (const ui of ['styled', 'headless']) {
    const all = files('agent', ui);
    const main = all['src/main.tsx'];
    assert.match(main, /const preview = window\.location\.pathname === FIXTURES_PATH;/);
    assert.ok(main.indexOf('<AssistantFixturesPage />') < main.indexOf('<SomewhereAuthProvider'), 'fixture branch is outside the provider');
    // Walk the fixture page's local imports: nothing reaches the SDK, auth, the hook or a fetch call site that runs.
    const seen = new Set();
    const walk = (path) => {
      if (seen.has(path)) return;
      seen.add(path);
      const text = all[path];
      assert.ok(text, `${ui}: ${path} exists`);
      for (const [, spec] of text.matchAll(/^import (?!type)[^;]*from '([^']+)';/gm)) {
        assert.doesNotMatch(spec, /@somewhere-tech|services\/auth|useAssistant|\/auth\//, `${path} imports ${spec}`);
        if (spec.startsWith('.')) {
          const base = join(path, '..', spec).replace(/^\//, '');
          walk([`${base}.ts`, `${base}.tsx`].find((candidate) => all[candidate]) ?? `${base}.ts`);
        }
      }
    };
    walk('src/pages/AssistantFixturesPage.tsx');
    assert.deepEqual([...seen].sort(), ['src/fixtures/assistant.ts', 'src/pages/AssistantFixturesPage.tsx', 'src/services/assistant.ts', 'src/ui/AssistantPanel.tsx', 'src/ui/feedback.tsx']);
  }
});

test('the shipped flow passes the CLI action parser and visits every declared fixture', async () => {
  const all = files('agent');
  const dir = mkdtempSync(join(tmpdir(), 'somewhere-agent-fixtures-'));
  // Load the real fixtures module with its one value import stubbed.
  globalThis.__assistantLimit = 2000;
  const fixtures = await importTs(dir, 'fixtures.mjs', all['src/fixtures/assistant.ts'].replace(
    "import { MESSAGE_LIMIT } from '../services/assistant';", 'const MESSAGE_LIMIT = globalThis.__assistantLimit;'));
  const names = Object.keys(fixtures.ASSISTANT_FIXTURES);
  assert.deepEqual(names, ['loading', 'empty', 'error', 'populated', 'long']);
  assert.equal(fixtures.assistantFixture('nope'), null);
  assert.equal(fixtures.assistantFixture('toString'), null, 'only own keys are fixtures');
  const controller = fixtures.fixtureController(fixtures.ASSISTANT_FIXTURES.populated);
  assert.equal(controller.readOnly, true);
  assert.equal(controller.canSend, false);

  const flow = JSON.parse(all['flows/assistant-fixtures.json']);
  assert.deepEqual(flow.viewports, ['desktop', 'mobile']);
  const parsed = normalizeBrowserActions(flow.actions, dir);
  assert.equal(parsed.ok, true, parsed.error);
  const { actions } = parsed;
  preflightBrowserActions(actions);
  const gotos = actions.filter((a) => 'goto' in a).map((a) => a.goto);
  assert.deepEqual(gotos, names.map((n) => `/fixtures?state=${n}`));
  assert.equal(actions.filter((a) => 'screenshot' in a).length, names.length);
  assert.ok(actions.length <= 30);
  delete globalThis.__assistantLimit;
});

test('assistant service maps spend-cap, session and network failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somewhere-agent-service-'));
  const service = await importTs(dir, 'service.mjs', files('agent')['src/services/assistant.ts']);
  const realFetch = globalThis.fetch;
  const calls = [];
  const answers = [];
  globalThis.fetch = async (path, init) => { calls.push([path, init]); return answers.shift(); };
  try {
    answers.push(Response.json({ error: 'AI_SPEND_CAP_EXCEEDED', message: 'This reply hit its spending limit and stopped.', activity: [{ tool: 'list_tasks', tool_call_id: 't1', ok: true, detail: '1 task(s)' }] }, { status: 402 }));
    const capped = await service.sendMessage('hi').catch((error) => error);
    assert.ok(capped instanceof service.AssistantRequestError);
    assert.equal(capped.status, 402);
    assert.deepEqual(capped.activity.map((a) => a.tool_call_id), ['t1']);
    assert.equal(service.assistantErrorMessage(capped), 'This reply hit its spending limit and stopped.');
    assert.deepEqual(calls[0], ['/api/chat', { method: 'POST', body: '{"message":"hi"}', credentials: 'include', headers: { 'Content-Type': 'application/json' } }]);

    answers.push(Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 }));
    const ended = await service.loadTranscript().catch((error) => error);
    assert.equal(service.isSessionEnded(ended), true);
    assert.equal(service.assistantErrorMessage(ended), 'Your session ended. Sign in again.');
    assert.equal(service.assistantErrorMessage(new TypeError('fetch failed')), 'Could not reach the server. Check your connection and try again.');

    assert.equal(service.replyText({ reply: 'Done.', completion_reason: 'model_done', activity: [], spent_cents: 1 }), 'Done.');
    assert.equal(service.replyText({ reply: '', completion_reason: 'max_steps', activity: [], spent_cents: null }), '(stopped: max_steps)');
  } finally {
    globalThis.fetch = realFetch;
  }
});
