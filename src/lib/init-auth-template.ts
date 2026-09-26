import type { InitScaffoldFile } from './init-scaffold.js';
import { INIT_AGENTS_MD, INIT_CLAUDE_MD } from './init-agent-guide.js';

// The default `somewhere init` starter: cookie sign-in through the SDK client
// and the SDK's packaged /api/auth handler, plus one protected endpoint.
// `--template minimal` keeps the no-auth starter (init-green-template.ts).

const PACKAGE_JSON = `{
  "name": "somewhere-starter",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "somewhere dev",
    "typecheck": "somewhere typecheck"
  },
  "dependencies": {
    "@somewhere-tech/sdk": "0.9.0",
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "@types/react": "19.2.2",
    "@types/react-dom": "19.2.2",
    "typescript": "5.9.3",
    "vite": "7.2.2"
  }
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "isolatedModules": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "api", "db", "types"]
}
`;

const APP_TYPES = `export interface GreetingResponse {
  message: string;
}
`;

const SCHEMA = `import { id, schema, serverOnly, table, text } from 'somewhere/db';

export default schema({
  greetings: table({
    id: id(),
    message: text({ default: 'You are signed in.' }),
  }, {
    scope: serverOnly(),
  }),
});
`;

const AUTH_API = `export { somewhereAuth as default } from '@somewhere-tech/sdk/server';
`;

const GREETING_API = `export default sw.endpoint({
  auth: 'required',
  rateLimit: '30/minute',
  handler: async ({ user }, sw) => {
    const result = await sw.db.from('greetings', { limit: 1 });
    const message = result.data[0]?.message;
    return { message: \`\${typeof message === 'string' ? message : 'You are signed in.'} (\${user.email ?? user.id})\` };
  },
});
`;

const AUTH_SERVICE = `import { createSomewhereAuth, type User } from '@somewhere-tech/sdk/auth';

// Talks to api/auth/[...path].ts. The session is an httpOnly cookie; this
// code never sees a token.
export const auth = createSomewhereAuth();
export type { User };
`;

const GREETING_SERVICE = `import type { GreetingResponse } from '../../types/app';

export async function loadGreeting(): Promise<GreetingResponse> {
  const response = await fetch('/api/greeting', { credentials: 'include' });
  const body = (await response.json().catch(() => ({}))) as Partial<GreetingResponse> & { message?: string };
  if (!response.ok) throw new Error(body.message ?? \`Request failed (\${response.status})\`);
  return { message: body.message ?? '' };
}
`;

const APP = `import { useEffect, useState, type FormEvent } from 'react';
import { auth, type User } from './services/auth';
import { loadGreeting } from './services/greeting';

export function App() {
  const [user, setUser] = useState<User | null>(auth.getCachedUser());
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // This page is the app's single entry and sign-in gate; build on it. Every
  // extensionless path serves index.html, so add pages by routing on
  // location.pathname here. getUser() reads /api/auth/me ({ user: null } when
  // signed out, never a 401), and the Loading… state keeps the page from
  // rendering blank.
  useEffect(() => {
    void auth.getUser().then(setUser).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadGreeting()
      .then((result) => setMessage(result.message))
      .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : 'Could not load the greeting.'));
  }, [user]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      const next = mode === 'signIn'
        ? await auth.signIn({ email, password })
        : await auth.signUp({ email, password });
      setUser(next);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed.');
    }
  }

  async function signOut() {
    await auth.signOut();
    setUser(null);
    setMessage('');
    setMode('signIn');
  }

  if (checking && !user) return <main><p className="hint">Loading…</p></main>;

  if (user) {
    return (
      <main>
        <p className="eyebrow">somewhere.tech starter</p>
        <h1>You are signed in.</h1>
        <p className="message">{message || 'Loading your greeting…'}</p>
        <button type="button" onClick={() => void signOut()}>Sign out</button>
      </main>
    );
  }

  return (
    <main>
      <p className="eyebrow">somewhere.tech starter</p>
      <h1>{mode === 'signIn' ? 'Sign in' : 'Create an account'}</h1>
      <form onSubmit={(event) => void submit(event)}>
        <label>Email<input type="email" name="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" name="password" autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'} required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button type="submit">{mode === 'signIn' ? 'Sign in' : 'Create account'}</button>
      </form>
      <button type="button" className="link" onClick={() => { setMode(mode === 'signIn' ? 'signUp' : 'signIn'); setError(''); }}>
        {mode === 'signIn' ? 'New here? Create an account' : 'Have an account? Sign in'}
      </button>
    </main>
  );
}
`;

const MAIN = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const STYLES = `:root {
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #17201c;
  background: #edf4ef;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
main { width: min(480px, calc(100% - 32px)); margin: 12vh auto; }
h1 { margin: 12px 0 24px; font-size: clamp(2.2rem, 7vw, 3.6rem); line-height: 1; letter-spacing: -.04em; }
.eyebrow { color: #14734c; font-weight: 750; text-transform: uppercase; letter-spacing: .12em; }
form { display: grid; gap: 14px; }
label { display: grid; gap: 6px; font-weight: 600; }
input { padding: 12px 14px; border: 1px solid #c6d8ce; border-radius: 10px; font: inherit; }
button { padding: 12px 16px; border: 0; border-radius: 10px; background: #14734c; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
button.link { margin-top: 12px; padding: 0; background: none; color: #0e6542; }
.message { padding: 20px 22px; border: 1px solid #c6d8ce; border-radius: 16px; background: rgba(255, 255, 255, .82); }
.error { margin: 0; color: #a3261b; }
.hint { color: #4f665b; }
`;

const README = `# somewhere.tech starter

This project starts signed in: a React page signs users up and in with the
SDK client (\`src/services/auth.ts\`), \`api/auth/[...path].ts\` is the SDK's
packaged auth handler, and \`api/greeting.ts\` is a protected endpoint
(\`sw.endpoint({ auth: 'required' })\`). The session is an httpOnly cookie.

\`\`\`sh
somewhere typecheck
somewhere deploy
somewhere verify
\`\`\`

Deploy the raw source. The platform compiles it; do not create or deploy a
\`dist/\` or \`build/\` directory. For a starter without sign-in, run
\`somewhere init --template minimal\` in an empty directory.
`;

export function createAuthTemplate(): InitScaffoldFile[] {
  return [
    { path: '.gitignore', content: 'node_modules\ndist\nbuild\n.env\n' },
    { path: 'AGENTS.md', content: INIT_AGENTS_MD },
    { path: 'CLAUDE.md', content: INIT_CLAUDE_MD },
    { path: 'README.md', content: README },
    { path: 'package.json', content: PACKAGE_JSON },
    { path: 'tsconfig.json', content: TSCONFIG },
    {
      path: 'index.html',
      content: '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>somewhere.tech starter</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
    },
    { path: 'src/App.tsx', content: APP },
    { path: 'src/main.tsx', content: MAIN },
    { path: 'src/services/auth.ts', content: AUTH_SERVICE },
    { path: 'src/services/greeting.ts', content: GREETING_SERVICE },
    { path: 'src/styles.css', content: STYLES },
    { path: 'api/auth/[...path].ts', content: AUTH_API },
    { path: 'api/greeting.ts', content: GREETING_API },
    { path: 'db/schema.ts', content: SCHEMA },
    { path: 'types/app.ts', content: APP_TYPES },
  ];
}
