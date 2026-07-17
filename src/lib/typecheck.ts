/**
 * The "is this safe to deploy?" gate: run `tsc --noEmit` over a pulled tree
 * and surface file:line errors — especially TS2304 ("X is not defined"), the
 * dropped-import class that 500s production when nothing typechecks it.
 *
 * tsc resolution order (first that exists wins):
 *   1. the project's own node_modules/.bin/tsc (if they ran `npm install`)
 *   2. the CLI checkout's TypeScript during development/tests (a devDependency)
 *   3. `npx -y typescript` as a last resort
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCAFFOLD_TSCONFIG_FILENAME } from './scaffold.js';
import { TYPECHECK_TYPESCRIPT_VERSION } from './typecheck-version.js';

export interface TypeError {
  file: string;
  line: number;
  column: number;
  code: string; // e.g. "TS2304"
  message: string;
}

/**
 * Diagnostics about bare npm imports that can't be resolved LOCALLY but resolve
 * fine on deploy (esm.sh pins them from package.json). Reporting them would
 * drown the real "undefined symbol" signal and falsely fail clean code, so they
 * are dropped from the verdict:
 *   TS2307  Cannot find module 'X' or its corresponding type declarations
 *   TS7016  Could not find a declaration file for module 'X' (implicit any)
 *   TS2306  File is not a module
 *   TS2875  JSX runtime package can't be resolved locally
 * This is intentional and bounded: TS2304 (undefined name — the dropped-import
 * bug we're chasing) is NOT in this set and is always reported.
 */
const UNRESOLVED_DEP_CODES = new Set(['TS2307', 'TS7016', 'TS2306', 'TS2875']);

export interface TypecheckResult {
  /** true = no type errors. */
  ok: boolean;
  errors: TypeError[];
  /** How tsc was located, for a one-line "ran via …" note. */
  via: 'project' | 'bundled' | 'npx';
  /** Raw combined stdout+stderr — shown when we couldn't parse structured errors. */
  raw: string;
  /** Set when tsc itself couldn't be run at all. */
  spawnError?: string;
}

interface TscInvocation {
  command: string;
  args: string[];
  via: TypecheckResult['via'];
}

export function npxTscInvocation(
  platform: NodeJS.Platform = process.platform,
): TscInvocation {
  return {
    command: platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', '-p', `typescript@${TYPECHECK_TYPESCRIPT_VERSION}`, 'tsc'],
    via: 'npx',
  };
}

/**
 * Load the pulled tree's project config explicitly. TypeScript 7 reports
 * TS5112 when source files are passed because that would ignore tsconfig.json;
 * this project-wide invocation needs neither source-file args nor
 * --ignoreConfig.
 */
export function typecheckArgs(prefixArgs: readonly string[] = []): string[] {
  return [
    ...prefixArgs,
    '--project',
    SCAFFOLD_TSCONFIG_FILENAME,
    '--noEmit',
    '--pretty',
    'false',
  ];
}

/** Locate a runnable tsc. Never throws — npx is the always-available fallback. */
function resolveTsc(projectDir: string): TscInvocation {
  const projectBin = join(
    projectDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  if (existsSync(projectBin)) {
    return { command: projectBin, args: [], via: 'project' };
  }

  // TypeScript is a CLI devDependency, so this resolves in a source checkout
  // and tests. Published installs omit devDependencies and use the pinned npx
  // fallback below unless the project has its own compiler.
  try {
    const require = createRequire(import.meta.url);
    // typescript ships bin/tsc (a Node script). Resolve its package dir.
    const tscBin = require.resolve('typescript/bin/tsc');
    if (existsSync(tscBin)) {
      return { command: process.execPath, args: [tscBin], via: 'bundled' };
    }
  } catch {
    // not resolvable from here — fall through to npx
  }

  return npxTscInvocation();
}

/**
 * Parse tsc's default (non-pretty) diagnostic lines:
 *   path/to/file.ts(12,5): error TS2304: Cannot find name 'sanitizeForSpeech'.
 */
export function parseTscOutput(output: string): TypeError[] {
  const errors: TypeError[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
  for (const line of output.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    errors.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      code: m[4],
      message: m[5],
    });
  }
  return errors;
}

/**
 * Run a typecheck against `projectDir`. Assumes a tsconfig.json is present
 * (pull scaffolds one); without it, tsc errors loudly and we surface that.
 */
export function runTypecheck(projectDir: string): Promise<TypecheckResult> {
  const { command, args, via } = resolveTsc(projectDir);
  // --pretty false → stable, parseable one-line diagnostics regardless of TTY.
  const fullArgs = typecheckArgs(args);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, fullArgs, {
        cwd: projectDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows: tsc.cmd / npx.cmd are batch shims, and since Node 18.20/20.12
        // (CVE-2024-27980) spawning a .cmd/.bat without a shell throws EINVAL.
        // The bundled path runs node directly (process.execPath) and must NOT
        // shell — its arg is a resolved file path that a shell could mis-split.
        shell: /\.(cmd|bat)$/i.test(command),
      });
    } catch (err) {
      resolve({
        ok: false,
        errors: [],
        via,
        raw: '',
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));

    child.on('error', (err: Error) => {
      resolve({ ok: false, errors: [], via, raw: out, spawnError: err.message });
    });

    child.on('close', (code: number | null) => {
      const allErrors = parseTscOutput(out);
      // Drop locally-unresolvable bare-import diagnostics (they resolve on
      // deploy via esm.sh) so they don't bury the real bugs. Undefined symbols
      // (TS2304) survive the filter.
      const errors = allErrors.filter((e) => !UNRESOLVED_DEP_CODES.has(e.code));

      // tsc exits non-zero whenever it emits diagnostics. If it failed but we
      // parsed NONE (a config/crash failure, not type errors), don't claim
      // "clean" — surface it via raw output so the user sees something's wrong.
      const unexplainedFailure = code !== 0 && allErrors.length === 0;

      resolve({
        ok: errors.length === 0 && !unexplainedFailure,
        errors,
        via,
        raw: out,
      });
    });
  });
}

/** Where this module lives — used by tests that need the CLI package root. */
export function cliPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
