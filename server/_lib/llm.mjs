/** LLM enrichment (spec item 4/8) — async backfill, NOT on the synchronous
 *  verdict path. Two checks: description-match (does behaviour match the stated
 *  purpose?) and diff-review (is the version-to-version change suspicious?).
 *  Both are cached forever once computed.
 *
 *  The PROMPT builders and RESPONSE parsers are pure and unit-tested. The
 *  platform call uses the verified sw.ai.chat shape (provider + model +
 *  response_schema for validated JSON) and is wrapped so any failure degrades to
 *  null (the engine treats a null LLM signal as "unknown", never as a stop). */

// Defaults for the paid description-match backfill. Chosen for "under $1 across
// 20K" (deepseek-v4-flash ≈ $0.15 in / $0.29 out per 1M tokens — the cheapest
// frontier-class model in the platform catalog). Override per-call or via the
// prewarm endpoint's PREWARM_PROVIDER / PREWARM_MODEL env. (gpt-4o-mini, named in
// the original runbook, is NOT in the catalog — would 400.) A no-spend,
// no-activation alternative is provider:'workers-ai', model:'@cf/meta/llama-4-scout-17b-16e-instruct'.
export const DEFAULT_PROVIDER = 'deepseek';
export const DEFAULT_MODEL = 'deepseek-v4-flash';

/** Forces a validated JSON object out of the model (sw.ai response_schema). */
const MATCH_SCHEMA = {
  type: 'object',
  properties: { match: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['match', 'reason'],
  additionalProperties: false,
};

const DESCRIPTION_MATCH_SYSTEM =
  "Compare an npm package's description against its detected capabilities.\n" +
  'Respond with exactly one JSON object: {"match": true/false, "reason": "one sentence"}';

/** Build the {system, user} prompt for the description-match check (verbatim
 *  from the spec). */
export function buildDescriptionMatchPrompt({ name, description, capabilities, installScriptTypes }) {
  const caps = (capabilities ?? []).join(', ') || '(none)';
  const scripts = installScriptTypes && installScriptTypes.length
    ? `yes, ${installScriptTypes.join(', ')}`
    : 'no';
  const user =
    `Package: ${name}\n` +
    `Description: "${description ?? ''}"\n` +
    `Capabilities: ${caps}\n` +
    `Has install scripts: ${scripts}\n` +
    "Does this package's behavior match its description?";
  return { system: DESCRIPTION_MATCH_SYSTEM, user };
}

/** Parse the model's reply into { match: 'match'|'mismatch'|'unclear', reason }.
 *  Tolerates code fences / surrounding prose by extracting the first JSON object.
 *  Returns null if nothing parseable. */
export function parseMatchResponse(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj.match !== 'boolean') return null;
  return {
    description_match: obj.match ? 'match' : 'mismatch',
    description_match_reason: typeof obj.reason === 'string' ? obj.reason : null,
  };
}

/** Run the description-match check for one package via sw.ai.chat with a forced
 *  response_schema (verified shape per docs{topic:'sw.ai'}). Returns the two
 *  fields to patch onto a cached row, or null if the model was
 *  unavailable/unparseable (a missing LLM signal is "unknown", never a stop). */
export async function descriptionMatch(sw, pkg, { provider = DEFAULT_PROVIDER, model = DEFAULT_MODEL } = {}) {
  const { system, user } = buildDescriptionMatchPrompt(pkg);
  try {
    const r = await sw.ai.chat({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: user }],
      response_schema: MATCH_SCHEMA,
      max_tokens: 200,
    });
    // Preferred path: validated structured output.
    if (r?.parsed && typeof r.parsed.match === 'boolean') {
      return {
        description_match: r.parsed.match ? 'match' : 'mismatch',
        description_match_reason: typeof r.parsed.reason === 'string' ? r.parsed.reason : null,
      };
    }
    // Fallback: a model/provider that didn't honour response_schema still
    // returns text we can parse.
    const text = typeof r === 'string' ? r : r?.text ?? null;
    return text ? parseMatchResponse(text) : null;
  } catch {
    return null; // PAID_API_NOT_ACTIVATED, rate limit, outage — degrade, never block
  }
}
