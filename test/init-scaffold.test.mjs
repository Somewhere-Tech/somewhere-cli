import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const moduleRoot = process.env.SOMEWHERE_TEST_SOURCE ? '../src' : '../dist';
const { canWriteInitScaffold, writeInitScaffold } =
  await import(`${moduleRoot}/lib/init-scaffold.${process.env.SOMEWHERE_TEST_SOURCE ? 'ts' : 'js'}`);
const { installInitDependencies } =
  await import(`${moduleRoot}/lib/init-install.${process.env.SOMEWHERE_TEST_SOURCE ? 'ts' : 'js'}`);
const { createGreenTemplate } =
  await import(`${moduleRoot}/lib/init-green-template.${process.env.SOMEWHERE_TEST_SOURCE ? 'ts' : 'js'}`);
const { createHappyPathTemplate } =
  await import(`${moduleRoot}/lib/init-template.${process.env.SOMEWHERE_TEST_SOURCE ? 'ts' : 'js'}`);
const { collectFiles } =
  await import(`${moduleRoot}/lib/files.${process.env.SOMEWHERE_TEST_SOURCE ? 'ts' : 'js'}`);
const { buildCheckBody } =
  await import(`${moduleRoot}/commands/check.${process.env.SOMEWHERE_TEST_SOURCE ? 'ts' : 'js'}`);
const { runTypecheck } =
  await import(`${moduleRoot}/lib/typecheck.${process.env.SOMEWHERE_TEST_SOURCE ? 'ts' : 'js'}`);

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'somewhere-init-scaffold-'));
}

function generate() {
  const dir = tempDir();
  const result = writeInitScaffold(dir, createHappyPathTemplate());
  return { dir, result };
}

function generateGreen() {
  const dir = tempDir();
  const result = writeInitScaffold(dir, createGreenTemplate());
  return { dir, result };
}

test('rule 9: init scaffolds only an empty or init-metadata-only directory', () => {
  const empty = tempDir();
  assert.equal(canWriteInitScaffold(empty), true);

  mkdirSync(join(empty, '.git'));
  writeFileSync(join(empty, '.somewhere.json'), '{}\n');
  writeFileSync(join(empty, '.mcp.json'), '{}\n');
  assert.equal(canWriteInitScaffold(empty), true);

  writeFileSync(join(empty, 'existing-app.ts'), 'export {};\n');
  assert.equal(canWriteInitScaffold(empty), false);
});

test('writer preflights every target and never partially overwrites a project', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'keep.txt'), 'mine\n');

  assert.throws(
    () => writeInitScaffold(dir, [
      { path: 'new.txt', content: 'new\n' },
      { path: 'keep.txt', content: 'replacement\n' },
    ]),
    /Refusing to overwrite existing file: keep\.txt/,
  );
  assert.throws(
    () => writeInitScaffold(dir, [{ path: '../escape.txt', content: 'no\n' }]),
    /escapes the project directory/,
  );
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'mine\n');
  assert.throws(() => readFileSync(join(dir, 'new.txt')), /ENOENT/);
});

test('default green starter is a small typed frontend, function, and schema', () => {
  const { dir, result } = generateGreen();
  assert.deepEqual(result.created.sort(), [
    '.gitignore',
    'README.md',
    'api/greeting.ts',
    'db/schema.ts',
    'index.html',
    'package.json',
    'src/App.tsx',
    'src/main.tsx',
    'src/services/greeting.ts',
    'src/styles.css',
    'tsconfig.json',
    'types/app.ts',
    'types/runtime.ts',
    'types/somewhere-db.d.ts',
  ]);

  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {
    react: '19.2.7',
    'react-dom': '19.2.7',
  });
  assert.deepEqual(pkg.devDependencies, {
    '@types/react': '19.2.2',
    '@types/react-dom': '19.2.2',
    typescript: '5.9.3',
    vite: '7.2.2',
  });
  assert.equal(
    readFileSync(join(dir, '.gitignore'), 'utf8'),
    'node_modules\ndist\nbuild\n.env\n',
  );
  for (const version of [
    ...Object.values(pkg.dependencies),
    ...Object.values(pkg.devDependencies),
  ]) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `dependency is not pinned: ${version}`);
  }

  assert.match(readFileSync(join(dir, 'api/greeting.ts'), 'utf8'), /sw\.db\.query<GreetingRow>/);
  assert.match(readFileSync(join(dir, 'db/schema.ts'), 'utf8'), /export default schema\(/);
  assert.match(readFileSync(join(dir, 'db/schema.ts'), 'utf8'), /scope: shared\(\)/);
  assert.doesNotMatch(
    Object.values(collectFiles(dir).files).join('\n'),
    /\bany\b/,
  );
});

test('default green starter typechecks before an agent edits it', async () => {
  const { dir } = generateGreen();
  const typesDir = join(dir, 'node_modules/@types/scaffold-contract');
  mkdirSync(typesDir, { recursive: true });
  writeFileSync(join(typesDir, 'index.d.ts'), `declare module 'react' {
  export interface ReactNode {}
  export const StrictMode: (props: { children?: ReactNode }) => JSX.Element;
  export function useEffect(effect: () => void, dependencies: unknown[]): void;
  export function useState<T>(initial: T): [T, (next: T) => void];
}
declare module 'react/jsx-runtime' {
  namespace JSX {
    interface Element {}
    interface IntrinsicElements { [name: string]: Record<string, unknown> }
  }
  export function jsx(type: unknown, props: unknown): JSX.Element;
  export function jsxs(type: unknown, props: unknown): JSX.Element;
  export const Fragment: unknown;
}
declare module 'react-dom/client' {
  export function createRoot(node: Element): { render(value: unknown): void };
}
`);

  const result = await runTypecheck(dir);
  assert.equal(result.ok, true, result.raw);
  assert.deepEqual(result.errors, []);
});

test('init dependency installation is required for a green completion', async () => {
  const calls = [];
  await installInitDependencies(
    { cwd: '/fixture/app', quiet: true },
    async (options) => {
      calls.push(options);
      return 0;
    },
  );
  assert.deepEqual(calls, [{ cwd: '/fixture/app', quiet: true }]);

  await assert.rejects(
    () => installInitDependencies(
      { cwd: '/fixture/app', quiet: false },
      async () => 9,
    ),
    /somewhere npm install/,
  );
});

test('one generated template consumes the SDK auth adapter and server data/files contract', () => {
  const { dir, result } = generate();
  assert.equal(result.created.length, 18);
  assert.equal(
    readFileSync(join(dir, '.gitignore'), 'utf8'),
    'node_modules\ndist\nbuild\n.env\n',
  );

  const auth = readFileSync(join(dir, 'api/auth/[...path].ts'), 'utf8');
  assert.match(auth, /from '@somewhere-tech\/sdk\/server'/);
  assert.match(auth, /return somewhereAuth\(req, sw\)/);
  assert.doesNotMatch(
    auth,
    /loginWithCookie|signupWithCookie|googleCallbackWithCookie|logoutWithCookie|fromRequest|cookie_session|subpath/,
  );

  const data = readFileSync(join(dir, 'api/data.ts'), 'utf8');
  assert.match(data, /sw\.db\.query/);
  assert.match(data, /sw\.auth\.fromRequest/);

  const upload = readFileSync(join(dir, 'api/upload.ts'), 'utf8');
  assert.match(upload, /sw\.fs\.uploadFromRequest/);
  assert.match(upload, /sw\.fs\.setOwner/);
  assert.match(upload, /allowedTypes: \['image\/jpeg', 'image\/png', 'application\/pdf', 'text\/plain'\]/);
  assert.doesNotMatch(upload, /image\/\*/);

  const service = readFileSync(join(dir, 'src/services/app.ts'), 'utf8');
  assert.match(service, /@somewhere-tech\/sdk\/auth/);
  assert.match(service, /createSomewhereAuth\(\)/);
  assert.doesNotMatch(service, /authPath|mode:\s*['"]cookie['"]/);
  assert.doesNotMatch(service, /Authorization|Bearer|accessToken|refreshToken|smt_/);
  assert.doesNotMatch(
    Object.values(collectFiles(dir).files).join('\n'),
    /@somewhere-tech\/auth(?:['"/])/,
  );

  const wholeTemplate = createHappyPathTemplate()
    .map((file) => `${file.path}\n${file.content}`)
    .join('\n');
  const authMechanicsTerms =
    /session|cookie|token|refresh|credential|http.?only|bearer|authorization|logout|jwt|loginWithCookie|signupWithCookie|googleCallbackWithCookie|developer key|smt_/i;
  assert.doesNotMatch(wholeTemplate, authMechanicsTerms);
  assert.match('Session rotation remains SDK-owned.', authMechanicsTerms);
  assert.match('JWT rotation remains SDK-owned.', authMechanicsTerms);

  const packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies['@somewhere-tech/sdk'], '^0.7.2');
  assert.equal(packageJson.scripts.build, undefined);

  const approvedAuthGuidance =
    'Auth is handled by `@somewhere-tech/sdk` — use its client and hooks.';
  const extractAuthSection = (doc, docName) => {
    const heading = '## Auth\n\n';
    const sectionStart = doc.indexOf(heading);
    assert.notEqual(sectionStart, -1, `${docName} has an Auth section`);
    const contentStart = sectionStart + heading.length;
    const nextHeading = doc.indexOf('\n\n## ', contentStart);
    return doc.slice(
      contentStart,
      nextHeading === -1 ? doc.length : nextHeading,
    ).trim();
  };
  for (const docName of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
    const doc = readFileSync(join(dir, docName), 'utf8');
    assert.equal(extractAuthSection(doc, docName), approvedAuthGuidance, docName);
    const reviewerMutation = doc.replace(
      approvedAuthGuidance,
      `${approvedAuthGuidance}\nCSRF handling stays inside the SDK.`,
    );
    assert.throws(() => {
      assert.equal(
        extractAuthSection(reviewerMutation, `${docName} reviewer mutation`),
        approvedAuthGuidance,
      );
    });
  }

  for (const guideName of ['AGENTS.md', 'CLAUDE.md']) {
    const guide = readFileSync(join(dir, guideName), 'utf8');
    assert.match(guide, /somewhere deploy-check/);
    assert.match(guide, /somewhere deploy/);
    assert.match(guide, /Do not run a\s+build first/);
    assert.doesNotMatch(guide, /worker\/src\/runtime\/auth\.ts/);
  }
});

test('generated starter typechecks against the consolidated SDK contract fixture', async () => {
  const { dir } = generate();
  const typesDir = join(dir, 'node_modules/@types/scaffold-contract');
  mkdirSync(typesDir, { recursive: true });
  writeFileSync(join(typesDir, 'index.d.ts'), `declare module 'react' {
  export interface ReactNode {}
  export interface FormEvent<T> { preventDefault(): void; currentTarget: T }
  export interface ChangeEvent<T> { target: T }
  export const StrictMode: (props: { children?: ReactNode }) => JSX.Element;
  export function useState<T>(initial: T): [T, (next: T) => void];
}
declare module 'react/jsx-runtime' {
  namespace JSX {
    interface Element {}
    interface IntrinsicElements { [name: string]: Record<string, unknown> }
  }
  export function jsx(type: unknown, props: unknown): JSX.Element;
  export function jsxs(type: unknown, props: unknown): JSX.Element;
  export const Fragment: unknown;
}
declare module 'react-dom/client' {
  export function createRoot(node: Element): { render(value: unknown): void };
}
declare module 'react-router-dom' {
  export const BrowserRouter: (props: { children?: unknown }) => JSX.Element;
  export const Routes: (props: { children?: unknown }) => JSX.Element;
  export const Route: (props: { path: string; element: unknown }) => JSX.Element;
}
declare module '@somewhere-tech/sdk/auth' {
  export interface User { id: string; email: string | null }
  export interface SomewhereAuth {
    signIn(input: { email: string; password: string }): Promise<User>;
    signUp(input: { email: string; password: string }): Promise<User>;
    signOut(): Promise<void>;
    googleSignInUrl(input?: { redirectUri?: string }): Promise<string>;
    fetch(input: string, init?: RequestInit): Promise<Response>;
  }
  export function createSomewhereAuth(): SomewhereAuth;
}
declare module '@somewhere-tech/sdk/server' {
  export interface SwAuthNamespace { auth: Record<string, unknown> }
  export function somewhereAuth(
    req: Request,
    sw: SwAuthNamespace,
  ): Promise<Response>;
}
declare module '@somewhere-tech/sdk/react' {
  import type { SomewhereAuth, User } from '@somewhere-tech/sdk/auth';
  export const SomewhereAuthProvider: (props: {
    client: SomewhereAuth;
    children?: unknown;
  }) => JSX.Element;
  export const SignedIn: (props: { children?: unknown }) => JSX.Element;
  export const SignedOut: (props: { children?: unknown }) => JSX.Element;
  export const AuthCallback: (props: {
    provider?: 'google' | 'github' | 'discord';
  }) => JSX.Element;
  export function useAuth(): SomewhereAuth;
  export function useUser(): User | null;
}
declare module 'vite' {
  export function defineConfig(value: unknown): unknown;
}
declare module '@vitejs/plugin-react' {
  export default function react(): unknown;
}
`);

  const result = await runTypecheck(dir);
  assert.equal(result.ok, true, result.raw);
  assert.deepEqual(result.errors, []);
});

test('generated image upload accepts image/png with the runtime exact-membership rule', async () => {
  const { dir } = generate();
  const source = readFileSync(join(dir, 'api/upload.ts'), 'utf8');
  const emitted = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const modulePath = join(dir, 'upload-fixture.mjs');
  writeFileSync(modulePath, emitted);
  const { default: upload } = await import(`${pathToFileURL(modulePath).href}?fixture=${Date.now()}`);

  const form = new FormData();
  form.set('file', new File(['png bytes'], 'avatar.png', { type: 'image/png' }));
  const request = new Request('https://starter.example/api/upload', {
    method: 'POST',
    body: form,
  });
  let ownerPath = '';
  const response = await upload(request, {
    auth: {
      fromRequest: async () => ({ id: 'usr_fixture' }),
    },
    fs: {
      uploadFromRequest: async (req, options) => {
        const body = await req.formData();
        const file = body.get(options.fieldName ?? 'file');
        assert.ok(file instanceof File);
        const allowed = options.allowedTypes.map((type) => String(type).toLowerCase());
        if (!allowed.includes(file.type.toLowerCase())) {
          throw new Error(`UPLOAD_TYPE_NOT_ALLOWED: ${file.type}`);
        }
        return {
          url: '/signed/avatar.png',
          path: '/uploads/usr_fixture/avatar.png',
          size: file.size,
          contentType: file.type,
          visibility: 'private',
        };
      },
      setOwner: async (path) => {
        ownerPath = path;
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(ownerPath, '/uploads/usr_fixture/avatar.png');
  assert.deepEqual(await response.json(), {
    file: {
      url: '/signed/avatar.png',
      path: '/uploads/usr_fixture/avatar.png',
      size: 9,
      contentType: 'image/png',
      visibility: 'private',
    },
  });
});

test('generated starter produces a clean deploy-check request fixture', () => {
  const { dir } = generate();
  const collected = collectFiles(dir);
  const body = buildCheckBody(collected, 'fixture-project');

  assert.equal(collected.skipped.length, 0);
  assert.deepEqual(Object.keys(collected.functions).sort(), [
    'api/_lib/runtime.ts',
    'api/auth/[...path].ts',
    'api/data.ts',
    'api/upload.ts',
  ]);
  assert.ok(collected.files['index.html']);
  assert.ok(collected.files['src/main.tsx']);
  assert.equal(Object.keys(collected.files).some((path) => path.startsWith('dist/')), false);
  assert.equal(body.project_id, 'fixture-project');
  assert.deepEqual(body.functions, collected.functions);
  assert.deepEqual(body.files, collected.files);
});
