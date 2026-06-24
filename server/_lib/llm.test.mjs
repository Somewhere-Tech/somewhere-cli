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
  const sw = { ai: { complete: async () => { throw new Error('no ai'); } } };
  assert.equal(await descriptionMatch(sw, { name: 'x', description: 'y', capabilities: [] }), null);
});

test('descriptionMatch — parses a string completion', async () => {
  const sw = { ai: { complete: async () => '{"match": true, "reason": "ok"}' } };
  const r = await descriptionMatch(sw, { name: 'x', description: 'y', capabilities: [] });
  assert.equal(r.description_match, 'match');
});
