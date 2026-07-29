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

import {
  canWriteInitScaffold,
  writeInitScaffold,
} from '../dist/lib/init-scaffold.js';
import { createHappyPathTemplate } from '../dist/lib/init-template.js';
import { collectFiles } from '../dist/lib/files.js';
import { buildCheckBody } from '../dist/commands/check.js';
import { runTypecheck } from '../dist/lib/typecheck.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'somewhere-init-scaffold-'));
}

function generate() {
  const dir = tempDir();
  const result = writeInitScaffold(dir, createHappyPathTemplate());
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

test('one generated template consumes the SDK auth adapter and server data/files contract', () => {
  const { dir, result } = generate();
  assert.equal(result.created.length, 18);

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

  const packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies['@somewhere-tech/sdk'], '^0.7.2');
  assert.equal(packageJson.scripts.build, undefined);

  for (const guideName of ['AGENTS.md', 'CLAUDE.md']) {
    const guide = readFileSync(join(dir, guideName), 'utf8');
    assert.match(guide, /somewhere deploy-check/);
    assert.match(guide, /somewhere deploy/);
    assert.match(guide, /Do not run a\s+build first/);
    assert.match(guide, /worker\/src\/runtime\/auth\.ts:388/);
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
