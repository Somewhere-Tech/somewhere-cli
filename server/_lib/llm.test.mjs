import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDescriptionMatchPrompt,
  parseMatchResponse,
  descriptionMatch,
  buildSummaryPrompt,
  summarize,
  SUMMARY_MODEL,
} from './llm.mjs';

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

test('descriptionMatch — deepseek omits response_schema (unsupported) + generous tokens; openai keeps it', async () => {
  let seen;
  const sw = { ai: { chat: async (args) => { seen = args; return { text: '{"match":true,"reason":"ok"}' }; } } };
  await descriptionMatch(sw, { name: 'x', description: 'y', capabilities: ['fs'] }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
  assert.equal(seen.provider, 'deepseek');
  assert.equal(seen.model, 'deepseek-v4-flash');
  assert.equal(seen.response_schema, undefined, 'deepseek must NOT get response_schema (it 400s)');
  assert.ok(seen.max_tokens >= 1000, 'generous token budget for a reasoning model');
  assert.equal(seen.messages[0].role, 'user');

  let seen2;
  const sw2 = { ai: { chat: async (args) => { seen2 = args; return { parsed: { match: true, reason: 'ok' } }; } } };
  await descriptionMatch(sw2, { name: 'x', description: 'y', capabilities: ['fs'] }, { provider: 'openai', model: 'gpt-5.4-nano' });
  assert.ok(seen2.response_schema, 'openai gets response_schema');
});

test('buildSummaryPrompt — includes author reputation + every signal', () => {
  const { system, user } = buildSummaryPrompt({
    package: 'tiny-thing',
    version: '0.1.0',
    description: 'string utility',
    weekly_downloads: 47,
    author: { name: 'sindresorhus', package_count: 150, combined_downloads: 2_000_000, oldest_package_date: '2013-01-01' },
    has_provenance: false,
    github_repo: 'https://github.com/sindresorhus/tiny-thing',
    has_github_tag: 1,
    install_script_types: [],
    is_minified: false,
    capabilities: [],
    dependencies: ['escape-string-regexp', 'bad-dep'],
    known_cves: 3,
    compromised_history: [{ id: 'MAL-2025-99', published: '2025-09-15' }],
    dependency_flags: [{ name: 'bad-dep', version: '2.0.0', verdict: 'blocked' }],
    mal: [],
  });
  assert.match(system, /SYNTHESIZE/);
  assert.match(system, /EVER compromised/);
  assert.match(user, /Package: tiny-thing@0\.1\.0/);
  assert.match(user, /sindresorhus — maintains 150 package\(s\), 2000000 combined/);
  assert.match(user, /publishing since 2013-01-01/);
  assert.match(user, /Weekly downloads: 47/);
  assert.match(user, /Provenance attestation: no/);
  assert.match(user, /Past advisories: MAL-2025-99 \(2025-09\)/);
  assert.match(user, /Known CVEs: 3/);
  assert.match(user, /Dependencies: 2 checked, 1 flagged: bad-dep \(blocked\)/);
});

test('summarize — returns narrative + match from parsed structured output', async () => {
  let seen;
  const sw = { ai: { chat: async (args) => { seen = args; return { parsed: { summary: 'Looks fine — reputable author.', match: true } }; } } };
  const r = await summarize(sw, { package: 'p', version: '1', capabilities: [], mal: [] });
  assert.equal(r.summary, 'Looks fine — reputable author.');
  assert.equal(r.description_match, 'match');
  assert.equal(seen.provider, 'openai');
  assert.equal(SUMMARY_MODEL, 'gpt-5.6-luna');
  assert.equal(seen.model, 'gpt-5.6-luna');
  assert.equal(seen.service_tier, 'flex', 'openai uses the flex tier');
  assert.ok(seen.response_schema, 'openai gets response_schema');
});

test('summarize — falls back to parsing text JSON', async () => {
  const sw = { ai: { chat: async () => ({ text: 'Here: {"summary":"Sketchy — new account, minified.","match":false}' }) } };
  const r = await summarize(sw, { package: 'p', version: '1', capabilities: [], mal: [] });
  assert.equal(r.summary, 'Sketchy — new account, minified.');
  assert.equal(r.description_match, 'mismatch');
});

test('summarize — degrades to null on failure (never blocks)', async () => {
  const sw = { ai: { chat: async () => { throw new Error('rate limited'); } } };
  assert.equal(await summarize(sw, { package: 'p', version: '1', capabilities: [], mal: [] }), null);
});
