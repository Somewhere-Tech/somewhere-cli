import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_INPUTS = [
  'src',
  'bin',
  'package.json',
  'npm-shrinkwrap.json',
  // Independent browser probe shipped in the package.
  'runtime',
  'scripts/extract-runtime.mjs',
];

function gitResult(args, cwd = process.cwd()) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ensureCommit(head, cwd = process.cwd()) {
  if (gitResult(['cat-file', '-e', `${head}^{commit}`], cwd).status === 0) return;
  execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', head], {
    cwd,
    stdio: 'inherit',
  });
  if (gitResult(['cat-file', '-e', `${head}^{commit}`], cwd).status !== 0) {
    throw new Error(`published gitHead ${head} is not available from the official repository`);
  }
}

export function releaseInputsDiffer(publishedHead, currentHead, cwd = process.cwd()) {
  const result = gitResult([
    'diff',
    '--quiet',
    publishedHead,
    currentHead,
    '--',
    ...RELEASE_INPUTS,
  ], cwd);
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(result.stderr.trim() || 'could not compare the published release inputs');
}

export function classifyPublishedVersion(publishedHead, currentHead, hasReleaseInputDrift) {
  if (publishedHead === undefined) return 'release';
  if (publishedHead === currentHead || !hasReleaseInputDrift) return 'in-sync';
  return 'drift';
}

export function validateReleaseShrinkwrap(manifest, shrinkwrap) {
  const expected = `${manifest.name}@${manifest.version}`;
  const root = shrinkwrap?.packages?.[''];
  const mismatches = [];

  if (shrinkwrap?.name !== manifest.name) {
    mismatches.push(`top-level name is ${JSON.stringify(shrinkwrap?.name)}`);
  }
  if (shrinkwrap?.version !== manifest.version) {
    mismatches.push(`top-level version is ${JSON.stringify(shrinkwrap?.version)}`);
  }
  if (root?.name !== manifest.name) {
    mismatches.push(`packages[""].name is ${JSON.stringify(root?.name)}`);
  }
  if (root?.version !== manifest.version) {
    mismatches.push(`packages[""].version is ${JSON.stringify(root?.version)}`);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `npm-shrinkwrap.json does not authenticate ${expected}: ${mismatches.join('; ')}. ` +
      'Regenerate it before releasing.',
    );
  }
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${name}=${value}\n`);
}

function main() {
  const cwd = process.cwd();
  const manifest = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  const shrinkwrap = JSON.parse(readFileSync(resolve(cwd, 'npm-shrinkwrap.json'), 'utf8'));
  validateReleaseShrinkwrap(manifest, shrinkwrap);
  const currentHead = process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const published = spawnSync(
    'npm',
    ['view', `${manifest.name}@${manifest.version}`, 'gitHead'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );

  let publishedHead;
  if (published.status === 0) {
    publishedHead = published.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(publishedHead)) {
      throw new Error(`npm returned an invalid gitHead for ${manifest.name}@${manifest.version}`);
    }
  }

  let hasReleaseInputDrift = false;
  if (publishedHead !== undefined && publishedHead !== currentHead) {
    ensureCommit(publishedHead, cwd);
    hasReleaseInputDrift = releaseInputsDiffer(publishedHead, currentHead, cwd);
  }
  const mode = classifyPublishedVersion(publishedHead, currentHead, hasReleaseInputDrift);

  writeOutput('version', manifest.version);
  writeOutput('mode', mode);
  if (mode === 'release') {
    console.log(`▲ ${manifest.name}@${manifest.version} is not on npm — this push releases it.`);
  } else if (mode === 'in-sync') {
    console.log(`✓ ${manifest.name}@${manifest.version} release inputs match the published commit.`);
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
