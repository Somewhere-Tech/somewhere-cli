import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = Boolean(process.env.SOMEWHERE_TEST_SOURCE);
const moduleRoot = source ? '../src' : '../dist';
const ext = source ? 'ts' : 'js';
const { initCatalog, resolveInitSelection, InitSelectionError, describeSelection } =
  await import(`${moduleRoot}/lib/init-features.${ext}`);
const { createFeatureTemplate } = await import(`${moduleRoot}/lib/init-feature-template.${ext}`);
const { writeInitScaffold } = await import(`${moduleRoot}/lib/init-scaffold.${ext}`);
const { runTypecheck } = await import(`${moduleRoot}/lib/typecheck.${ext}`);
const { collectFiles } = await import(`${moduleRoot}/lib/files.${ext}`);

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, '../bin/somewhere.js');
const declaredData = createRequire(import.meta.url)('../runtime/declared-data.cjs');

const COMBINATIONS = [
  ['auth', 'styled'],
  ['auth', 'headless'],
  ['auth,private-data', 'styled'],
  ['auth,private-data', 'headless'],
  ['agent', 'styled'],
  ['agent', 'headless'],
  ['auth,private-data,agent', 'styled'],
  ['magic-link', 'styled'],
  ['magic-link', 'headless'],
  ['magic-link,private-data', 'styled'],
];

function tempDir(prefix = 'somewhere-init-features-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function generate(features, ui, appName = 'Fieldbook') {
  const dir = tempDir();
  const selection = resolveInitSelection(features, ui);
  const result = writeInitScaffold(dir, createFeatureTemplate(selection, { appName }));
  return { dir, selection, result, read: (path) => readFileSync(join(dir, path), 'utf8') };
}

// ------------------------------------------------------------------ selection

test('private-data resolves auth explicitly and reports it as added', () => {
  const selection = resolveInitSelection('private-data');
  assert.deepEqual(selection, {
    requested: ['private-data'],
    added: ['auth'],
    modules: ['auth', 'private-data'],
    ui: 'styled',
  });
  assert.equal(describeSelection(selection), 'auth, private-data (auth added: required by private-data) · ui styled');
  assert.deepEqual(resolveInitSelection(' private-data , auth,auth ', 'headless'), {
    requested: ['auth', 'private-data'],
    added: [],
    modules: ['auth', 'private-data'],
    ui: 'headless',
  });
});

test('unknown modules, unoffered modules and unknown UI modes are usage errors', () => {
  assert.throws(() => resolveInitSelection('auth,teams'), (err) =>
    err instanceof InitSelectionError && /Unknown --features teams/.test(err.message) && /member\(\)/.test(err.message));
  assert.throws(() => resolveInitSelection(''), InitSelectionError);
  assert.throws(() => resolveInitSelection(' , '), InitSelectionError);
  assert.throws(() => resolveInitSelection('auth', 'bootstrap'), /Unknown --ui bootstrap/);
});

test('catalog is machine-readable and lists module files from the generator', () => {
  const catalog = initCatalog((selection) => createFeatureTemplate(selection, { appName: 'x' }));
  assert.equal(catalog.version, 1);
  assert.deepEqual(catalog.modules.map((m) => [m.id, m.requires]), [['auth', []], ['magic-link', ['auth']], ['private-data', ['auth']], ['agent', ['auth']]]);
  assert.ok(catalog.modules[0].files.includes('api/auth/[...path].ts'));
  // tsk_28753a0e: the /auth/magic landing is part of auth; magic-link adds
  // only the link form, inside files auth already writes.
  for (const path of ['src/auth/magic-link.ts', 'src/pages/MagicLinkPage.tsx', 'src/ui/MagicLink.tsx', 'types/magic-link.ts']) {
    assert.ok(catalog.modules[0].files.includes(path), path);
  }
  assert.deepEqual(catalog.modules[1].files, []);
  assert.match(catalog.modules[0].summary, /\/auth\/magic/);
  assert.match(catalog.modules[1].summary, /auth already routes/);
  assert.ok(catalog.modules[0].files.includes('src/auth/useEmailVerification.ts') && catalog.modules[0].files.includes('src/ui/VerifyEmail.tsx'),
    'email verification is part of the auth module');
  assert.deepEqual(catalog.modules[2].files, [
    'db/schema.ts',
    'src/data/useNotes.ts',
    'src/services/notes.ts',
    'src/ui/NotesBoard.tsx',
    'types/notes.ts',
  ]);
  assert.deepEqual(catalog.modules[3].files, [
    'api/chat.ts',
    'api/proposals.ts',
    'db/schema.ts',
    'flows/assistant-fixtures.json',
    'src/data/useAssistant.ts',
    'src/fixtures/assistant.ts',
    'src/pages/AssistantFixturesPage.tsx',
    'src/services/assistant.ts',
    'src/ui/AssistantPanel.tsx',
    'types/assistant.ts',
  ]);
  assert.deepEqual(catalog.ui.map((u) => u.id), ['styled', 'headless']);
  assert.ok(catalog.ui[0].files.includes('src/styles/tokens.css'));
  assert.deepEqual(catalog.ui[1].files, ['src/ui/AppShell.tsx', 'src/ui/AssistantPanel.tsx', 'src/ui/AuthCard.tsx', 'src/ui/MagicLink.tsx', 'src/ui/NotesBoard.tsx', 'src/ui/VerifyEmail.tsx', 'src/ui/feedback.tsx']);
  assert.ok(!catalog.ui[0].files.some((path) => path.startsWith('src/pages/')), 'pages are shared by both modes');
  assert.equal(catalog.defaults.ui, 'styled');
  for (const id of ['private-files', 'payments', 'teams', 'public-sharing', 'password-reset', 'oauth', 'mfa', 'agent-durable']) {
    assert.ok(catalog.not_offered.some((entry) => entry.id === id), id);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
});

// ------------------------------------------------------------ generated files

test('every combination separates types, services, hooks, pages and presentational UI', () => {
  for (const [features, ui] of COMBINATIONS) {
    const { dir, result, read } = generate(features, ui);
    const files = result.created;
    const label = `${features}/${ui}`;
    for (const path of [
      'api/auth/[...path].ts',
      'types/auth.ts',
      'src/services/auth.ts',
      'src/auth/hooks.ts',
      'src/routes.ts',
      'src/App.tsx',
      'src/pages/SignInPage.tsx',
      'src/pages/HomePage.tsx',
      'src/ui/AuthCard.tsx',
    ]) assert.ok(files.includes(path), `${label}: ${path}`);
    assert.equal(files.includes('db/schema.ts'), features.includes('private-data') || features.includes('agent'), label);
    assert.equal(files.some((path) => path.startsWith('src/styles/')), ui === 'styled', label);

    // The packaged SDK route, byte-identical to the default starter's.
    assert.equal(read('api/auth/[...path].ts'), "export { somewhereAuth as default } from '@somewhere-tech/sdk/server';\n");
    // App.tsx routes; it neither fetches nor renders forms.
    const app = read('src/App.tsx');
    assert.doesNotMatch(app, /fetch\(|<form|<input|somewhere:data/);
    assert.match(app, /session\.status === 'loading'\) return <LoadingScreen /);
    assert.match(app, /session\.status === 'signed-out'\) return <SignInPage \/>/);
    assert.match(app, /<PrivateRoutes key=\{session\.user\.id\}/, 'private subtree is keyed by the verified user');

    const all = Object.values(collectFiles(dir).files).join('\n');
    assert.doesNotMatch(all, /\bany\b/);
    assert.doesNotMatch(all, /localStorage|sessionStorage|Authorization|Bearer|accessToken|refreshToken|getSession|useSession/);
    assert.doesNotMatch(all, /user_id|owner_id|\.owner\b|where: \{ *user/, `${label}: no client-side owner filters`);
    assert.doesNotMatch(all, /fonts\.googleapis|@import url|https?:\/\/[^\s'"`]*\.(woff2?|ttf)/, `${label}: no remote fonts`);
    const pkg = JSON.parse(read('package.json'));
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@somewhere-tech/sdk', 'react', 'react-dom']);
    assert.equal(pkg.dependencies['@somewhere-tech/sdk'], '0.11.6', 'the SDK release with the email verification routes');
    assert.equal(pkg.scripts.build, undefined);
  }
});

test('views take props only, and both UI modes share pages, hooks and view signatures', () => {
  const styled = generate('auth,magic-link,private-data,agent', 'styled');
  const plain = generate('auth,magic-link,private-data,agent', 'headless');
  for (const path of styled.result.created.filter((p) => /^(src\/(pages|auth|data|services)\/|types\/|src\/App|src\/routes)/.test(p))) {
    assert.equal(plain.read(path), styled.read(path), `${path} is shared`);
  }
  const signatures = (text) => [...text.matchAll(/^export (?:function \w+\([^)]*\)|interface \w+)/gm)].map((m) => m[0]);
  for (const path of styled.result.created.filter((p) => p.startsWith('src/ui/'))) {
    assert.deepEqual(signatures(plain.read(path)), signatures(styled.read(path)), `${path}: same exports and props`);
  }
  const { dir, result } = styled;
  const uiFiles = [...result.created.filter((path) => path.startsWith('src/ui/'))];
  assert.equal(uiFiles.length, 7);
  for (const [root, path] of [...uiFiles.map((p) => [dir, p]), ...uiFiles.map((p) => [plain.dir, p])]) {
    const content = readFileSync(join(root, path), 'utf8');
    const imports = [...content.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.match(specifier, /^(react|\.\/[A-Za-z]+|\.\.\/routes|\.\.\/\.\.\/types\/(auth|magic-link|notes|assistant))$/, `${path} imports ${specifier}`);
    }
    assert.doesNotMatch(content, /import (?!type)[^;]*\.\.\/\.\.\/types/, `${path}: types are type-only imports`);
    assert.doesNotMatch(content, /\buse(Auth|User|Notes|Assistant|SignOut|CredentialsForm)\b|fetch\(/, path);
  }
  // Deleting the look leaves behaviour intact: services/hooks never import ui or styles.
  for (const path of ['src/services/auth.ts', 'src/services/notes.ts', 'src/services/assistant.ts', 'src/auth/hooks.ts', 'src/data/useNotes.ts', 'src/data/useAssistant.ts']) {
    assert.doesNotMatch(readFileSync(join(dir, path), 'utf8'), /\/ui\/|\.css'/, path);
  }
});

test('every auth starter routes /auth/magic before the gate; magic-link adds only the link form (tsk_28753a0e)', () => {
  for (const ui of ['styled', 'headless']) {
    const plain = generate('auth', ui);
    const magic = generate('magic-link', ui);
    assert.deepEqual(magic.selection.modules, ['auth', 'magic-link']);
    for (const starter of [plain, magic]) {
      const app = starter.read('src/App.tsx');
      const route = app.indexOf("if (pathname === '/auth/magic') return <MagicLinkPage />;");
      assert.ok(route > 0, 'the landing page is routed');
      assert.ok(route < app.indexOf("session.status === 'loading'"), 'it is decided before the session gate');
      assert.ok(app.indexOf('const session = useAuthState();') < route, 'hooks run before the early return');
      const hooks = starter.read('src/auth/magic-link.ts');
      assert.equal(hooks.match(/auth\.verifyMagicLink\(/g)?.length, 1, 'one verify call site');
      assert.match(hooks, /started\.current/, 'the one-time token is verified once, even under StrictMode');
      assert.match(hooks, /history\.replaceState/, 'the token is removed from the address bar');
      assert.match(starter.read('src/ui/MagicLink.tsx'), /export function MagicLinkStatus/);
    }
    // The landing is the same code with or without the module.
    for (const path of ['src/App.tsx', 'src/pages/MagicLinkPage.tsx']) assert.equal(plain.read(path), magic.read(path), path);
    const landing = (source) => source.slice(source.indexOf('/**\n * Where to go after signing in'));
    assert.equal(landing(plain.read('src/auth/magic-link.ts')), landing(magic.read('src/auth/magic-link.ts')));

    // Only magic-link sends links.
    assert.match(magic.read('src/pages/SignInPage.tsx'), /<MagicLinkForm request=\{magicLink\} \/>/);
    assert.match(magic.read('src/ui/AuthCard.tsx'), /children\?: ReactNode/);
    assert.match(magic.read('src/ui/AuthCard.tsx'), /\{children\}/);
    assert.match(magic.read('src/auth/magic-link.ts'), /auth\.sendMagicLink\(\{ email: address \}\)/);
    for (const path of ['src/pages/SignInPage.tsx', 'src/ui/AuthCard.tsx']) {
      assert.doesNotMatch(plain.read(path), /MagicLink|children/, `${ui} ${path}`);
    }
    for (const path of ['src/auth/magic-link.ts', 'src/ui/MagicLink.tsx', 'types/magic-link.ts']) {
      assert.doesNotMatch(plain.read(path), /sendMagicLink|MagicLinkForm|MagicLinkRequest|FormEvent/, `${ui} ${path}`);
    }
    assert.match(plain.read('README.md'), /## Sign-in and invitation links/);
    assert.match(plain.read('README.md'), /sw\.auth\.invite/);
  }
});

test('every auth starter verifies email through the packaged route, with no token in page code', () => {
  for (const ui of ['styled', 'headless']) {
    const starter = generate('auth', ui);
    const hook = starter.read('src/auth/useEmailVerification.ts');
    assert.match(hook, /auth\.emailVerified\(\)/);
    assert.match(hook, /auth\.requestEmailVerification\(\)/);
    assert.match(hook, /auth\.verifyEmail\(\{ code: code\.trim\(\) \}\)/);
    assert.match(starter.read('src/pages/SignedInLayout.tsx'), /<VerifyEmailPanel verification=\{verification\} \/>/);
    assert.match(starter.read('types/auth.ts'), /export interface EmailVerification/);
    assert.ok(!starter.result.created.some((path) => path.startsWith('api/') && path !== 'api/auth/[...path].ts'),
      'the packaged route serves verification; no extra function');
    assert.doesNotMatch(hook + starter.read('src/ui/VerifyEmail.tsx'), /fetch\(|Authorization|Bearer|access_token|refresh_token|__Host-|localStorage/);
  }
  assert.throws(() => resolveInitSelection('verify-email'), /Unknown --features verify-email/, 'verification is not a separate module');
});

test('the magic-link landing follows only a same-origin redirect_uri', async () => {
  const { read } = generate('magic-link', 'styled');
  const ts = createRequire(import.meta.url)('typescript');
  const source = read('src/auth/magic-link.ts');
  const fn = source.slice(source.indexOf('export function landingTarget'), source.indexOf('export function useMagicLinkLanding'));
  const js = ts.transpileModule(fn, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { landingTarget } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const origin = 'https://crew.somewhere.site';
  const target = (redirect) => landingTarget(redirect === undefined ? '?token=t' : `?token=t&redirect_uri=${encodeURIComponent(redirect)}`, origin);
  assert.equal(target(undefined), '/');
  assert.equal(target('https://crew.somewhere.site/join?invite_id=inv_1'), '/join?invite_id=inv_1', 'an invitation lands on its page with its id');
  assert.equal(target('/teams/7#tasks'), '/teams/7#tasks');
  for (const hostile of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'https://crew.somewhere.site.evil.example/', 'http://crew.somewhere.site/']) {
    assert.equal(target(hostile), '/', hostile);
  }
});

test('private-data schema compiles through the platform parser to an owner() table', () => {
  const { read } = generate('private-data', 'styled');
  const schema = read('db/schema.ts');
  const client = declaredData.generateFromFiles({ 'db/schema.ts': schema });
  assert.ok(client, 'the schema declares client permissions');
  assert.match(client.declaration, /declare module "somewhere:data"/);
  assert.match(client.declaration, /"notes": \{ list\(/);
  // Browser writes are limited to title/body; the platform owns the owner column.
  assert.match(client.declaration, /create\(values: \{ "body"\?: string; "title": string \}\)/);
  // An id() key is an integer, so the candidate generator types it as number (not number | string).
  assert.match(client.declaration, /update\(id: number, values: \{ "body"\?: string; "title"\?: string \}\)/);
  assert.match(schema, /scope: owner\(\)/);
  assert.match(schema, /identity: 'authenticated'/);
  assert.doesNotMatch(schema, /publicRead: true|shared\(\)|serverOnly\(\)/);
});

test('notes service validates, reports zero-change updates and maps a vanished row', async () => {
  const { dir } = generate('private-data', 'headless');
  const ts = (await import('typescript')).default;
  const calls = [];
  const rows = new Map([[1, { id: 1, title: 'Supplies', body: 'Rope' }]]);
  class DataError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
  }
  globalThis.__notesFixture = {
    DataError,
    data: {
      notes: {
        async list(options) { calls.push(['list', options]); return { data: [...rows.values()], next: null, has_more: false }; },
        async create(values) { calls.push(['create', values]); return { data: { id: 2, ...values }, count: 1, changes: 1 }; },
        async update(id, values) {
          calls.push(['update', id, values]);
          if (!rows.has(id)) throw new DataError(404, 'DATA_NOT_FOUND');
          const next = { ...rows.get(id), ...values };
          const changes = JSON.stringify(next) === JSON.stringify(rows.get(id)) ? 0 : 1;
          rows.set(id, next);
          return { data: next, count: 1, changes };
        },
        async delete(id) {
          calls.push(['delete', id]);
          if (!rows.delete(id)) throw new DataError(404, 'DATA_NOT_FOUND');
          return { data: null, count: 1, changes: 1 };
        },
      },
    },
  };
  const emitted = ts.transpileModule(readFileSync(join(dir, 'src/services/notes.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(
    "import { data, DataError } from 'somewhere:data';",
    'const { data, DataError } = globalThis.__notesFixture;',
  );
  const modulePath = join(dir, 'notes-fixture.mjs');
  writeFileSync(modulePath, emitted);
  const notes = await import(`${modulePath}?t=${Date.now()}`);

  assert.deepEqual(notes.validateDraft({ title: '  ', body: '' }), { title: 'Add a title.' });
  assert.deepEqual(notes.validateDraft({ title: 'x'.repeat(121), body: 'y'.repeat(4001) }), {
    title: 'Keep the title to 120 characters.',
    body: 'Keep the note to 4000 characters.',
  });
  assert.deepEqual(notes.validateDraft({ title: ' ok ', body: '' }), {});

  assert.deepEqual(await notes.listNotes(), { notes: [{ id: 1, title: 'Supplies', body: 'Rope' }], truncated: false });
  assert.deepEqual(calls.at(-1), ['list', { limit: 100 }], 'no user filter is sent');

  const note = { id: 1, title: 'Supplies', body: 'Rope' };
  const before = calls.length;
  assert.deepEqual(await notes.updateNote(note, { title: ' Supplies ', body: 'Rope ' }), { kind: 'unchanged' });
  assert.equal(calls.length, before, 'an identical draft sends no write');
  assert.deepEqual(await notes.updateNote(note, { title: 'Supplies', body: 'Rope, lanterns' }), {
    kind: 'saved',
    note: { id: 1, title: 'Supplies', body: 'Rope, lanterns' },
  });
  // The server reporting zero changes is not shown as "Saved".
  assert.deepEqual(await notes.updateNote({ ...note, body: 'stale' }, { title: 'Supplies', body: 'Rope, lanterns' }), { kind: 'unchanged' });
  assert.deepEqual(await notes.updateNote({ id: 9, title: 'a', body: '' }, { title: 'b', body: '' }), { kind: 'missing' });
  assert.deepEqual(await notes.removeNote(1), { kind: 'removed' });
  assert.deepEqual(await notes.removeNote(1), { kind: 'missing' });
  assert.deepEqual(calls.find((c) => c[0] === 'create'), undefined);
  assert.equal(await notes.createNote({ title: ' New ', body: ' b ' }).then((n) => n.title), 'New');

  assert.equal(notes.notesErrorMessage(new DataError(401, 'AUTH_REQUIRED')), 'Your session ended. Sign in again.');
  assert.equal(notes.notesErrorMessage(new DataError(409, 'DATA_CONTRACT_MISMATCH')), 'This app was just updated. Reload the page to continue.');
  assert.equal(notes.isSessionEnded(new DataError(401, 'AUTH_REQUIRED')), true);
  assert.equal(notes.notesErrorMessage(new TypeError('fetch failed')), 'Could not reach the server. Check your connection and try again.');
  delete globalThis.__notesFixture;
});

// runTypecheck installs the declared @types packages with npm, which installs
// the starter's pinned dependencies too, so this checks against the real,
// published SDK the starter pins. SOMEWHERE_TEST_SDK_TARBALL points it at a
// local `npm pack` instead (an SDK change that is not published yet).
const sdkTarball = process.env.SOMEWHERE_TEST_SDK_TARBALL;
test('every combination typechecks against the SDK and the generated somewhere:data declaration', async () => {
  for (const [features, ui] of COMBINATIONS) {
    const { dir } = generate(features, ui);
    if (sdkTarball) {
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg.dependencies['@somewhere-tech/sdk'] = `file:${sdkTarball}`;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }
    const result = await runTypecheck(dir);
    assert.equal(result.ok, true, `${features}/${ui}\n${result.raw}`);
    // Runtime types are always generated; somewhere:data only with a schema.
    assert.equal(/declare module "somewhere:data"/.test(readFileSync(join(dir, 'src/__somewhere_data.d.ts'), 'utf8')), features.includes('private-data'));

    if (features === 'agent') {
      // Control: the declared tables type the handlers (an undeclared table fails).
      const handler = join(dir, 'api/proposals.ts');
      writeFileSync(handler, readFileSync(handler, 'utf8').replace("await sw.db.insert('tasks',", "await sw.db.insert('task',"));
      const broken = await runTypecheck(dir);
      assert.equal(broken.ok, false, 'undeclared table must fail');
      assert.deepEqual([...new Set(broken.errors.map((e) => e.file))], ['api/proposals.ts']);
    }

    if (features.includes('private-data')) {
      // Control: the generated declaration is what types the service.
      const service = join(dir, 'src/services/notes.ts');
      writeFileSync(service, readFileSync(service, 'utf8').replace('truncated: page.has_more', 'truncated: page.next'));
      const broken = await runTypecheck(dir);
      assert.equal(broken.ok, false);
      assert.deepEqual(broken.errors.map((e) => `${e.file}:${e.code}`), ['src/services/notes.ts:TS2322']);
    }
  }
});

// ------------------------------------------------------------------- command

let requests = [];
let bodies = [];
const api = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => { if (body) bodies.push(JSON.parse(body)); });
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'FIXTURE', message: 'fixture refuses' }));
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;
test.after(() => api.close());

function cli(args, cwd, { signedIn = true } = {}) {
  const configDir = tempDir('somewhere-init-features-config-');
  if (signedIn) writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_fixture_not_real' }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBin, 'init', ...args], {
      cwd,
      env: { ...process.env, SOMEWHERE_CONFIG_DIR: configDir, SOMEWHERE_API_URL: apiUrl, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('--catalog --json needs no login, makes no request and writes nothing', async () => {
  requests = [];
  const dir = tempDir();
  const run = await cli(['--catalog', '--json'], dir, { signedIn: false });
  assert.equal(run.status, 0, run.stderr);
  const catalog = JSON.parse(run.stdout);
  assert.deepEqual(catalog.modules.map((m) => m.id), ['auth', 'magic-link', 'private-data', 'agent']);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(requests, []);
});

test('--dry-run resolves requirements and prints the plan without login, requests or writes', async () => {
  requests = [];
  const dir = tempDir();
  const run = await cli(['--features', 'private-data', '--ui', 'headless', '--dry-run', '--json'], dir, { signedIn: false });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.dry_run, true);
  assert.deepEqual(plan.selection, { requested: ['private-data'], added: ['auth'], modules: ['auth', 'private-data'], ui: 'headless' });
  assert.ok(plan.files.includes('db/schema.ts'));
  assert.ok(plan.files.includes('src/ui/AuthCard.tsx'));
  assert.ok(!plan.files.some((path) => path.startsWith('src/styles/')));
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(requests, []);
});

test('invalid and conflicting selections exit 2 before any request, even when signed in', async () => {
  const cases = [
    [['--name', 'x', '--features', 'auth,payments'], /Unknown --features payments/],
    [['--name', 'x', '--features', 'auth', '--ui', 'fancy'], /Unknown --ui fancy/],
    [['--name', 'x', '--ui', 'headless'], /--ui requires --features/],
    [['--name', 'x', '--dry-run'], /--dry-run requires --features/],
    [['--name', 'x', '--features', 'auth', '--template', 'minimal'], /cannot be combined with --template/],
    [['--name', 'x', '--features', 'auth', '--template', 'auth'], /cannot be combined with --template/],
    [['--name', 'x', '--features', 'auth', '--bare'], /cannot be combined with --bare/],
    [['--features', 'auth', '--link', '--project', 'x'], /cannot be combined with --link, --project/],
    [['--catalog', '--features', 'auth'], /--catalog only prints the catalog; drop --features/],
    [['--catalog', '--subdomain', 'crew-app'], /--catalog only prints the catalog; drop --subdomain/],
  ];
  for (const [args, message] of cases) {
    requests = [];
    const dir = tempDir();
    const run = await cli([...args, '--json'], dir);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr + run.stdout, message, args.join(' '));
    assert.deepEqual(readdirSync(dir), [], args.join(' '));
    assert.deepEqual(requests, [], args.join(' '));
  }
});

test('an occupied directory is refused before the project is created and left untouched', async () => {
  requests = [];
  const dir = tempDir();
  writeFileSync(join(dir, 'notes.md'), 'mine\n');
  const run = await cli(['--name', 'fixture-app', '--features', 'auth', '--json'], dir);
  assert.equal(run.status, 2);
  assert.match(run.stderr + run.stdout, /already has files[\s\S]*nothing was created/);
  assert.deepEqual(readdirSync(dir), ['notes.md']);
  assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), 'mine\n');
  assert.deepEqual(requests, []);

  // Control: a valid selection in an empty directory does reach project creation.
  const empty = tempDir();
  const valid = await cli(['--name', 'fixture-app', '--features', 'auth', '--json'], empty);
  assert.equal(valid.status, 1);
  assert.deepEqual(requests, ['POST /projects']);
  assert.deepEqual(readdirSync(empty), [], 'a failed create writes no starter');
});

test('--name is the display name and --subdomain the address of the new project', async () => {
  requests = [];
  bodies = [];
  const run = await cli(['--name', 'Crew', '--subdomain', 'Crew-App', '--features', 'magic-link', '--json'], tempDir());
  assert.equal(run.status, 1, 'the fixture API refuses the create');
  assert.deepEqual(requests, ['POST /projects']);
  assert.deepEqual(bodies, [{ name: 'Crew', subdomain: 'crew-app' }]);

  requests = [];
  bodies = [];
  await cli(['--name', 'crew-race', '--features', 'auth', '--json'], tempDir());
  assert.deepEqual(bodies, [{ name: 'crew-race', subdomain: 'crew-race' }], 'without --subdomain it is derived from --name as before');

  requests = [];
  const linked = await cli(['--link', '--project', 'x', '--subdomain', 'y', '--json'], tempDir());
  assert.equal(linked.status, 1);
  assert.match(linked.stderr + linked.stdout, /--subdomain names a new project/);
  assert.deepEqual(requests, []);
});
