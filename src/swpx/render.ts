/** Pure renderers for the swpx / swpm / check output.
 *
 *  Every string here is byte-matched to the terminal examples on
 *  npm.somewhere.tech, which the spec (tsk_f30faf55) names as the source of
 *  truth for CLI output. These functions take a Verdict and return lines — they
 *  never touch the console — so they are unit-tested directly against the
 *  landing-page examples (test/swpx-render.test.mjs). The command layer
 *  (run-swpx / run-swpm / check) prints them.
 *
 *  Color is applied via the shared output helpers; tests strip ANSI before
 *  asserting, so the assertions read the plain text. */

import { dim, green, red, yellow } from '../lib/output.js';
import type { Action, JsonVerdict, Verdict, VerdictLevel } from './types.js';

/** blocked → block; verified → run; EVERYTHING ELSE → stop.
 *  Fail safe: only an explicit `verified` runs. unverified/suspicious and any
 *  unrecognized or future level (a malformed row, `"Blocked "`, a new backend
 *  level like `"quarantined"`) get a soft stop, never a silent run. */
export function decide(v: Verdict): Action {
  if (v.verdict === 'blocked') return 'block';
  if (v.verdict === 'verified') return 'run';
  return 'stop';
}

type CheckLevel = 'ok' | 'warn' | 'bad';
interface Check {
  level: CheckLevel;
  text: string;
}

function checkMark(level: CheckLevel): string {
  if (level === 'ok') return green('✓');
  if (level === 'bad') return red('✖');
  return yellow('⚠');
}

/** 1400622 → "1.4M", 11000 → "11k", 11 → "11". */
function humanizeDownloads(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** 0.3 → "18m", 5 → "5h", 50 → "2d", 1500 → "2mo". (Uses the existing
 *  ageHours() helper defined below for the hours value.) */
function humanizeAge(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)}d`;
  const mo = d / 30;
  return mo < 24 ? `${Math.round(mo)}mo` : `${Math.round(d / 365)}y`;
}

/** "20 verified · 2 flagged · 6 not yet checked" from the enrich breakdown
 *  counts, or null when the counts aren't present (a pre-enrich row). */
function depBreakdown(v: Verdict): string | null {
  const verified = v.dep_verified;
  const unknown = v.dep_unknown;
  if (typeof verified !== 'number' && typeof unknown !== 'number') return null;
  const flagged = (v.dependency_flags ?? []).length;
  const bits: string[] = [];
  if (typeof verified === 'number') bits.push(`${verified} verified`);
  if (flagged) bits.push(`${flagged} flagged`);
  if (typeof unknown === 'number' && unknown > 0) bits.push(`${unknown} not yet checked`);
  return bits.join(' · ') || null;
}

/** The per-dimension evidence rows — "show the work, evidence not a grade".
 *  Every check the verdict layer ran becomes a row: ok (green ✓), warn
 *  (yellow ⚠), or bad (red ✖). A clean package reads as a wall of green with the
 *  one honest ⚠; a sketchy one's red/yellow stands out immediately. Rows are
 *  omitted only when the signal genuinely wasn't checked (e.g. GitHub tag with
 *  no repo, description match before the LLM backfill ran). */
export function buildChecks(v: Verdict): Check[] {
  const checks: Check[] = [];

  const dl = v.weekly_downloads;
  if (typeof dl === 'number' && dl > 0) {
    checks.push({ level: dl >= 1000 ? 'ok' : 'warn', text: `${humanizeDownloads(dl)} weekly downloads` });
  }

  if (v.publisher) {
    const pc = v.author_package_count;
    const adl = v.author_total_downloads;
    const bits: string[] = [];
    if (typeof pc === 'number' && pc > 0) bits.push(`${pc} package${pc === 1 ? '' : 's'}`);
    if (typeof adl === 'number' && adl > 0) bits.push(`${humanizeDownloads(adl)} combined`);
    const detail = bits.length ? ` (${bits.join(', ')})` : '';
    // A single-package (or brand-new) author is a caution; an established one reassures.
    checks.push({ level: typeof pc === 'number' && pc <= 1 ? 'warn' : 'ok', text: `Author: ${v.publisher}${detail}` });
  }

  if (v.license) {
    checks.push({ level: 'ok', text: `${v.license} licensed` });
  }

  if (v.maintainer_changed === true) {
    checks.push({
      level: 'warn',
      text: `Publisher changed since previous release${v.previous_publisher ? ` (was ${v.previous_publisher})` : ''}`,
    });
  } else if (v.maintainer_changed === false) {
    checks.push({ level: 'ok', text: 'Same publisher as previous release' });
  }

  const ageH = ageHours(v.publish_time);
  if (ageH != null) {
    checks.push(
      ageH < 24
        ? { level: 'warn', text: `Published ${humanizeAge(ageH)} ago (too new to be vetted)` }
        : { level: 'ok', text: `Published ${humanizeAge(ageH)} ago` },
    );
  }

  if (v.has_install_scripts) {
    const t = (v.install_script_types ?? []).filter(Boolean)[0];
    checks.push({ level: 'bad', text: t ? `Has ${t} script` : 'Has install scripts' });
  } else {
    checks.push({ level: 'ok', text: 'No install scripts' });
  }

  checks.push(
    v.is_minified ? { level: 'bad', text: 'Minified (unreadable)' } : { level: 'ok', text: 'Readable source' },
  );

  const caps = (v.capabilities ?? []).filter(Boolean);
  checks.push(caps.length ? { level: 'warn', text: caps.join(', ') } : { level: 'ok', text: 'No system access' });

  if (Array.isArray(v.dependencies)) {
    const deps = v.dependencies;
    const flags = Array.isArray(v.dependency_flags) ? v.dependency_flags : null;
    const breakdown = depBreakdown(v);
    const checked = Math.min(deps.length, 50);
    if (deps.length === 0) {
      checks.push({ level: 'ok', text: 'No dependencies' });
    } else if (flags && flags.length) {
      // Some dependency is known-bad — name them, with the verified/not-yet-
      // checked context when the enrich breakdown is available.
      const list = flags.map((d) => `${d.name} (${d.verdict})`).join(', ');
      const level: CheckLevel = flags.some((d) => d.verdict === 'blocked') ? 'bad' : 'warn';
      checks.push({
        level,
        text: breakdown ? `${deps.length} dependencies — ${breakdown}: ${list}` : `${flags.length} of ${checked} flagged: ${list}`,
      });
    } else if (breakdown) {
      // Enrich ran: show the real verified / not-yet-checked split.
      checks.push({ level: 'ok', text: `${deps.length} dependencies — ${breakdown}` });
    } else if (flags) {
      // Flags array present but empty, no counts yet: bad ones surfaced, but
      // uncached deps are unknown — "none flagged", not "all verified".
      checks.push({ level: 'ok', text: `${checked} dependenc${checked === 1 ? 'y' : 'ies'}, none flagged` });
    } else if (deps.length <= 5) {
      checks.push({ level: 'ok', text: `${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'}: ${deps.join(', ')}` });
    } else {
      checks.push({ level: 'ok', text: `${deps.length} dependencies` });
    }
  }

  const mals = v.mal ?? [];
  const compromised = v.compromised_history ?? [];
  if (compromised.length) {
    const date = compromised[0]?.published ? compromised[0].published.slice(0, 7) : 'unknown date';
    checks.push({
      level: 'warn',
      text: `Compromised ${date}${mals.length ? '' : ' (current version clean)'}`,
    });
  }

  if (typeof v.known_cves === 'number') {
    checks.push(
      v.known_cves > 0
        ? { level: 'warn', text: `${v.known_cves} known CVE${v.known_cves === 1 ? '' : 's'}` }
        : { level: 'ok', text: 'No known CVEs' },
    );
  }

  if (mals.length) {
    const m = mals[0];
    checks.push({ level: 'bad', text: m.summary ? `${m.id}: ${m.summary}` : `${m.id} advisory` });
  } else {
    checks.push({ level: 'ok', text: 'No advisories' });
  }

  if (v.typosquat_of) {
    const d = v.typosquat_distance != null ? ` (distance ${v.typosquat_distance})` : '';
    checks.push({ level: 'bad', text: `Possible typosquat of ${v.typosquat_of}${d}` });
  }

  if (v.has_github_tag === 1) checks.push({ level: 'ok', text: 'GitHub tag exists' });
  else if (v.has_github_tag === 0) checks.push({ level: 'warn', text: 'No GitHub tag' });

  if (v.repo_archived === true) checks.push({ level: 'warn', text: 'Source repo is archived' });
  const lastCommitH = ageHours(v.repo_last_commit);
  if (lastCommitH != null) {
    const stale = lastCommitH > 365 * 24;
    const issues = typeof v.repo_open_issues === 'number' ? `, ${v.repo_open_issues} open issue${v.repo_open_issues === 1 ? '' : 's'}` : '';
    checks.push({ level: stale ? 'warn' : 'ok', text: `Repo last updated ${humanizeAge(lastCommitH)} ago${issues}` });
  }

  checks.push(
    v.has_provenance
      ? { level: 'ok', text: 'Provenance verified' }
      : { level: 'warn', text: 'No provenance' },
  );

  if (v.description_match === 'match') {
    checks.push({ level: 'ok', text: 'Matches description' });
  } else if (v.description_match === 'mismatch') {
    checks.push({ level: 'bad', text: v.description ? `Doesn't match: "${v.description}"` : "Doesn't match its description" });
  }

  return checks;
}

/** The verbose, color-coded checklist for one package — header marked by the
 *  overall verdict (✓/⚠/✖), then every check as its own row. */
export function renderChecklist(v: Verdict): string[] {
  const out = [`${mark(v.verdict)} ${v.package}@${v.version}`];
  for (const c of buildChecks(v)) out.push(`  ${checkMark(c.level)} ${c.text}`);
  return out;
}

/** Word-wrap a paragraph to `width` columns (the narrative reads as prose). */
function wrap(text: string, width = 76): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Full single-package output: the LLM narrative as the headline (when present),
 *  the checklist as the receipts, the GitHub link, and a state-specific footer
 *  (how to override on a stop; the malware warning + safe versions on a block). */
export function renderVerdict(v: Verdict): string[] {
  const out = [`${mark(v.verdict)} ${v.package}@${v.version}`];

  // The narrative is the judgment — show it first, in prose, so a glance decides.
  if (v.summary) {
    out.push('');
    for (const l of wrap(v.summary)) out.push(`  ${l}`);
    out.push('');
  }

  for (const c of buildChecks(v)) out.push(`  ${checkMark(c.level)} ${c.text}`);

  if (v.github_repo) out.push(`  ${dim(`→ ${v.github_repo}`)}`);

  const action = decide(v);
  if (action === 'block') {
    const first = (v.mal ?? [])[0];
    const safe = first?.safe_versions ?? [];
    if (safe.length) {
      out.push(`  ${dim('Safe versions:')} ${safe.map((s) => green(`${v.package}@${s}`)).join(', ')}`);
    }
    out.push(`  ${red('Confirmed malware. Do not install.')}`);
  } else if (action === 'stop') {
    out.push(`  ${dim(`Run npx ${v.package} to proceed unverified.`)}`);
  }
  return out;
}

/** Back-compat name used by the check command + bin. */
export function renderSingle(v: Verdict): string[] {
  return renderVerdict(v);
}

/** Compact reason string for a row in the tree summary.
 *  e.g. "minified, no provenance" / "no provenance, has postinstall" / a MAL id. */
export function shortReasons(v: Verdict): string {
  if (v.verdict === 'blocked') return (v.mal ?? [])[0]?.id ?? 'confirmed malware';
  const r: string[] = [];
  if (v.is_minified) r.push('minified');
  if (v.has_provenance === false) r.push('no provenance');
  if (v.has_install_scripts) {
    const t = (v.install_script_types ?? []).filter(Boolean)[0];
    r.push(t ? `has ${t}` : 'has install scripts');
  }
  if (v.typosquat_of) r.push(`typosquat of ${v.typosquat_of}`);
  if (v.description_match === 'mismatch') r.push('description mismatch');
  if (v.has_github_tag === 0) r.push('no github tag');
  return r.join(', ') || 'unverified';
}

const isVerified = (v: Verdict): boolean => v.verdict === 'verified';
const isBlocked = (v: Verdict): boolean => v.verdict === 'blocked';

/** The full `swpm install` tree summary. `directCount` is how many of `items`
 *  are direct (top-level) dependencies; the rest count as transitive. */
export function renderTree(items: Verdict[], directCount: number): string[] {
  const total = items.length;
  const transitive = Math.max(0, total - directCount);
  const verified = items.filter(isVerified);
  const blocked = items.filter(isBlocked);
  const unverified = items.filter((v) => !isVerified(v) && !isBlocked(v));

  const out: string[] = [];
  out.push(
    `Checking ${total} package${total === 1 ? '' : 's'} (${directCount} direct, ${transitive} transitive)`,
  );
  out.push(`  ${green('✓')} ${String(verified.length).padStart(2)} verified`);

  const branchList = (rows: Verdict[]): void => {
    rows.forEach((v, i) => {
      const branch = i === rows.length - 1 ? '└' : '├';
      out.push(`     ${branch} ${v.package}@${v.version} — ${shortReasons(v)}`);
    });
  };

  if (unverified.length) {
    out.push(`  ${yellow('⚠')} ${String(unverified.length).padStart(2)} unverified`);
    branchList(unverified);
  }
  if (blocked.length) {
    out.push(`  ${red('✖')} ${String(blocked.length).padStart(2)} blocked`);
    branchList(blocked);
    out.push('  Remove or replace blocked packages to continue.');
    out.push('  Run npm install to bypass all checks.');
  }
  return out;
}

function ageHours(publishTime?: string | null): number | null {
  if (!publishTime) return null;
  const t = new Date(publishTime).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 3_600_000));
}

/** The stable `--json` projection shown on the landing page. */
export function toJsonVerdict(v: Verdict): JsonVerdict {
  return {
    package: v.package,
    version: v.version,
    verdict: v.verdict,
    signals: {
      provenance: v.has_provenance === true,
      readable: v.is_minified !== true,
      install_scripts: v.install_script_types ?? [],
      capabilities: v.capabilities ?? [],
      description_match: v.description_match === 'match',
      mal_advisories: (v.mal ?? []).map((m) => m.id),
      typosquat_distance: v.typosquat_distance ?? null,
      age_hours: ageHours(v.publish_time),
    },
  };
}

/** Map a verdict level to the single mark used in compact contexts. */
export function mark(level: VerdictLevel): string {
  if (level === 'verified') return green('✓');
  if (level === 'blocked') return red('✖');
  return yellow('⚠');
}
