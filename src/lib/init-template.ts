import type { InitScaffoldFile } from './init-scaffold.js';

const PACKAGE_JSON = `{
  "name": "somewhere-happy-path",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@somewhere-tech/sdk": "^0.7.2",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router-dom": "^7.9.5"
  },
  "devDependencies": {
    "@types/react": "^19.2.2",
    "@types/react-dom": "^19.2.2",
    "@vitejs/plugin-react": "^5.1.0",
    "typescript": "^5.9.3",
    "vite": "^7.2.2"
  }
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "api", "vite.config.ts"]
}
`;

const RUNTIME_TYPES = `export interface AppUser {
  id: string;
  email?: string | null;
  display_name?: string | null;
}

export interface Runtime {
  auth: {
    fromRequest(req: Request): Promise<AppUser | null>;
  };
  db: {
    query<T>(
      sql: string,
      params?: unknown[],
      options?: { user?: AppUser },
    ): Promise<{ data: T[]; count: number; changes: number }>;
  };
  fs: {
    uploadFromRequest(
      req: Request,
      options: {
        path: string;
        maxBytes?: number;
        allowedTypes?: string[];
        fieldName?: string;
        public?: boolean;
      },
    ): Promise<{
      url: string;
      path: string;
      size: number;
      contentType: string;
      visibility: 'private' | 'public';
    }>;
    setOwner(path: string, user: AppUser): Promise<unknown>;
  };
}
`;

const AUTH_FUNCTION = `import {
  somewhereAuth,
  type SwAuthNamespace,
} from '@somewhere-tech/sdk/server';

export default function auth(req: Request, sw: SwAuthNamespace): Promise<Response> {
  return somewhereAuth(req, sw);
}
`;

const DATA_FUNCTION = `import type { Runtime } from './_lib/runtime';

interface GreetingRow {
  user_id: string;
  message: string;
}

// Source of truth: worker/src/runtime/auth.ts:728 (fromRequest) and
// worker/src/runtime/db.ts:1653 (query). Browser code never receives SQL or a
// database connection; it calls this same-origin function.
export default async function data(req: Request, sw: Runtime): Promise<Response> {
  const user = await sw.auth.fromRequest(req);
  if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const result = await sw.db.query<GreetingRow>(
    'SELECT ? AS user_id, ? AS message',
    [user.id, 'Your database call ran server-side.'],
  );
  return Response.json({ greeting: result.data[0] ?? null });
}
`;

const UPLOAD_FUNCTION = `import type { Runtime } from './_lib/runtime';

// Source of truth: worker/src/runtime/auth.ts:728 (fromRequest) and
// worker/src/runtime/fs.ts:207 (uploadFromRequest). Files are private by
// default; the returned URL is short-lived, and ownership is assigned here.
export default async function upload(req: Request, sw: Runtime): Promise<Response> {
  const user = await sw.auth.fromRequest(req);
  if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  if (req.method !== 'POST') {
    return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }

  const uploaded = await sw.fs.uploadFromRequest(req, {
    path: \`/uploads/\${user.id}/\${crypto.randomUUID()}\`,
    fieldName: 'file',
    maxBytes: 10 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/png', 'application/pdf', 'text/plain'],
  });
  await sw.fs.setOwner(uploaded.path, user);
  return Response.json({ file: uploaded });
}
`;

const APP_TYPES = `export interface ServerGreeting {
  user_id: string;
  message: string;
}

export interface UploadResult {
  url: string;
  path: string;
  size: number;
  contentType: string;
  visibility: 'private' | 'public';
}
`;

const AUTH_SERVICE = `import {
  createSomewhereAuth,
  type SomewhereAuth,
} from '@somewhere-tech/sdk/auth';
import type { ServerGreeting, UploadResult } from '../types/app';

export const authClient = createSomewhereAuth();

export function signIn(
  auth: SomewhereAuth,
  email: string,
  password: string,
) {
  return auth.signIn({ email, password });
}

export function signUp(
  auth: SomewhereAuth,
  email: string,
  password: string,
) {
  return auth.signUp({ email, password });
}

export function signOut(auth: SomewhereAuth) {
  return auth.signOut();
}

export async function startGoogleSignIn(auth: SomewhereAuth): Promise<void> {
  window.location.assign(await auth.googleSignInUrl({
    redirectUri: window.location.origin + '/auth/callback',
  }));
}

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const value = await response.json().catch(() => ({})) as { message?: string };
  throw new Error(value.message ?? \`Request failed (\${response.status})\`);
}

export async function loadServerGreeting(
  auth: SomewhereAuth,
): Promise<ServerGreeting> {
  const response = await requireOk(await auth.fetch('/api/data'));
  const value = await response.json() as { greeting: ServerGreeting };
  return value.greeting;
}

export async function uploadFile(
  auth: SomewhereAuth,
  file: File,
): Promise<UploadResult> {
  const form = new FormData();
  form.set('file', file);
  const response = await requireOk(await auth.fetch('/api/upload', {
    method: 'POST',
    body: form,
  }));
  const value = await response.json() as { file: UploadResult };
  return value.file;
}
`;

const HOME_PAGE = `import {
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  SignedIn,
  SignedOut,
  useAuth,
  useUser,
} from '@somewhere-tech/sdk/react';
import {
  loadServerGreeting,
  signIn,
  signOut,
  signUp,
  startGoogleSignIn,
  uploadFile,
} from '../services/app';

export function HomePage() {
  return (
    <main>
      <header>
        <p className="eyebrow">somewhere.tech happy path</p>
        <h1>One secure app, already wired.</h1>
        <p>SDK auth, server-side data, private file uploads, and raw-source deploy.</p>
      </header>
      <SignedOut><AuthForm /></SignedOut>
      <SignedIn><Workspace /></SignedIn>
    </main>
  );
}

function AuthForm() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  async function submit(create: boolean) {
    setMessage('');
    try {
      await (create ? signUp(auth, email, password) : signIn(auth, email, password));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="panel">
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void submit(false);
      }}>
        <label>Email<input type="email" value={email} onChange={(event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)} minLength={8} required /></label>
        <div className="actions">
          <button type="submit">Sign in</button>
          <button type="button" className="secondary" onClick={() => void submit(true)}>Create account</button>
        </div>
      </form>
      <button className="google" onClick={() => void startGoogleSignIn(auth)}>Continue with Google</button>
      {message && <p className="message">{message}</p>}
    </section>
  );
}

function Workspace() {
  const auth = useAuth();
  const user = useUser();
  const [message, setMessage] = useState('Ready.');

  return (
    <section className="panel">
      <p>Signed in as <strong>{user?.email ?? user?.id}</strong></p>
      <div className="actions">
        <button onClick={() => void loadServerGreeting(auth).then((value) => setMessage(value.message)).catch((error: unknown) => setMessage(String(error)))}>
          Run server data example
        </button>
        <label className="upload">
          Upload a private file
          <input type="file" onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (file) void uploadFile(auth, file).then((value) => setMessage(\`Uploaded \${value.path}\`)).catch((error: unknown) => setMessage(String(error)));
          }} />
        </label>
        <button className="secondary" onClick={() => void signOut(auth)}>Sign out</button>
      </div>
      <p className="message">{message}</p>
    </section>
  );
}
`;

const APP = `import { AuthCallback } from '@somewhere-tech/sdk/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback provider="google" />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </BrowserRouter>
  );
}
`;

const MAIN = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SomewhereAuthProvider } from '@somewhere-tech/sdk/react';
import { App } from './App';
import { authClient } from './services/app';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SomewhereAuthProvider client={authClient}>
      <App />
    </SomewhereAuthProvider>
  </StrictMode>,
);
`;

const STYLES = `:root {
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #15201c;
  background: #edf4ef;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
button, input { font: inherit; }
main { width: min(760px, calc(100% - 32px)); margin: 12vh auto; }
header { margin-bottom: 32px; }
h1 { max-width: 620px; margin: 8px 0; font-size: clamp(2.5rem, 8vw, 5rem); line-height: .95; letter-spacing: -.06em; }
.eyebrow { color: #14734c; font-weight: 750; text-transform: uppercase; letter-spacing: .12em; }
.panel { padding: 28px; border: 1px solid #c6d8ce; border-radius: 22px; background: rgba(255,255,255,.82); box-shadow: 0 20px 60px rgba(21,32,28,.08); }
form, label { display: grid; gap: 8px; }
form { gap: 18px; }
input { width: 100%; padding: 12px 14px; border: 1px solid #b8c9c0; border-radius: 10px; background: white; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
button, .upload { padding: 12px 16px; border: 0; border-radius: 999px; background: #14734c; color: white; cursor: pointer; font-weight: 700; }
.secondary { background: #dce9e1; color: #18382b; }
.google { width: 100%; margin-top: 12px; background: #17231e; }
.upload input { display: none; }
.message { margin-top: 20px; color: #385548; }
`;

const AGENT_GUIDE = `# somewhere.tech project contract

This starter is intentionally the one happy path:

- Auth is handled by \`@somewhere-tech/sdk\` — use its client and hooks.
- Browser data and file calls go to \`api/*\`. Only those server functions call
  \`sw.db\` and \`sw.fs\`; do not move SQL or platform calls into \`src/\`.
- Deploy raw source from this directory with \`somewhere deploy\`. Do not run a
  build first and never deploy \`dist/\` or \`build/\`; the platform compiles
  TypeScript, TSX, CSS, and imports.

Safe loop:

\`\`\`sh
npm install
npm run typecheck
somewhere deploy-check
somewhere deploy
\`\`\`

Runtime citations for the server data and files examples:

- \`worker/src/runtime/db.ts:1653\` query
- \`worker/src/runtime/fs.ts:207\` uploadFromRequest
`;

const README = `# somewhere.tech starter

One narrow production architecture is already wired:

- Auth is handled by \`@somewhere-tech/sdk\` — use its client and hooks.
- authenticated data through a server function using \`sw.db\`;
- private file upload through a server function using \`sw.fs\`;

Run:

\`\`\`sh
npm install
npm run dev
npm run typecheck
somewhere deploy-check
somewhere deploy
\`\`\`

Deploy the raw source. There is intentionally no build script.
`;

export function createHappyPathTemplate(): InitScaffoldFile[] {
  return [
    { path: '.gitignore', content: 'node_modules\\ndist\\nbuild\\n.env\\n' },
    { path: 'AGENTS.md', content: AGENT_GUIDE },
    { path: 'CLAUDE.md', content: AGENT_GUIDE },
    { path: 'README.md', content: README },
    { path: 'package.json', content: PACKAGE_JSON },
    { path: 'tsconfig.json', content: TSCONFIG },
    {
      path: 'vite.config.ts',
      content: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`,
    },
    {
      path: 'index.html',
      content: `<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>somewhere.tech starter</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n`,
    },
    { path: 'api/_lib/runtime.ts', content: RUNTIME_TYPES },
    { path: 'api/auth/[...path].ts', content: AUTH_FUNCTION },
    { path: 'api/data.ts', content: DATA_FUNCTION },
    { path: 'api/upload.ts', content: UPLOAD_FUNCTION },
    { path: 'src/types/app.ts', content: APP_TYPES },
    { path: 'src/services/app.ts', content: AUTH_SERVICE },
    { path: 'src/pages/HomePage.tsx', content: HOME_PAGE },
    { path: 'src/App.tsx', content: APP },
    { path: 'src/main.tsx', content: MAIN },
    { path: 'src/styles.css', content: STYLES },
  ];
}
