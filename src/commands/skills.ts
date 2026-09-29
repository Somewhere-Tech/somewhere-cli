import { Command } from 'commander';
import { CLI_VERSION } from '../lib/version.js';
import { BUNDLED_SKILLS_PACK } from '../lib/skills-pack.generated.js';
import {
  CLAUDE_SKILLS_DIR,
  SKILLS_DIR,
  SKILLS_LOCK,
  fetchLatestPack,
  installSkills,
  skillsStatus,
  type SkillsPack,
} from '../lib/skills-pack.js';
import { dim, error, info, printJson, printJsonError, success, teal, warn } from '../lib/output.js';

interface SkillsOptions {
  offline?: boolean;
  json?: boolean;
}

export function registerSkills(program: Command) {
  const skills = program
    .command('skills')
    .description(`Agent skills in ${SKILLS_DIR} (linked from ${CLAUDE_SKILLS_DIR}), pinned in ${SKILLS_LOCK}`);

  skills
    .command('status')
    .description('Say whether the installed skills match the latest pack; exit 1 when they do not')
    .option('--offline', 'Compare with the pack inside this CLI only; do not ask the docs host')
    .option('--json', 'Print the status as JSON')
    .action(async (opts: SkillsOptions) => {
      let latest: SkillsPack | null = null;
      try {
        latest = opts.offline ? null : await fetchLatestPack();
      } catch (err) {
        fail(err, opts.json, 'Status unknown.');
        return;
      }
      const status = skillsStatus(process.cwd(), BUNDLED_SKILLS_PACK, CLI_VERSION, latest);
      if (opts.json) printJson(status);
      else {
        (status.state === 'current' ? success : warn)(status.message);
        for (const path of [...status.missing, ...status.modified]) console.log(`  ${dim(path)}`);
      }
      if (status.state !== 'current') process.exitCode = 1;
    });

  skills
    .command('update')
    .description('Install or refresh the skills: the docs host pack (integrity-checked from trusted HTTPS origin) when reachable, else the pack inside this CLI')
    .option('--offline', 'Install the pack inside this CLI; do not ask the docs host')
    .option('--json', 'Print the result as JSON')
    .action(async (opts: SkillsOptions) => {
      let latest: SkillsPack | null = null;
      try {
        latest = opts.offline ? null : await fetchLatestPack();
      } catch (err) {
        // A pack that fails its hash check is never installed, and the
        // bundled one is not silently swapped in for it.
        fail(err, opts.json, 'Nothing was installed; `somewhere skills update --offline` installs the pack inside this CLI.');
        return;
      }
      const pack = latest ?? BUNDLED_SKILLS_PACK;
      const source = latest ? 'docs-host' : 'bundled';
      let result: ReturnType<typeof installSkills>;
      try { result = installSkills(process.cwd(), pack, { cli: CLI_VERSION, source }); }
      catch (err) { fail(err, opts.json, 'Installation did not complete; inspect `somewhere skills status`.', 'SKILLS_INSTALL_FAILED'); return; }
      if (opts.json) {
        printJson({ ...result, source });
        return;
      }
      success(`Skills ${teal(result.version)} installed in ${SKILLS_DIR} (${result.written.length} files, ${source === 'docs-host' ? 'from the docs host' : `from CLI ${CLI_VERSION}`})`);
      if (!latest && !opts.offline) info('The docs host did not serve a pack (offline, or not published there yet); installed the pack inside this CLI.');
      if (result.claude === 'copy') info(`Links are not available here; ${CLAUDE_SKILLS_DIR} holds copies.`);
      if (result.removed.length) info(`Removed skills no longer in the pack: ${result.removed.join(', ')}`);
    });
}

function fail(err: unknown, json: boolean | undefined, outcome: string, code = 'SKILLS_PACK_UNVERIFIED'): void {
  const message = `${err instanceof Error ? err.message : String(err)} ${outcome}`;
  if (json) printJsonError(code, message);
  else error(message);
  process.exitCode = 1;
}
