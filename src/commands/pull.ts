import { Command } from 'commander';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import {
  getToken,
  loadProjectConfigEntry,
  saveProjectDeployState,
  type ProjectConfigEntry,
} from '../lib/config.js';
import { IGNORE } from '../lib/files.js';
import { dim, error, info, printJson, success, teal, warn } from '../lib/output.js';
import {
  SCAFFOLD_PACKAGE_FILENAME,
  SCAFFOLD_TSCONFIG_FILENAME,
  buildScaffoldPackageJson,
  buildScaffoldTsconfig,
  extractDeps,
} from '../lib/scaffold.js';

interface SourceResponse {
  project_id: string;
  env: 'dev' | 'prod';
  version: number;
  static_files: Record<string, string>;
  binary_files: Record<string, string>;
  functions: Record<string, string>;
  counts: { static_files: number; binary_files: number; functions: number };
}

export function registerPull(program: Command) {
  program
    .command('pull [project]')
    .description(
      'Download a project\'s deployed source files to the current directory. ' +
        'Scaffolds a tsconfig.json + package.json (only if absent) so `somewhere typecheck` ' +
        'can catch undefined symbols locally before you deploy.',
    )
    .option('--env <env>', 'Environment to pull from (dev or prod)', 'dev')
    .option('--out <dir>', 'Output directory', '.')
    .option('--force', 'Overwrite existing files without prompting')
    .option('--json', 'Print the raw source response as JSON')
    .action(async (projectArg: string | undefined, opts) => {
      const token = getToken();
      const client = new ApiClient(token);
      const linkedProjectEntry = loadProjectConfigEntry();

      const envSlot = String(opts.env).toLowerCase();
      if (envSlot !== 'dev' && envSlot !== 'prod') {
        error('--env must be "dev" or "prod"');
        process.exit(1);
      }

      let projectId = projectArg;
      if (!projectId) {
        if (!linkedProjectEntry) {
          error('No project specified and no .somewhere.json found. Pass a project ID or run `somewhere init`.');
          process.exit(1);
        }
        projectId = linkedProjectEntry.config.project_id;
      }

      const outDir = resolve(process.cwd(), String(opts.out));
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      const spinner = opts.json ? null : ora(`Fetching ${envSlot} source...`).start();
      let body: SourceResponse;
      try {
        body = await client.call<SourceResponse>(
          'GET',
          '/deploy/source',
          undefined,
          { project_id: projectId, env: envSlot },
          { timeoutMs: LONG_CALL_TIMEOUT_MS },
        );
      } catch (err) {
        spinner?.fail('Pull failed');
        if (err instanceof CliApiError) {
          error(
            `${err.message} ${dim(err.statusCode ? `[${err.code}, HTTP ${err.statusCode}]` : `[${err.code}]`)}`,
          );
        } else {
          error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }
      spinner?.stop();

      const written: string[] = [];
      const skipped: string[] = [];

      const writeOne = (relPath: string, contents: Buffer | string) => {
        const target = join(outDir, relPath);
        if (existsSync(target) && !opts.force) {
          skipped.push(relPath);
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
        written.push(relPath);
      };

      for (const [path, content] of Object.entries(body.static_files)) {
        writeOne(path, content);
      }
      for (const [path, b64] of Object.entries(body.binary_files)) {
        writeOne(path, Buffer.from(b64, 'base64'));
      }
      for (const [path, content] of Object.entries(body.functions)) {
        writeOne(join('functions', path), content);
      }

      const removed = reconcileRemovedFiles(outDir, expectedPulledPaths(body), Boolean(opts.force));
      const deployStateEntry: ProjectConfigEntry | null = loadProjectConfigEntry(outDir);
      if (
        skipped.length === 0 &&
        removed.skipped.length === 0 &&
        deployStateEntry?.config.project_id === body.project_id &&
        Number.isInteger(body.version) &&
        body.version >= 1
      ) {
        saveProjectDeployState(deployStateEntry.dir, body.project_id, body.version);
      }

      const total = body.counts.static_files + body.counts.binary_files + body.counts.functions;
      if (total === 0 && !opts.json) {
        warn(`No files in ${envSlot} for this project.`);
      }
      if (!opts.json) {
        success(`Pulled ${written.length} file${written.length === 1 ? '' : 's'} from ${teal(envSlot)} (v${body.version}) to ${teal(outDir)}`);
      }
      if (skipped.length > 0 && !opts.json) {
        warn(`Skipped ${skipped.length} existing file${skipped.length === 1 ? '' : 's'} (use --force to overwrite):`);
        for (const p of skipped.slice(0, 10)) info(dim(`  ${p}`));
        if (skipped.length > 10) info(dim(`  ...and ${skipped.length - 10} more`));
      }
      if (removed.removed.length > 0 && !opts.json) {
        info(dim(`Removed ${removed.removed.length} file${removed.removed.length === 1 ? '' : 's'} deleted remotely.`));
      }
      if (removed.skipped.length > 0 && !opts.json) {
        warn(`Skipped removing ${removed.skipped.length} file${removed.skipped.length === 1 ? '' : 's'} deleted remotely (use --force to remove):`);
        for (const p of removed.skipped.slice(0, 10)) info(dim(`  ${p}`));
        if (removed.skipped.length > 10) info(dim(`  ...and ${removed.skipped.length - 10} more`));
      }

      // Scaffold the two files a local typecheck needs (tsconfig + package.json)
      // so `somewhere typecheck` / `tsc --noEmit` can catch a dropped import
      // BEFORE deploy. Written only when absent — never clobbers a project's
      // own config, even with --force (that flag is for source files, not
      // local tooling we're adding on top).
      const scaffolded = scaffoldTypecheckFiles(outDir, body.static_files);
      if (opts.json) {
        printJson(body);
        return;
      }
      if (scaffolded.length) {
        info(dim(`Added ${scaffolded.join(' + ')} for local typechecking.`));
        info(`Run ${teal('somewhere typecheck')} before deploy to catch undefined symbols.`);
      }
    });
}

/**
 * Write tsconfig.json + package.json into a pulled tree if they're not already
 * there. Returns the filenames actually written. Deps for the scaffolded
 * package.json come from the project's own package.json when it shipped one.
 */
function scaffoldTypecheckFiles(
  outDir: string,
  staticFiles: Record<string, string>,
): string[] {
  const added: string[] = [];

  const tsconfigPath = join(outDir, SCAFFOLD_TSCONFIG_FILENAME);
  if (!existsSync(tsconfigPath)) {
    writeFileSync(tsconfigPath, buildScaffoldTsconfig());
    added.push(SCAFFOLD_TSCONFIG_FILENAME);
  }

  const packagePath = join(outDir, SCAFFOLD_PACKAGE_FILENAME);
  if (!existsSync(packagePath)) {
    const deps = extractDeps(staticFiles['package.json']);
    writeFileSync(
      packagePath,
      buildScaffoldPackageJson(basename(outDir), deps),
    );
    added.push(SCAFFOLD_PACKAGE_FILENAME);
  }

  return added;
}

function expectedPulledPaths(body: SourceResponse): Set<string> {
  const expected = new Set<string>();
  for (const path of Object.keys(body.static_files)) expected.add(normalizeRelPath(path));
  for (const path of Object.keys(body.binary_files)) expected.add(normalizeRelPath(path));
  for (const path of Object.keys(body.functions)) {
    expected.add(normalizeRelPath(join('functions', path)));
  }
  return expected;
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function reconcileRemovedFiles(
  outDir: string,
  expected: Set<string>,
  force: boolean,
): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relPath = normalizeRelPath(relative(outDir, fullPath));
      if (expected.has(relPath)) continue;
      if (!force) {
        skipped.push(relPath);
        continue;
      }
      try {
        rmSync(fullPath);
        removed.push(relPath);
      } catch {
        skipped.push(relPath);
      }
    }
  };

  walk(outDir);
  return { removed, skipped };
}
