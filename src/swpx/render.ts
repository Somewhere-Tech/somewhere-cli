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

function capString(v: Verdict): string {
  const caps = (v.capabilities ?? []).filter(Boolean);
  return caps.length ? caps.join(', ') : '(no system access)';
}

/** Green one-liner for a clean package.
 *  e.g. `✓ create-next-app@15.2.0 — network, fs, child_process ✓ matches "Create Next.js apps"`
 *  e.g. `✓ is-odd@1.0.0 — (no system access)` */
export function renderVerified(v: Verdict): string {
  let line = `${green('✓')} ${v.package}@${v.version} — ${capString(v)}`;
  if (v.description_match === 'match' && v.description) {
    line += ` ${green('✓')} matches ${dim(`"${v.description}"`)}`;
  }
  return line;
}

/** The bullet lines under a "could not verify" header — one per negative
 *  signal present, in the landing-page order. */
export function evidenceLines(v: Verdict): string[] {
  const lines: string[] = [];
  if (v.has_provenance === false) lines.push('No provenance (source unverifiable)');
  if (v.is_minified) lines.push('Minified source (unreadable)');
  if (v.has_install_scripts) {
    const types = (v.install_script_types ?? []).filter(Boolean).join(', ');
    lines.push(types ? `Has install scripts (${types})` : 'Has install scripts');
  }
  const caps = (v.capabilities ?? []).filter(Boolean);
  if (caps.length) lines.push(caps.join(', '));
  if (v.typosquat_of) {
    const d = v.typosquat_distance != null ? ` (distance ${v.typosquat_distance})` : '';
    lines.push(`Possible typosquat of ${v.typosquat_of}${d}`);
  }
  if (v.description_match === 'mismatch' && v.description) {
    lines.push(`Capabilities don't match description: "${v.description}"`);
  }
  if ((v.diff_review === 'suspicious' || v.diff_review === 'unexplained') && v.diff_review_reason) {
    lines.push(v.diff_review_reason);
  }
  if (v.has_github_tag === 0) lines.push('No GitHub release tag for this version');
  return lines;
}

/** Yellow evidence block for an unverified / suspicious package (swpx stops). */
export function renderEvidence(v: Verdict): string[] {
  const out = [`${yellow('⚠')} ${v.package}@${v.version} — could not verify`];
  for (const l of evidenceLines(v)) out.push(`  ${yellow('⚠')} ${l}`);
  out.push(`  Run npx ${v.package} to proceed unverified.`);
  return out;
}

/** Red hard-block for confirmed malware. */
export function renderBlocked(v: Verdict): string[] {
  const out = [`${red('✖')} ${red('BLOCKED')} — ${v.package}@${v.version}`];
  const mals = v.mal ?? [];
  for (const m of mals) out.push(`  ${m.id}${m.summary ? `: ${m.summary}` : ''}`);
  const first = mals[0];
  if (first) {
    const meta: string[] = [];
    if (first.disclosed) meta.push(`Disclosed: ${first.disclosed}`);
    if (first.source) meta.push(`Source: ${first.source}`);
    if (meta.length) out.push(`  ${meta.join(' · ')}`);
    const safe = first.safe_versions ?? [];
    if (safe.length) {
      out.push(`  Safe versions: ${safe.map((s) => `${v.package}@${s}`).join(', ')}`);
    }
  }
  out.push('  This version is confirmed malware. Do not install.');
  return out;
}

/** Whichever block a single-package check should print, with its leading mark. */
export function renderSingle(v: Verdict): string[] {
  switch (decide(v)) {
    case 'run':
      return [renderVerified(v)];
    case 'block':
      return renderBlocked(v);
    default:
      return renderEvidence(v);
  }
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
