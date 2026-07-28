import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ora from '../lib/spinner.js';
import { bold, dim, error, info, printJson, red, success, teal, warn } from '../lib/output.js';
import { runTypecheck, type TypecheckResult } from '../lib/typecheck.js';

export function registerTypecheck(program: Command) {
  program
    .command('typecheck [dir]')
    .description(
      'Typecheck a pulled project with `tsc --noEmit` — the "is this safe to deploy?" gate. ' +
        'Catches undefined symbols (a dropped import) and type errors with file:line BEFORE they 500 in production. ' +
        'Run after `somewhere pull`, which scaffolds the tsconfig this uses.',
    )
    .option('--json', 'Print the raw typecheck result as JSON')
    .action(async (dirArg: string | undefined, opts) => {
      const dir = resolve(process.cwd(), dirArg ?? '.');

      if (!existsSync(join(dir, 'tsconfig.json'))) {
        if (opts.json) {
          printJson({
            ok: false,
            errors: [],
            via: 'bundled',
            raw: '',
            spawnError: 'No tsconfig.json here to typecheck against.',
          });
          process.exit(1);
        }
        error('No tsconfig.json here to typecheck against.');
        info(
          dim(
            'Run `somewhere pull` in this directory first — it scaffolds the tsconfig + package.json that this gate needs.',
          ),
        );
        process.exit(1);
      }

      const spinner = opts.json ? null : ora('Typechecking (tsc --noEmit)...').start();
      const result = await runTypecheck(dir);
      spinner?.stop();

      if (opts.json) {
        printJson(result);
        process.exit(result.ok ? 0 : 1);
      }
      reportTypecheck(result);
      process.exit(result.ok ? 0 : 1);
    });
}

/** Print a typecheck verdict. Shared so `dev --local`/`--check` render identically. */
export function reportTypecheck(result: TypecheckResult): void {
  if (result.spawnError) {
    error(`Could not run the typechecker: ${result.spawnError}`);
    info(dim('Install TypeScript (`npm i -D typescript`) or ensure `npx` is on PATH.'));
    return;
  }

  if (result.ok) {
    success(`Typecheck clean ${dim(`(via ${result.via} tsc)`)} — safe to deploy.`);
    return;
  }

  if (result.errors.length === 0) {
    // tsc failed but we couldn't parse structured diagnostics — show raw.
    error('Typecheck failed.');
    if (result.raw.trim()) console.error(result.raw.trim());
    return;
  }

  const undefinedSymbols = result.errors.filter((e) => e.code === 'TS2304');
  const n = result.errors.length;
  error(
    `${bold(String(n))} type error${n === 1 ? '' : 's'} ${dim(`(via ${result.via} tsc)`)} — deploys are not blocked by type errors; fix at your own pace.`,
  );
  if (undefinedSymbols.length) {
    warn(
      `${undefinedSymbols.length} undefined symbol${undefinedSymbols.length === 1 ? '' : 's'} (likely a dropped import) — exactly the bug that 500s production.`,
    );
  }
  console.log('');
  for (const e of result.errors) {
    const loc = `${teal(e.file)}:${e.line}:${e.column}`;
    const tag = e.code === 'TS2304' ? red(e.code) : dim(e.code);
    console.log(`  ${loc} ${tag} ${e.message}`);
  }
  console.log('');
}
