/** Pre-warm crawler logic (spec item 3) — compute + cache mechanical verdicts
 *  for a slice of the top-N package list, so the common case is a D1 cache hit.
 *  Resumable: process [offset, offset+limit) and report nextOffset, so a cron
 *  (or repeated manual triggers) chews through the full list over many runs.
 *
 *  Free by default: mechanical only (no LLM). Pass enrich=true to also run the
 *  paid description-match backfill — that spends budget, so it's opt-in and gated
 *  by the caller (the founder, in the morning). sw + fetch injected for tests. */

import { fetchPackument } from './registry.mjs';
import { computeMechanical } from './compute.mjs';
import { readVerdict, writeVerdict } from './db.mjs';
import { descriptionMatch } from './llm.mjs';

const DAY_MS = 86_400_000;

function latestVersion(packument) {
  return packument?.['dist-tags']?.latest ?? null;
}

/** Normalise a top-packages payload into a plain string[] of names. Accepts
 *  ["name", ...], [{name, downloads}, ...], or { rows: [...] }. */
export function normalizeNames(payload) {
  const arr = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : [];
  const names = [];
  for (const item of arr) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof item.name === 'string') names.push(item.name);
  }
  return names;
}

export async function prewarmSlice(sw, opts = {}) {
  const {
    names = [],
    offset = 0,
    limit = 50,
    githubToken,
    popular = [],
    fetchImpl = fetch,
    enrich = false,
    llmProvider,
    llmModel,
    concurrency = 5,
    freshDays = 7,
    now = Date.now(),
  } = opts;

  const slice = names.slice(offset, offset + limit);
  const freshMs = freshDays * DAY_MS;
  let processed = 0;
  let written = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < slice.length; i += concurrency) {
    const chunk = slice.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (name) => {
        processed++;
        try {
          const pack = await fetchPackument(name, { fetchImpl });
          const version = latestVersion(pack);
          if (!version) {
            errors++;
            return;
          }
          const existing = await readVerdict(sw, name, version).catch(() => null);
          if (existing?.computed_at && now - new Date(existing.computed_at).getTime() < freshMs) {
            skipped++;
            return;
          }
          const row = await computeMechanical(name, version, {
            githubToken,
            popular,
            fetchImpl,
            now: new Date(now).toISOString(),
          });
          if (enrich) {
            const m = await descriptionMatch(
              sw,
              {
                name,
                description: row.description,
                capabilities: row.capabilities,
                installScriptTypes: row.install_script_types,
              },
              { provider: llmProvider, model: llmModel },
            );
            if (m) {
              row.description_match = m.description_match;
              row.description_match_reason = m.description_match_reason;
            }
          }
          await writeVerdict(sw, row);
          written++;
        } catch {
          errors++;
        }
      }),
    );
  }

  return {
    processed,
    written,
    skipped,
    errors,
    offset,
    limit,
    nextOffset: offset + limit,
    remaining: Math.max(0, names.length - (offset + limit)),
  };
}
