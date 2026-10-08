import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateCandidate, assertCandidateIdentity, assertProvenanceSource, pollVerification } from '../scripts/publish-release.mjs';
import { readPublishedVersion } from '../scripts/version-guard.mjs';

const source = 'a'.repeat(40);
const publisher = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const guard = readFileSync(new URL('../.github/workflows/version-guard.yml', import.meta.url), 'utf8');
const script = publisher.match(/          script: \|\n([\s\S]*?)      - uses: actions\/checkout/)[1].split('\n').map((line) => line.slice(12)).join('\n');
const authenticate = new Function('context', 'github', 'core', `return (async () => { ${script} })()`);
const official = 'Somewhere-Tech/somewhere-cli';
function context(run = {}) {
  return { repo: { owner: 'Somewhere-Tech', repo: 'somewhere-cli' }, eventName: 'workflow_run', sha: source, ref: 'refs/heads/master', payload: { workflow_run: {
    conclusion: 'success', event: 'push', head_branch: 'master', head_sha: source,
    head_repository: { full_name: official }, repository: { full_name: official }, path: '.github/workflows/version-guard.yml', ...run,
  } } };
}
async function trigger(ctx, master = source) {
  const outputs = {};
  await authenticate(ctx, { rest: { repos: { getBranch: async () => ({ data: { commit: { sha: master } } }) } } }, { setOutput: (key, value) => { outputs[key] = value; } });
  return outputs;
}

test('canonical publisher alone publishes, serializes both triggers and pins immutable checkout', () => {
  assert.doesNotMatch(guard, /npm publish|id-token:|contents: write|git push/);
  assert.match(guard, /contents: read/);
  for (const workflow of [guard, publisher]) {
    assert.match(workflow, /node-version: '22'/);
    assert.match(workflow, /npm install -g npm@11\.19\.0/);
  }
  assert.doesNotMatch(guard, /npm ci|npm test|npm run build/);
  assert.match(guard, /run: node scripts\/version-guard\.mjs/);
  assert.ok(publisher.indexOf('npm install -g') < publisher.indexOf('npm ci'));
  assert.match(publisher, /npm test/);
  assert.ok(publisher.indexOf('npm test') < publisher.indexOf('npm publish --provenance'));
  assert.equal((publisher.match(/npm publish --provenance --access public/g) ?? []).length, 1);
  assert.doesNotMatch(publisher, /tags:|cancel-in-progress: true|download-artifact|git push/);
  assert.match(publisher, /group: somewhere-cli-publish\n  cancel-in-progress: false/);
  assert.match(publisher, /ref: \$\{\{ steps.trigger.outputs.source \}\}/);
  assert.ok(publisher.indexOf('Authenticate trigger') < publisher.indexOf('actions/checkout'));
  assert.equal((publisher.match(/run: node scripts\/publish-release.mjs check/g) ?? []).length, 2);
  assert.match(publisher, /if: steps.final.outputs.mode == 'release'/);
  assert.match(publisher, /SOURCE_SHA: \$\{\{ steps.final.outputs.published_head \}\}/);
});

test('exact trusted successful master guard accepted; untrusted states fail before checkout', async () => {
  assert.deepEqual(await trigger(context()), { source, version: '' });
  for (const run of [
    { conclusion: 'failure' }, { event: 'pull_request' }, { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/cli' } }, { repository: { full_name: 'fork/cli' } },
    { path: '.github/workflows/other.yml' }, { head_sha: 'bad' },
  ]) await assert.rejects(trigger(context(run)));
  await assert.rejects(trigger(context(), 'b'.repeat(40)), /stale source/);
  await assert.rejects(trigger({ ...context(), sha: 'b'.repeat(40) }), /OIDC source/);
  const fork = context(); fork.repo.owner = 'fork';
  await assert.rejects(trigger(fork), /untrusted repository/);
});

test('dispatch validates exact inputs without interpolation and requires master workflow ref', async () => {
  const dispatch = { ...context(), eventName: 'workflow_dispatch', payload: { inputs: { source_sha: source, expected_version: '1.2.3' } } };
  assert.deepEqual(await trigger(dispatch), { source, version: '1.2.3' });
  for (const version of ['$(touch /tmp/injected)', '1.2', '01.2.3', '1.2.3-01', '1.2.3\nfoo', '1.2.3\n']) {
    await assert.rejects(trigger({ ...dispatch, payload: { inputs: { source_sha: source, expected_version: version } } }));
    assert.throws(() => validateCandidate(source, version));
  }
  await assert.rejects(trigger({ ...dispatch, ref: 'refs/heads/feature' }));
  for (const version of ['0.0.0', '1.2.3-beta.1', '1.2.3+build.1']) validateCandidate(source, version);
  assert.throws(() => validateCandidate('$(echo evil)', '1.2.3'));
  assert.throws(() => validateCandidate(source + '\n', '1.2.3'));
  await assert.rejects(trigger(context({ head_sha: source + '\n' })));
});

test('identity accepts exact current source and rejects either stale checkout or master', () => {
  assert.doesNotThrow(() => assertCandidateIdentity(source, source, source));
  assert.throws(() => assertCandidateIdentity(source, 'b'.repeat(40), source));
  assert.throws(() => assertCandidateIdentity(source, source, 'b'.repeat(40)));
});

test('only explicit 404 is absent; valid registry identity accepted; ambiguity/errors refuse', async () => {
  const read = (status, body) => readPublishedVersion('@somewhere-tech/cli', '1.2.3', async () => ({ status, ok: status === 200, json: async () => body }));
  assert.equal(await read(404), undefined);
  const manifest = { name: '@somewhere-tech/cli', version: '1.2.3', gitHead: source };
  assert.deepEqual(await read(200, manifest), manifest);
  for (const status of [401, 403, 429, 500]) await assert.rejects(read(status), /registry lookup failed/);
  for (const body of [{ ...manifest, gitHead: undefined }, { ...manifest, name: 'other' }, { ...manifest, version: '2.0.0' }]) await assert.rejects(read(200, body), /ambiguous/);
  await assert.rejects(readPublishedVersion('name', 'version', async () => { throw new Error('timeout'); }), /timeout/);
});

test('propagation polling repeats only verification reads and bounds unknown outcomes', async () => {
  let reads = 0, elapsed = 0;
  assert.equal(await pollVerification(async () => { reads++; if (elapsed < 9 * 60_000) throw new Error('pending'); return 'verified'; }, async (ms) => { elapsed += ms; }), 'verified');
  assert.equal(reads, 10);
  assert.equal(elapsed, 9 * 60_000);
  reads = 0; elapsed = 0;
  await assert.rejects(pollVerification(async () => { reads++; throw new Error('pending'); }, async (ms) => { elapsed += ms; }), /state unknown.*do not retry publication/);
  assert.equal(reads, 16);
  assert.equal(elapsed, 15 * 60_000);
});

test('additional exact provenance source check rejects another commit', () => {
  const body = { attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({ predicate: { buildDefinition: { resolvedDependencies: [{ uri: `git+https://github.com/${official}@refs/heads/master`, digest: { gitCommit: source } }] } } })).toString('base64') } } }] };
  assert.doesNotThrow(() => assertProvenanceSource(body, source));
  assert.throws(() => assertProvenanceSource(body, 'b'.repeat(40)), /registry gitHead/);
});
