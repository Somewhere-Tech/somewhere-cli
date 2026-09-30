import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_INPUTS, inspectVersion, readPublishedVersion } from './version-guard.mjs';

export function validateCandidate(source, version) {
  if (!/^[0-9a-f]{40}(?![\s\S])/.test(source ?? '')) throw new Error('source must be an exact lowercase 40-hex commit');
  // Canonical SemVer, without a leading v or leading numeric zeroes.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/.test(version ?? '')) {
    throw new Error('expected version must be canonical SemVer');
  }
}

export function assertCandidateIdentity(source, head, master) {
  if (head !== source || master !== source) throw new Error('candidate is no longer exact current origin/master');
}

export async function checkCandidate(source, version) {
  validateCandidate(source, version);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  if (!/^https:\/\/github\.com\/Somewhere-Tech\/somewhere-cli(?:\.git)?$/.test(git('remote', 'get-url', 'origin'))) {
    throw new Error('unexpected origin repository');
  }
  git('fetch', '--no-tags', 'origin', '+refs/heads/master:refs/remotes/origin/master');
  assertCandidateIdentity(source, git('rev-parse', 'HEAD'), git('rev-parse', 'origin/master'));
  git('diff', '--exit-code', 'HEAD', '--', ...RELEASE_INPUTS);
  const state = await inspectVersion(process.cwd(), version);
  if (state.mode === 'drift') throw new Error('published version has different guarded release inputs');
  console.log(JSON.stringify({ ...state, publication: state.mode === 'in-sync' ? 'already-published-no-op' : 'candidate' })); // In-sync descendants retain the actual registry gitHead.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${state.mode}\npublished_head=${state.publishedHead ?? source}\n`);
  return state;
}

export function assertProvenanceSource(body, source) {
  const attestation = body.attestations?.find((entry) => entry.predicateType === 'https://slsa.dev/provenance/v1');
  const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const sources = statement.predicate?.buildDefinition?.resolvedDependencies?.filter((entry) =>
    entry.uri?.startsWith('git+https://github.com/Somewhere-Tech/somewhere-cli@'));
  if (!sources?.length || sources.some((entry) => entry.digest?.gitCommit !== source)) {
    throw new Error('verified provenance does not authenticate the registry gitHead');
  }
}

export async function pollVerification(verify, pause = (ms) => new Promise((done) => setTimeout(done, ms))) {
  let lastError;
  for (let attempt = 0; attempt < 16; attempt++) {
    try { return await verify(); } catch (error) { lastError = error; }
    if (attempt < 15) await pause(60_000);
  }
  throw new Error(`publication state unknown; read verification exhausted; do not retry publication: ${lastError.message}`);
}

async function verifyRegistry(source, version) {
  const { parseOfficialRelease, verifyTarballIntegrity, verifyPublishedProvenance } = await import('../dist/lib/update-security.js');
  const get = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`verification read failed: HTTP ${response.status}`);
    return response;
  };
  await pollVerification(async () => {
    const manifest = await readPublishedVersion('@somewhere-tech/cli', version);
    if (!manifest || manifest.gitHead !== source) throw new Error('registry source identity mismatch or pending publication');
    const release = parseOfficialRelease({ 'dist-tags': { latest: version }, versions: { [version]: manifest } });
    verifyTarballIntegrity(new Uint8Array(await (await get(release.tarballUrl)).arrayBuffer()), release.integrity);
    const provenance = await (await get(release.attestationUrl)).json();
    await verifyPublishedProvenance(provenance, release);
    assertProvenanceSource(provenance, source);
    console.log(JSON.stringify({ verified: true, version, publishedHead: source, integrity: release.integrity }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, source, version] = process.argv.slice(2);
  validateCandidate(source, version);
  if (phase === 'check') await checkCandidate(source, version);
  else if (phase === 'verify') await verifyRegistry(source, version);
  else throw new Error('unknown publisher phase');
}
