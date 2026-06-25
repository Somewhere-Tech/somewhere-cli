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
import { summarize } from './llm.mjs';
import { authorProfile } from './author.mjs';
import { queryAdvisoryHistory } from './history.mjs';
import { checkDependencies, resolveVersion as resolveDependencyVersion } from './dep-tree.mjs';
import { cascadeVerdict } from './engine.mjs';

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
            await enrichRow(sw, row, { fetchImpl, llmProvider, llmModel });
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

/** The enrich pass for one already-computed row: advisory history + CVE count,
 *  dependency-tree check + verdict cascade, author reputation, and the LLM
 *  narrative. Mutates and returns `row`. Shared by the bulk pre-warm and the
 *  lazy on-demand fill (enrichPending). */
export async function enrichRow(sw, row, { fetchImpl = fetch, llmProvider, llmModel } = {}) {
  const history = await queryAdvisoryHistory(row.package, { fetchImpl });
  row.known_cves = history.filter((h) => h.kind === 'CVE').length;
  row.compromised_history = history.filter((h) => h.kind === 'MAL').map(({ id, published }) => ({ id, published }));

  const deps = await checkDependencies(row.dependencies, {
    resolveVersion: resolveDependencyVersion,
    readVerdict,
    sw,
    fetchImpl,
  });
  row.dependency_flags = deps.flagged;
  const cascaded = cascadeVerdict(row.verdict, deps.flagged.map((d) => d.verdict));
  if (cascaded !== row.verdict) {
    row.verdict = cascaded;
    const signal = deps.flagged.some((d) => d.verdict === 'blocked') ? 'dependency_blocked' : 'dependency_flagged';
    row.verdict_signals = [...new Set([...(row.verdict_signals ?? []), signal])];
  }

  const author = row.publisher ? await authorProfile(row.publisher, { fetchImpl }) : null;
  if (author) {
    row.author_package_count = author.package_count;
    row.author_total_downloads = author.combined_downloads;
    row.author_first_publish = author.oldest_package_date;
  }

  const s = await summarize(sw, { ...row, author }, { provider: llmProvider, model: llmModel });
  if (s) {
    row.summary = s.summary;
    if (s.description_match) row.description_match = s.description_match;
  }
  return row;
}

/** Lazy "do the ones we don't have": enrich cache rows that were computed on a
 *  miss but have no narrative yet (summary IS NULL), newest first. Demand-driven
 *  — it fills exactly what users actually checked. Bounded (limit) to fit one
 *  request's budget; a cron calls it repeatedly. */
export async function enrichPending(sw, { limit = 3, llmProvider, llmModel, fetchImpl = fetch } = {}) {
  const capped = Math.min(Math.max(1, limit), 10);
  const r = await sw.db.query(
    'SELECT package, version FROM verdicts WHERE summary IS NULL ORDER BY computed_at DESC LIMIT ?',
    [capped],
  );
  const rows = Array.isArray(r?.data) ? r.data : [];
  let enriched = 0;
  let errors = 0;
  for (const pv of rows) {
    try {
      const row = await readVerdict(sw, pv.package, pv.version);
      if (!row) {
        errors++;
        continue;
      }
      await enrichRow(sw, row, { fetchImpl, llmProvider, llmModel });
      await writeVerdict(sw, row);
      enriched++;
    } catch {
      errors++;
    }
  }
  return { pending: rows.length, enriched, errors };
}
