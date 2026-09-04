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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
 * A type package declared in package.json but absent from node_modules is not a
 * mistake in the code — it is a tree that has not been installed yet. tsc has no
 * way to tell those apart, so the first check on a fresh pull failed with
 * TS2503 ("Cannot find namespace 'JSX'") and every agent lost a couple of
 * minutes installing by hand before re-running. Resolving the DECLARED packages
 * first makes the first check mean what it says.
 *
 * Deliberately narrow, so this can never mask a real bug:
 *   - only `@types/*` entries, only ones the project itself declares, only ones
 *     actually missing from node_modules. An UNDECLARED import still fails with
 *     its real diagnostic — that is the bug the gate exists to catch.
 *   - a warm tree plans nothing and spawns nothing.
 * Mirrors the prerequisite the platform's deploy-check container already
 * provides for the same tree.
 */
export interface DeclaredTypesPlan {
  /** Install specs (`@types/react@^18.3.0`) for declared-but-missing packages. */
  specs: string[];
  /** Bare package names, for messaging. */
  missing: string[];
}

export type TypePackageInstaller = (specs: string[], projectDir: string) => void;

export function planDeclaredTypePackages(projectDir: string): DeclaredTypesPlan {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return { specs: [], missing: [] }; // no manifest, nothing declared
  }
  if (!manifest || typeof manifest !== 'object') return { specs: [], missing: [] };
  const record = manifest as Record<string, unknown>;
  const declared: Record<string, string> = {};
  for (const field of ['dependencies', 'devDependencies']) {
    const group = record[field];
    if (!group || typeof group !== 'object') continue;
    for (const [name, range] of Object.entries(group as Record<string, unknown>)) {
      if (name.startsWith('@types/') && typeof range === 'string' && range) declared[name] = range;
    }
  }

  const specs: string[] = [];
  const missing: string[] = [];
  for (const [name, range] of Object.entries(declared)) {
    if (existsSync(join(projectDir, 'node_modules', ...name.split('/')))) continue;
    missing.push(name);
    // `name@range` is npm's spec form for a semver range, a file:/link: path,
    // and a git/URL range alike, so one shape covers every declaration.
    specs.push(`${name}@${range}`);
  }
  return { specs, missing };
}

function npmInstallTypePackages(specs: string[], projectDir: string): void {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error', ...specs],
    {
      cwd: projectDir,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install exited ${result.status}`);
}

/**
 * Resolve declared-but-missing type packages. Fail-OPEN by contract: if the
 * install cannot run (offline, no npm, a private registry) the typecheck still
 * proceeds and reports whatever tsc finds. This step may never be the reason a
 * check does not happen.
 */
export function ensureDeclaredTypePackages(
  projectDir: string,
  install: TypePackageInstaller = npmInstallTypePackages,
): DeclaredTypesPlan & { installed: boolean } {
  const plan = planDeclaredTypePackages(projectDir);
  if (plan.specs.length === 0) return { ...plan, installed: false };
  try {
    install(plan.specs, projectDir);
    return { ...plan, installed: true };
  } catch {
    return { ...plan, installed: false };
  }
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
export function runTypecheck(
  projectDir: string,
  options: { installTypePackages?: TypePackageInstaller | false } = {},
): Promise<TypecheckResult> {
  // Declared type packages first, so the FIRST check is a real verdict rather
  // than a report that the tree is not installed yet.
  if (options.installTypePackages !== false) {
    ensureDeclaredTypePackages(projectDir, options.installTypePackages);
  }
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
