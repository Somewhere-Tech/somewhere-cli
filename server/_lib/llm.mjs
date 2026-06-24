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

/** response_schema is only honoured on anthropic/openai; deepseek + workers-ai
 *  400 on it, so for those we use the JSON-instructed prompt + text parse. */
const SCHEMA_PROVIDERS = new Set(['anthropic', 'openai']);

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
export async function descriptionMatch(sw, pkg, { provider = DEFAULT_PROVIDER, model = DEFAULT_MODEL, maxTokens = 1500 } = {}) {
  const { system, user } = buildDescriptionMatchPrompt(pkg);
  // max_tokens is generous because deepseek (a reasoning model) burns budget on
  // chain-of-thought before the JSON; 200 returned empty text.
  const req = {
    provider,
    model,
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: maxTokens,
  };
  if (SCHEMA_PROVIDERS.has(provider)) req.response_schema = MATCH_SCHEMA;
  try {
    const r = await sw.ai.chat(req);
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

// ---------------------------------------------------------------------------
// Narrative summary (the human-readable judgment) — the primary enrich output.
// One call returns BOTH the prose assessment AND the description-match boolean.
// ---------------------------------------------------------------------------

export const SUMMARY_PROVIDER = 'openai';
export const SUMMARY_MODEL = 'gpt-5.4-mini';

const SUMMARY_SYSTEM =
  'You are a security-savvy engineer assessing an npm package for a developer about to install it. ' +
  'Given the facts, write a 1-3 sentence plain-English judgment that SYNTHESIZES them — explain WHY the package is fine or concerning, the way a knowledgeable colleague would. Do NOT just restate the signals as a list. ' +
  'Weigh author reputation against weak signals: a low-download package from a prolific, reputable author is usually fine ("no provenance — common for their older packages"); a low-download package from a brand-new single-package account that is minified and reaches for the network is a red flag. ' +
  'Also weigh DEPENDENCY risk — a clean-looking package can pull in a sketchy or known-compromised dependency; if any dependency is notable (obscure, known-bad history, or oddly out of place for the package\'s purpose), name it. ' +
  'If the package was EVER compromised, say so AND whether the current version is clean; never call a previously-hacked package\'s author "strong track record" without that caveat. ' +
  'Respond with exactly one JSON object: {"summary": "<the assessment>", "match": true|false} where match is whether the package\'s behavior matches its stated description.';

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, match: { type: 'boolean' } },
  required: ['summary', 'match'],
  additionalProperties: false,
};

/** Build the {system, user} prompt for the narrative, feeding it every signal
 *  (including author reputation) so it can reason like a colleague. */
export function buildSummaryPrompt(s) {
  const a = s.author;
  const authorLine = a
    ? `${a.name} — maintains ${a.package_count} package(s), ${a.combined_downloads} combined weekly downloads` +
      (a.oldest_package_date ? `, publishing since ${String(a.oldest_package_date).slice(0, 10)}` : '')
    : s.publisher || 'unknown';
  const list = (arr) => (arr && arr.length ? arr.join(', ') : 'none');
  const compromised = Array.isArray(s.compromised_history) ? s.compromised_history : [];
  const past = compromised.length
    ? compromised.map((m) => `${m.id} (${String(m.published || '').slice(0, 7) || 'unknown'})`).join(', ')
    : 'none';
  const depFlags = Array.isArray(s.dependency_flags) ? s.dependency_flags : [];
  const depChecked = Math.min((s.dependencies || []).length, 50);
  const depLine = `${depChecked} checked, ${depFlags.length} flagged` +
    (depFlags.length
      ? `: ${depFlags.map((d) => `${d.name} (${d.verdict})`).join(', ')}`
      : '');
  const user = [
    `Package: ${s.package}@${s.version}`,
    `Description: "${s.description ?? ''}"`,
    `Weekly downloads: ${s.weekly_downloads ?? 'unknown'}`,
    `Author: ${authorLine}`,
    `Provenance attestation: ${s.has_provenance ? 'yes' : 'no'}`,
    `GitHub repo: ${s.github_repo || 'none'}${
      s.has_github_tag === 1 ? ' (release tag present)' : s.has_github_tag === 0 ? ' (no release tag for this version)' : ''
    }`,
    `Install scripts: ${list(s.install_script_types)}`,
    `Source: ${s.is_minified ? 'minified / unreadable' : 'readable'}`,
    `Capabilities accessed: ${list(s.capabilities)}`,
    `Past advisories: ${past}`,
    `Known CVEs: ${s.known_cves ?? 0}`,
    `Dependencies: ${depLine}`,
    `Known malware advisories: ${s.mal && s.mal.length ? s.mal.map((m) => m.id).join(', ') : 'none'}`,
  ].join('\n');
  return { system: SUMMARY_SYSTEM, user };
}

/** Generate the narrative + match for one package. Returns
 *  { summary, description_match } or null on failure (degrade, never block).
 *  Uses gpt-5.4-mini on the flex tier (~half price, fine for batch backfill). */
export async function summarize(sw, signals, { provider = SUMMARY_PROVIDER, model = SUMMARY_MODEL, maxTokens = 600 } = {}) {
  const { system, user } = buildSummaryPrompt(signals);
  const req = { provider, model, system, messages: [{ role: 'user', content: user }], max_tokens: maxTokens };
  if (SCHEMA_PROVIDERS.has(provider)) req.response_schema = SUMMARY_SCHEMA;
  if (provider === 'openai') req.service_tier = 'flex';
  try {
    const r = await sw.ai.chat(req);
    let obj = r?.parsed;
    if (!obj || typeof obj.summary !== 'string') {
      const text = typeof r === 'string' ? r : r?.text ?? '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          obj = JSON.parse(text.slice(start, end + 1));
        } catch {
          obj = null;
        }
      }
    }
    if (!obj || typeof obj.summary !== 'string') return null;
    return {
      summary: obj.summary.trim(),
      description_match: typeof obj.match === 'boolean' ? (obj.match ? 'match' : 'mismatch') : null,
    };
  } catch {
    return null;
  }
}
