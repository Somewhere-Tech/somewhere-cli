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

/** verified → run; unverified/suspicious → stop; blocked → block. */
export function decide(v: Verdict): Action {
  if (v.verdict === 'blocked') return 'block';
  if (v.verdict === 'unverified' || v.verdict === 'suspicious') return 'stop';
  return 'run';
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
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

  const mals = v.mal ?? [];
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

/** Full single-package output: the checklist plus a state-specific footer
 *  (how to override on a stop; the malware warning + safe versions on a block). */
export function renderVerdict(v: Verdict): string[] {
  const out = renderChecklist(v);
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
