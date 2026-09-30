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

export async function readPublishedVersion(name, version, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`registry lookup failed: HTTP ${response.status}`);
  const body = await response.json();
  if (body.name !== name || body.version !== version || !/^[0-9a-f]{40}(?![\s\S])/.test(body.gitHead)) {
    throw new Error('registry returned ambiguous package/version/gitHead identity');
  }
  return body;
}

export async function inspectVersion(cwd = process.cwd(), expectedVersion) {
  const manifest = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  const shrinkwrap = JSON.parse(readFileSync(resolve(cwd, 'npm-shrinkwrap.json'), 'utf8'));
  validateReleaseShrinkwrap(manifest, shrinkwrap);
  if (manifest.name !== '@somewhere-tech/cli' || (expectedVersion && manifest.version !== expectedVersion)) {
    throw new Error('candidate package/version identity mismatch');
  }
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const published = await readPublishedVersion(manifest.name, manifest.version);
  const publishedHead = published?.gitHead;
  let hasReleaseInputDrift = false;
  if (publishedHead !== undefined && publishedHead !== currentHead) {
    ensureCommit(publishedHead, cwd);
    hasReleaseInputDrift = releaseInputsDiffer(publishedHead, currentHead, cwd);
  }
  const mode = classifyPublishedVersion(publishedHead, currentHead, hasReleaseInputDrift);

  return { version: manifest.version, mode, publishedHead, currentHead };
}

async function main() {
  const { version, mode, publishedHead } = await inspectVersion();
  writeOutput('version', version);
  writeOutput('mode', mode);
  console.log(JSON.stringify({ version, mode, publishedHead }));
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) await main();
