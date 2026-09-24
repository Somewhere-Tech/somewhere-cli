import type { InitScaffoldFile } from './init-scaffold.js';
import { INIT_AGENTS_MD, INIT_CLAUDE_MD } from './init-agent-guide.js';

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

const RUNTIME_TYPES = `export interface QueryResult<T> {
  data: T[];
  count: number;
  changes: number;
}

export interface SomewhereRuntime {
  db: {
    from<T>(table: string, options: { limit: number }): Promise<QueryResult<T>>;
  };
}
`;

const SCHEMA = `import { id, schema, serverOnly, table, text } from 'somewhere/db';

export default schema({
  greetings: table({
    id: id(),
    message: text({ default: 'Your full-stack app is ready.' }),
  }, {
    scope: serverOnly(),
  }),
});
`;

const API = `import type { SomewhereRuntime } from '../types/runtime';

interface GreetingRow {
  message: string;
}

export default async function greeting(
  _req: Request,
  sw: SomewhereRuntime,
): Promise<Response> {
  const result = await sw.db.from<GreetingRow>('greetings', { limit: 1 });

  return Response.json({
    message: result.data[0]?.message ?? 'Your full-stack app is ready.',
  });
}
`;

const SERVICE = `import type { GreetingResponse } from '../../types/app';

export async function loadGreeting(): Promise<GreetingResponse> {
  const response = await fetch('/api/greeting');
  if (!response.ok) throw new Error(\`Request failed (\${response.status})\`);
  return response.json() as Promise<GreetingResponse>;
}
`;

const APP = `import { useEffect, useState } from 'react';
import { loadGreeting } from './services/greeting';

export function App() {
  const [message, setMessage] = useState('Connecting frontend, function, and database…');

  useEffect(() => {
    void loadGreeting()
      .then((result) => setMessage(result.message))
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : 'Could not load the greeting.');
      });
  }, []);

  return (
    <main>
      <p className="eyebrow">somewhere.tech starter</p>
      <h1>Start with a working full-stack app.</h1>
      <p className="message">{message}</p>
      <p className="hint">Edit <code>src/App.tsx</code>, then deploy the raw source.</p>
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
main { width: min(720px, calc(100% - 32px)); margin: 14vh auto; }
h1 { max-width: 660px; margin: 12px 0 24px; font-size: clamp(2.7rem, 8vw, 5.5rem); line-height: .94; letter-spacing: -.06em; }
.eyebrow { color: #14734c; font-weight: 750; text-transform: uppercase; letter-spacing: .12em; }
.message { padding: 20px 22px; border: 1px solid #c6d8ce; border-radius: 16px; background: rgba(255, 255, 255, .82); }
.hint { color: #4f665b; }
code { color: #0e6542; }
`;

const README = `# somewhere.tech starter

This project starts green: a typed React page calls a typed public greeting
function. It reads the server-only table declared in \`db/schema.ts\` and
shows a fallback message while the table is empty. The endpoint exposes only
the greeting message; add caller authorization before serving private data.

\`\`\`sh
somewhere typecheck
somewhere deploy-check .
somewhere deploy
somewhere browser
\`\`\`

Deploy the raw source. The platform compiles it; do not create or deploy a
\`dist/\` or \`build/\` directory.
`;

export function createGreenTemplate(): InitScaffoldFile[] {
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
    { path: 'src/services/greeting.ts', content: SERVICE },
    { path: 'src/styles.css', content: STYLES },
    { path: 'api/greeting.ts', content: API },
    { path: 'db/schema.ts', content: SCHEMA },
    { path: 'types/app.ts', content: APP_TYPES },
    { path: 'types/runtime.ts', content: RUNTIME_TYPES },
  ];
}
