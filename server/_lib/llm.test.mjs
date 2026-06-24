import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDescriptionMatchPrompt, parseMatchResponse, descriptionMatch } from './llm.mjs';

test('buildDescriptionMatchPrompt — fills the spec template', () => {
  const { system, user } = buildDescriptionMatchPrompt({
    name: 'sketchy',
    description: 'lightweight date formatter',
    capabilities: ['network', 'child_process'],
    installScriptTypes: ['postinstall'],
  });
  assert.match(system, /exactly one JSON object/);
  assert.match(user, /Package: sketchy/);
  assert.match(user, /Description: "lightweight date formatter"/);
  assert.match(user, /Capabilities: network, child_process/);
  assert.match(user, /Has install scripts: yes, postinstall/);
});

test('buildDescriptionMatchPrompt — empty caps + no scripts', () => {
  const { user } = buildDescriptionMatchPrompt({ name: 'x', description: 'y', capabilities: [], installScriptTypes: [] });
  assert.match(user, /Capabilities: \(none\)/);
  assert.match(user, /Has install scripts: no/);
});

test('parseMatchResponse — clean JSON', () => {
  assert.deepEqual(parseMatchResponse('{"match": true, "reason": "fits"}'), {
    description_match: 'match',
    description_match_reason: 'fits',
  });
  assert.deepEqual(parseMatchResponse('{"match": false, "reason": "exfiltrates env"}'), {
    description_match: 'mismatch',
    description_match_reason: 'exfiltrates env',
  });
});

test('parseMatchResponse — tolerates code fences / prose around the JSON', () => {
  const r = parseMatchResponse('Sure!\n```json\n{"match": false, "reason": "no"}\n```');
  assert.equal(r.description_match, 'mismatch');
});

test('parseMatchResponse — garbage / missing match → null', () => {
  assert.equal(parseMatchResponse('not json'), null);
  assert.equal(parseMatchResponse('{"reason":"x"}'), null);
  assert.equal(parseMatchResponse(undefined), null);
});

test('descriptionMatch — model failure degrades to null (never throws)', async () => {
  const sw = { ai: { chat: async () => { throw new Error('PAID_API_NOT_ACTIVATED'); } } };
  assert.equal(await descriptionMatch(sw, { name: 'x', description: 'y', capabilities: [] }), null);
});

test('descriptionMatch — reads validated response_schema output (.parsed)', async () => {
  const sw = { ai: { chat: async () => ({ parsed: { match: true, reason: 'fits' } }) } };
  const r = await descriptionMatch(sw, { name: 'x', description: 'y', capabilities: [] });
  assert.equal(r.description_match, 'match');
  assert.equal(r.description_match_reason, 'fits');
});

test('descriptionMatch — falls back to parsing .text when response_schema not honoured', async () => {
  const sw = { ai: { chat: async () => ({ text: '{"match": false, "reason": "exfiltrates"}' }) } };
  const r = await descriptionMatch(sw, { name: 'x', description: 'y', capabilities: [] });
  assert.equal(r.description_match, 'mismatch');
});

test('descriptionMatch — passes provider + model + response_schema to sw.ai.chat', async () => {
  let seen;
  const sw = { ai: { chat: async (args) => { seen = args; return { parsed: { match: true, reason: 'ok' } }; } } };
  await descriptionMatch(sw, { name: 'x', description: 'y', capabilities: ['fs'] }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
  assert.equal(seen.provider, 'deepseek');
  assert.equal(seen.model, 'deepseek-v4-flash');
  assert.ok(seen.response_schema, 'must force structured output');
  assert.equal(seen.messages[0].role, 'user');
});
