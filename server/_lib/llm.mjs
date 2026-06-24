/** LLM enrichment (spec item 4/8) — async backfill, NOT on the synchronous
 *  verdict path. Two checks: description-match (does behaviour match the stated
 *  purpose?) and diff-review (is the version-to-version change suspicious?).
 *  Both are cached forever once computed.
 *
 *  The PROMPT builders and RESPONSE parsers are pure and unit-tested. The single
 *  platform-specific call (sw.ai) is isolated in callModel() and wrapped so any
 *  failure degrades to null (the engine treats a null LLM signal as "unknown",
 *  never as a stop). The exact sw.ai invocation shape MUST be confirmed against
 *  docs({topic:'sw.ai'}) before the paid backfill runs — see callModel(). */

export const DESCRIPTION_MATCH_MODEL = 'claude-haiku-4-5-20251001';

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

/** Isolated platform call. IMPORTANT: the sw.ai method/argument shape below is a
 *  best guess and MUST be verified against docs({topic:'sw.ai'}) before running
 *  the paid backfill. Any error → null (caller treats as "unknown"). */
async function callModel(sw, { system, user, model }) {
  try {
    // TODO(morning): confirm this is the real sw.ai signature.
    const res = await sw.ai.complete({
      model,
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 200,
    });
    // Accept a few plausible result shapes.
    if (typeof res === 'string') return res;
    return res?.text ?? res?.content ?? res?.completion ?? res?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** Run the description-match check for one package. Returns the two fields to
 *  patch onto a cached row, or null if the model was unavailable/unparseable. */
export async function descriptionMatch(sw, pkg, { model = DESCRIPTION_MATCH_MODEL } = {}) {
  const { system, user } = buildDescriptionMatchPrompt(pkg);
  const text = await callModel(sw, { system, user, model });
  return text ? parseMatchResponse(text) : null;
}
