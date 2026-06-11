/**
 * Rendering for the worker's structured BUILD_ERROR payload (tsk_de47d1d7).
 *
 * The /deploy and /deploy/patch routes answer compile failures with
 *   { error: 'BUILD_ERROR', message, data: { file, line, column, error,
 *     frame, errors: [...], build_log }, hint? }
 *
 * The CLI has the source files on disk, so the code frame is rebuilt locally
 * (wider context + caret) instead of trusting the server's copy — and falls
 * back to data.frame / the raw message when the local file doesn't match.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CliApiError } from './client.js';
import { bold, dim, error, info, red, teal, warn } from './output.js';

export interface BuildErrorDetail {
  file?: string;
  line?: number;
  column?: number;
  message?: string;
  lineText?: string;
}

interface BuildErrorData {
  file?: string;
  line?: number;
  column?: number;
  error?: string;
  frame?: string;
  errors?: BuildErrorDetail[];
  build_log?: string[];
  missing_assets?: string[];
  /** DEPLOY_BLANK_PAGE root cause — esbuild-style "file:line:col: ERROR: msg" text. */
  bundle_error?: string;
}

/** Pull file:line:col diagnostics out of esbuild-style bundle_error text. */
export function parseBundleErrorText(text: string): BuildErrorDetail[] {
  const out: BuildErrorDetail[] = [];
  const re = /([^\s:]+(?:\/[^\s:]+)*):(\d+):(\d+): ERROR: ([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ file: m[1], line: Number(m[2]), column: Number(m[3]) + 1, message: m[4].trim() });
  }
  return out;
}

const FRAME_CONTEXT = 2;

/** Build a code frame (line ±2, caret under the column) from local source. */
export function localCodeFrame(
  source: string,
  line: number,
  column?: number,
): string {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return '';
  const start = Math.max(1, line - FRAME_CONTEXT);
  const end = Math.min(lines.length, line + FRAME_CONTEXT);
  const width = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const marker = n === line ? red('>') : ' ';
    const num = String(n).padStart(width);
    out.push(`${marker} ${dim(`${num} |`)} ${lines[n - 1]}`);
    if (n === line && column !== undefined && column >= 1) {
      out.push(`  ${dim(`${' '.repeat(width)} |`)} ${' '.repeat(column - 1)}${red('^')}`);
    }
  }
  return out.join('\n');
}

function frameFor(detail: BuildErrorDetail, baseDir: string, serverFrame?: string): string {
  if (detail.file && detail.line !== undefined) {
    const abs = isAbsolute(detail.file) ? detail.file : join(baseDir, detail.file);
    if (existsSync(abs)) {
      try {
        const frame = localCodeFrame(readFileSync(abs, 'utf-8'), detail.line, detail.column);
        if (frame) return frame;
      } catch {
        // unreadable — fall through to the server's frame
      }
    }
  }
  return serverFrame ?? '';
}

function location(detail: BuildErrorDetail): string {
  if (!detail.file) return detail.message ?? 'unknown error';
  const pos =
    detail.line !== undefined
      ? `:${detail.line}${detail.column !== undefined ? `:${detail.column}` : ''}`
      : '';
  return `${detail.file}${pos}${detail.message ? ` — ${detail.message}` : ''}`;
}

/** True when the error carries a structured build payload this module renders:
 *  BUILD_ERROR's data.{file,line,errors}, or any error (DEPLOY_BLANK_PAGE)
 *  whose data.bundle_error names the compile failure. */
export function isBuildError(err: unknown): err is CliApiError {
  if (!(err instanceof CliApiError) || !err.data || typeof err.data !== 'object') return false;
  if (err.code === 'BUILD_ERROR') return true;
  return typeof (err.data as BuildErrorData).bundle_error === 'string';
}

/**
 * Print a structured build failure: file:line heading, local code frame,
 * remaining errors, missing assets, hint. Returns true if it rendered
 * (caller falls back to generic output otherwise).
 */
export function renderBuildError(err: CliApiError, baseDir: string): boolean {
  const data = (err.data ?? {}) as BuildErrorData;
  let details: BuildErrorDetail[] =
    Array.isArray(data.errors) && data.errors.length > 0
      ? data.errors
      : data.file !== undefined || data.error !== undefined
        ? [{ file: data.file, line: data.line, column: data.column, message: data.error }]
        : [];
  if (details.length === 0 && typeof data.bundle_error === 'string') {
    details = parseBundleErrorText(data.bundle_error);
  }

  if (details.length === 0 && !data.missing_assets?.length) return false;

  const first = details[0];
  if (first) {
    error(`${bold('Build failed')} — ${teal(location(first))}`);
    const frame = frameFor(first, baseDir, data.frame);
    if (frame) {
      console.log('');
      console.log(frame);
      console.log('');
    }
  }

  for (const extra of details.slice(1, 6)) {
    error(location(extra));
    const frame = frameFor(extra, baseDir);
    if (frame) {
      console.log('');
      console.log(frame);
      console.log('');
    }
  }
  if (details.length > 6) {
    info(dim(`…and ${details.length - 6} more build error(s)`));
  }

  if (data.missing_assets?.length) {
    warn(`Missing assets referenced by the build: ${data.missing_assets.slice(0, 10).join(', ')}${data.missing_assets.length > 10 ? ', …' : ''}`);
  }

  if (err.hint) info(dim(err.hint));
  if (err.code === 'BUILD_ERROR') {
    info(dim(`Nothing from this deploy is live. Fix the error and redeploy. [BUILD_ERROR, HTTP ${err.statusCode}]`));
  } else {
    // Non-BUILD_ERROR codes (DEPLOY_BLANK_PAGE) carry context the frame
    // doesn't repeat — rollback state, false-alarm guidance. Keep it.
    info(dim(`${err.message} [${err.code}, HTTP ${err.statusCode}]`));
  }
  return true;
}

/** Yellow single-line summary for watch-mode (somewhere dev) reuse. */
export function buildErrorSummary(err: CliApiError): string {
  const data = (err.data ?? {}) as BuildErrorData;
  let first: BuildErrorDetail | undefined =
    Array.isArray(data.errors) && data.errors.length > 0
      ? data.errors[0]
      : data.file !== undefined || data.error !== undefined
        ? { file: data.file, line: data.line, column: data.column, message: data.error }
        : undefined;
  if (!first && typeof data.bundle_error === 'string') {
    first = parseBundleErrorText(data.bundle_error)[0];
  }
  return first ? location(first) : err.message;
}
