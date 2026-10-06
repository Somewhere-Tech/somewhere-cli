import type { InitScaffoldFile } from './init-scaffold.js';
import type { InitSelection } from './init-features.js';
import { INIT_AGENTS_MD, INIT_CLAUDE_MD } from './init-agent-guide.js';

// Files for the auth starter (`somewhere init`, `--features ...`). Types,
// services, hooks, routing and pages are written once. Only the views in
// src/ui differ by --ui: styled views + src/styles, or plain semantic views
// with the same exported names and props.

export interface FeatureTemplateOptions {
  appName: string;
}

const PACKAGE_JSON = `{
  "name": "somewhere-app",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "somewhere dev",
    "typecheck": "somewhere typecheck"
  },
  "dependencies": {
    "@somewhere-tech/sdk": "0.12.0",
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

function indexHtml(appName: string): string {
  const title = appName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

// ------------------------------------------------------------------ behaviour

const AUTH_API = `export { somewhereAuth as default } from '@somewhere-tech/sdk/server';
`;

const AUTH_TYPES = `import type { User } from '@somewhere-tech/sdk/auth';

export type { User };

/**
 * loading: no answer yet (first visit, or another tab changed the account).
 * signing-out: private data is cleared; the server has not answered /logout yet.
 * unavailable: the server could not confirm a session, and none was confirmed
 * on this page. suspended: a re-check failed for the account confirmed on this
 * page; its pages stay mounted but hidden until the session is confirmed.
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'signing-out' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: User }
  | { status: 'unavailable'; retrying: boolean; retry(): void }
  | { status: 'suspended'; user: User; retrying: boolean; retry(): void };

export type CredentialsMode = 'sign-in' | 'sign-up';

export interface CredentialsForm {
  mode: CredentialsMode;
  email: string;
  password: string;
  passwordMinLength: number;
  pending: boolean;
  error: string | null;
  canSubmit: boolean;
  setEmail(value: string): void;
  setPassword(value: string): void;
  toggleMode(): void;
  submit(): Promise<void>;
}

export interface SignOutAction {
  pending: boolean;
  error: string | null;
  signOut(): Promise<void>;
}

/** A sign-out the server has not confirmed; retry() calls it again. */
export interface UnconfirmedSignOut {
  pending: boolean;
  retry(): void;
}

/**
 * The "verify your email" panel. checking: asking the server. verified: done;
 * the panel shows nothing. unverified: the code form. unavailable: the server
 * could not say; retry() asks again.
 */
export interface EmailVerification {
  status: 'checking' | 'verified' | 'unverified' | 'unavailable';
  code: string;
  /** A code was emailed in this visit. */
  sent: boolean;
  pending: boolean;
  error: string | null;
  canSubmit: boolean;
  setCode(value: string): void;
  sendCode(): Promise<void>;
  submit(): Promise<void>;
  retry(): void;
}
`;

const AUTH_SERVICE = `import { AuthError, createSomewhereAuth } from '@somewhere-tech/sdk/auth';

// The app's auth client (SDK). It talks to api/auth/[...path].ts. The session
// is an httpOnly cookie the browser keeps; app code never handles a token.
export const auth = createSomewhereAuth();

export const PASSWORD_MIN_LENGTH = 8;

export function authErrorMessage(reason: unknown): string {
  if (reason instanceof AuthError && reason.message) return reason.message;
  if (reason instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  if (reason instanceof Error && reason.message) return reason.message;
  return 'Something went wrong. Try again.';
}
`;

const AUTH_HOOKS = `import { useRef, useState } from 'react';
import { useAuth, useAuthState as useSdkAuthState } from '@somewhere-tech/sdk/react';
import type { AuthState, CredentialsForm, CredentialsMode, SignOutAction, UnconfirmedSignOut, User } from '../../types/auth';
import { authErrorMessage, PASSWORD_MIN_LENGTH } from '../services/auth';

// State and actions over the SDK's session status; no session store here.
// Only an account the server confirmed is signed in: a cached user waits for
// the first check, and a failed check is 'unavailable', never signed in.
export function useAuthState(): AuthState {
  const session = useSdkAuthState();
  const [retrying, setRetrying] = useState(false);
  // The account the server confirmed on this page. Only it may keep its
  // (hidden) pages through a failed re-check.
  const confirmed = useRef<User | null>(null);
  if (session.status === 'authenticated') confirmed.current = session.user;
  if (session.status === 'signed-out' || session.status === 'checking') confirmed.current = null;

  switch (session.status) {
    case 'authenticated':
      return session.user ? { status: 'signed-in', user: session.user } : { status: 'signed-out' };
    case 'signed-out':
      // Private data is already gone; the sign-in page waits for the server
      // to answer /logout, because until then it may still accept the session.
      return session.signingOut ? { status: 'signing-out' } : { status: 'signed-out' };
    case 'checking':
      return { status: 'loading' };
    case 'indeterminate': {
      const retry = () => {
        setRetrying(true);
        void session.recheck().finally(() => setRetrying(false));
      };
      const kept = confirmed.current;
      return kept && session.user?.id === kept.id
        ? { status: 'suspended', user: kept, retrying, retry }
        : { status: 'unavailable', retrying, retry };
    }
  }
}

export function useCredentialsForm(initialMode: CredentialsMode = 'sign-in'): CredentialsForm {
  const auth = useAuth();
  const [mode, setMode] = useState<CredentialsMode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordReady = mode === 'sign-up' ? password.length >= PASSWORD_MIN_LENGTH : password.length > 0;
  const canSubmit = !pending && email.trim() !== '' && passwordReady;

  async function submit() {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const credentials = { email: email.trim(), password };
      await (mode === 'sign-in' ? auth.signIn(credentials) : auth.signUp(credentials));
      // The provider now has the user; App replaces the sign-in page.
    } catch (reason: unknown) {
      setError(authErrorMessage(reason));
      setPending(false);
    }
  }

  return {
    mode,
    email,
    password,
    passwordMinLength: PASSWORD_MIN_LENGTH,
    pending,
    error,
    canSubmit,
    setEmail,
    setPassword,
    toggleMode() {
      setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
      setError(null);
    },
    submit,
  };
}

export function useSignOut(): SignOutAction {
  const auth = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    try {
      await auth.signOut();
    } catch (reason: unknown) {
      setError(authErrorMessage(reason));
      setPending(false);
    }
  }

  return { pending, error, signOut };
}

/** Non-null while the server has not confirmed the last sign-out: this
 *  browser was signed out locally, but the server session may still exist. */
export function useUnconfirmedSignOut(): UnconfirmedSignOut | null {
  const auth = useAuth();
  const session = useSdkAuthState();
  const [pending, setPending] = useState(false);
  if (!session.signOutUnconfirmed) return null;
  return {
    pending,
    retry() {
      setPending(true);
      void auth.signOut().finally(() => setPending(false));
    },
  };
}
`;

const ROUTES = `import { useEffect, useState, type MouseEvent } from 'react';

// Single entry: the platform serves index.html for every extensionless path,
// so the app routes on location.pathname. To add a page, add its path here
// and a case in App.tsx.
export const ROUTES = {
  home: '/',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

export interface LinkProps {
  href: string;
  onClick(event: MouseEvent<HTMLAnchorElement>): void;
}

export function navigate(path: RoutePath): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Props for an <a> that navigates in-app and keeps new-tab behaviour. */
export function linkTo(path: RoutePath): LinkProps {
  return {
    href: path,
    onClick(event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(path);
    },
  };
}

export function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return pathname;
}
`;

const APP = `import type { User } from '../types/auth';
import { useAuthState } from './auth/hooks';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SignInPage } from './pages/SignInPage';
import { ROUTES, usePathname } from './routes';
import { LoadingScreen, SessionUnavailable } from './ui/feedback';

// Routing and the sign-in boundary. This gate is UX: the server and
// db/schema.ts decide what each request may read or write.
export function App() {
  const session = useAuthState();

  if (session.status === 'loading') return <LoadingScreen label="Checking your session…" />;
  if (session.status === 'signing-out') return <LoadingScreen label="Signing out…" />;
  if (session.status === 'signed-out') return <SignInPage />;
  if (session.status === 'unavailable') {
    return <SessionUnavailable keepsWork={false} retrying={session.retrying} onRetry={session.retry} />;
  }
  const suspended = session.status === 'suspended';
  return (
    <>
      {suspended ? <SessionUnavailable keepsWork retrying={session.retrying} onRetry={session.retry} /> : null}
      {/* Keyed by user id: signing out or switching accounts unmounts every
          private page. A failed re-check only hides and disables them, so
          unsaved input survives until the session is confirmed again. */}
      <div hidden={suspended} inert={suspended}>
        <PrivateRoutes key={session.user.id} user={session.user} />
      </div>
    </>
  );
}

function PrivateRoutes({ user }: { user: User }) {
  const pathname = usePathname();
  switch (pathname) {
    case ROUTES.home:
      return <HomePage user={user} />;
    default:
      return <NotFoundPage user={user} />;
  }
}
`;

function mainTsx(styled: boolean, agent: boolean): string {
  const styles = styled ? `import './styles/tokens.css';\nimport './styles/app.css';\n` : '';
  if (agent) return mainTsxWithFixtures(styles);
  return `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SomewhereAuthProvider } from '@somewhere-tech/sdk/react';
import { App } from './App';
import { auth } from './services/auth';
${styles}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SomewhereAuthProvider client={auth}>
      <App />
    </SomewhereAuthProvider>
  </StrictMode>,
);
`;
}

// /fixtures is decided before the sign-in provider mounts: the provider checks
// the session on mount, and a fixture preview must send no request at all.
function mainTsxWithFixtures(styles: string): string {
  return `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SomewhereAuthProvider } from '@somewhere-tech/sdk/react';
import { App } from './App';
import { FIXTURES_PATH } from './fixtures/assistant';
import { AssistantFixturesPage } from './pages/AssistantFixturesPage';
import { auth } from './services/auth';
${styles}
// /fixtures renders declared preview states from static data, outside the
// sign-in provider, so it sends no request. Everything else is the app.
const preview = window.location.pathname === FIXTURES_PATH;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {preview ? (
      <AssistantFixturesPage />
    ) : (
      <SomewhereAuthProvider client={auth}>
        <App />
      </SomewhereAuthProvider>
    )}
  </StrictMode>,
);
`;
}

function configTs(appName: string): string {
  return `// Shown in the header and on the sign-in page; index.html holds the tab title.
export const APP_NAME = ${JSON.stringify(appName)};
`;
}

// ------------------------------------------------------- private-data: backend

const SCHEMA = `import { id, owner, schema, table, text } from 'somewhere/db';

// notes: owner() gives each signed-in user their own rows through the
// generated somewhere:data client, so the browser code sends no user filter.
// Functions you add can use explicit server-authority calls that skip this
// scope; they must check the caller themselves. \`somewhere docs declared-data\`
export default schema({
  notes: table(
    { id: id(), title: text(), body: text({ default: '' }) },
    {
      scope: owner(),
      client: {
        read: ['id', 'title', 'body'],
        create: ['title', 'body'],
        update: ['title', 'body'],
        delete: true,
        identity: 'authenticated',
      },
    },
  ),
});
`;

const NOTES_TYPES = `export interface Note {
  id: number;
  title: string;
  body: string;
}

export type NoteId = Note['id'];

export interface NoteDraft {
  title: string;
  body: string;
}

export type NoteDraftErrors = Partial<Record<keyof NoteDraft, string>>;

/** unchanged: nothing differed, so nothing was written. missing: the note is
 *  gone for this user (deleted elsewhere, or never theirs). */
export type NoteSaveResult =
  | { kind: 'saved'; note: Note }
  | { kind: 'unchanged' }
  | { kind: 'missing' };

export type NoteRemoveResult = { kind: 'removed' } | { kind: 'missing' };

export type NotesStatus = 'loading' | 'ready' | 'error';

export interface NotesController {
  status: NotesStatus;
  notes: Note[];
  /** True when more notes exist than the first page shows. */
  truncated: boolean;
  loadError: string | null;
  reload(): void;
  draft: NoteDraft;
  draftErrors: NoteDraftErrors;
  limits: { title: number; body: number };
  setDraft(draft: NoteDraft): void;
  editingId: NoteId | null;
  startEdit(note: Note): void;
  cancelEdit(): void;
  saving: boolean;
  canSave: boolean;
  save(): Promise<void>;
  removingId: NoteId | null;
  remove(note: Note): Promise<void>;
  /** The last write's outcome, for a polite live region. */
  notice: { tone: 'info' | 'error'; text: string } | null;
}
`;

const NOTES_SERVICE = `import { data, DataError } from 'somewhere:data';
import type { Note, NoteDraft, NoteDraftErrors, NoteId, NoteRemoveResult, NoteSaveResult } from '../../types/notes';

// Length limits are for the form. db/schema.ts has no length constraint, so
// a hard limit belongs in a function that validates before it writes.
export const NOTE_LIMITS = { title: 120, body: 4000 } as const;
const PAGE_SIZE = 100;

export function normalizeDraft(draft: NoteDraft): NoteDraft {
  return { title: draft.title.trim(), body: draft.body.trim() };
}

export function validateDraft(draft: NoteDraft): NoteDraftErrors {
  const { title, body } = normalizeDraft(draft);
  const errors: NoteDraftErrors = {};
  if (!title) errors.title = 'Add a title.';
  else if (title.length > NOTE_LIMITS.title) errors.title = 'Keep the title to ' + NOTE_LIMITS.title + ' characters.';
  if (body.length > NOTE_LIMITS.body) errors.body = 'Keep the note to ' + NOTE_LIMITS.body + ' characters.';
  return errors;
}

function sameDraft(note: Note, draft: NoteDraft): boolean {
  const next = normalizeDraft(draft);
  return note.title === next.title && note.body === next.body;
}

// Rows come back scoped to the signed-in user by owner(); send no user filter.
export async function listNotes(): Promise<{ notes: Note[]; truncated: boolean }> {
  const page = await data.notes.list({ limit: PAGE_SIZE });
  return { notes: page.data, truncated: page.has_more };
}

export async function createNote(draft: NoteDraft): Promise<Note> {
  const result = await data.notes.create(normalizeDraft(draft));
  if (!result.data) throw new Error('The note was not saved. Try again.');
  return result.data;
}

export async function updateNote(note: Note, draft: NoteDraft): Promise<NoteSaveResult> {
  if (sameDraft(note, draft)) return { kind: 'unchanged' };
  try {
    const result = await data.notes.update(note.id, normalizeDraft(draft));
    if (result.changes === 0) return { kind: 'unchanged' };
    return { kind: 'saved', note: result.data ?? { id: note.id, ...normalizeDraft(draft) } };
  } catch (reason: unknown) {
    if (isNotFound(reason)) return { kind: 'missing' };
    throw reason;
  }
}

export async function removeNote(id: NoteId): Promise<NoteRemoveResult> {
  try {
    await data.notes.delete(id);
    return { kind: 'removed' };
  } catch (reason: unknown) {
    if (isNotFound(reason)) return { kind: 'missing' };
    throw reason;
  }
}

/** A missing note and one this user may not write answer the same way. */
function isNotFound(reason: unknown): boolean {
  return reason instanceof DataError && reason.code === 'DATA_NOT_FOUND';
}

export function isSessionEnded(reason: unknown): boolean {
  return reason instanceof DataError && reason.code === 'AUTH_REQUIRED';
}

export function notesErrorMessage(reason: unknown): string {
  if (reason instanceof DataError) {
    switch (reason.code) {
      case 'AUTH_REQUIRED':
        return 'Your session ended. Sign in again.';
      case 'DATA_CONTRACT_MISMATCH':
        return 'This app was just updated. Reload the page to continue.';
      default:
        return reason.message || 'The request failed (' + reason.status + ').';
    }
  }
  if (reason instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  if (reason instanceof Error && reason.message) return reason.message;
  return 'Something went wrong. Try again.';
}
`;

const USE_NOTES = `import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@somewhere-tech/sdk/react';
import type { Note, NoteDraft, NoteDraftErrors, NoteId, NotesController, NotesStatus } from '../../types/notes';
import {
  createNote,
  isSessionEnded,
  listNotes,
  NOTE_LIMITS,
  notesErrorMessage,
  removeNote,
  updateNote,
  validateDraft,
} from '../services/notes';

const EMPTY_DRAFT: NoteDraft = { title: '', body: '' };

// Mounted inside App's per-user boundary, so a new account always starts from
// a fresh hook. Results that arrive after this view unmounted (sign-out,
// account switch) are dropped, including writes still in flight.
export function useNotes(): NotesController {
  const auth = useAuth();
  const mounted = useRef(true);
  const [status, setStatus] = useState<NotesStatus>('loading');
  const [notes, setNotes] = useState<Note[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<NoteDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<NoteId | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<NoteId | null>(null);
  const [notice, setNotice] = useState<NotesController['notice']>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setStatus('loading');
    setLoadError(null);
    listNotes()
      .then((result) => {
        if (!current) return;
        setNotes(result.notes);
        setTruncated(result.truncated);
        setStatus('ready');
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setLoadError(notesErrorMessage(reason));
        setStatus('error');
        if (isSessionEnded(reason)) void auth.getUser();
      });
    return () => {
      current = false;
    };
  }, [reloadKey, auth]);

  const errors = validateDraft(draft);
  // An empty title disables Save; it is not flagged while the user types.
  const draftErrors: NoteDraftErrors = draft.title.trim() ? errors : { body: errors.body };
  const editing = editingId === null ? null : notes.find((note) => note.id === editingId) ?? null;
  const canSave = !saving && Object.keys(errors).length === 0;

  function fail(reason: unknown) {
    setNotice({ tone: 'error', text: notesErrorMessage(reason) });
    if (isSessionEnded(reason)) void auth.getUser();
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setNotice(null);
    try {
      if (editing) {
        const result = await updateNote(editing, draft);
        if (!mounted.current) return;
        if (result.kind === 'saved') {
          setNotes((list) => list.map((note) => (note.id === editing.id ? result.note : note)));
          setNotice({ tone: 'info', text: 'Saved.' });
        } else if (result.kind === 'unchanged') {
          setNotice({ tone: 'info', text: 'No changes to save.' });
        } else {
          setNotes((list) => list.filter((note) => note.id !== editing.id));
          setNotice({ tone: 'error', text: 'That note was already removed.' });
        }
      } else {
        const created = await createNote(draft);
        if (!mounted.current) return;
        setNotes((list) => [...list, created]);
        setNotice({ tone: 'info', text: 'Added.' });
      }
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
    } catch (reason: unknown) {
      if (mounted.current) fail(reason);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function remove(note: Note) {
    setRemovingId(note.id);
    setNotice(null);
    try {
      const result = await removeNote(note.id);
      if (!mounted.current) return;
      setNotes((list) => list.filter((item) => item.id !== note.id));
      if (editingId === note.id) {
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
      }
      setNotice({ tone: 'info', text: result.kind === 'removed' ? 'Deleted.' : 'That note was already removed.' });
    } catch (reason: unknown) {
      if (mounted.current) fail(reason);
    } finally {
      if (mounted.current) setRemovingId(null);
    }
  }

  return {
    status,
    notes,
    truncated,
    loadError,
    reload: () => setReloadKey((key) => key + 1),
    draft,
    draftErrors,
    limits: NOTE_LIMITS,
    setDraft,
    editingId,
    startEdit(note) {
      setEditingId(note.id);
      setDraft({ title: note.title, body: note.body });
      setNotice(null);
    },
    cancelEdit() {
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
    },
    saving,
    canSave,
    save,
    removingId,
    remove,
    notice,
  };
}
`;

// -------------------------------------------------------------- agent: backend

const AGENT_TABLES = `  // The effect. Only api/proposals.ts writes tasks, after the owner approves.
  tasks: table(
    { id: id(), title: text(), created_at: timestamp({ default: 'now' }) },
    { scope: owner() },
  ),
  // What the assistant may do instead: draft and wait. tool_call_id is unique,
  // so a repeated tool call with the same id leaves one proposal.
  proposals: table(
    {
      id: id(),
      tool_call_id: text({ unique: true }),
      title: text(),
      status: text({ default: 'pending' }), // pending | approved | rejected
      created_at: timestamp({ default: 'now' }),
    },
    { scope: owner(), indexes: [['status']] },
  ),
`;

const AGENT_SCHEMA_NOTE = `// tasks, proposals: owner() scopes every structured call in api/chat.ts and
// api/proposals.ts to the signed-in caller. They have no client block, so the
// browser reaches them only through those two functions.
`;

function schemaTs(privateData: boolean, agent: boolean): string {
  if (!agent) return SCHEMA;
  const imports = `import { id, owner, schema, table, text, timestamp } from 'somewhere/db';\n\n`;
  if (!privateData) return imports + AGENT_SCHEMA_NOTE + 'export default schema({\n' + AGENT_TABLES + '});\n';
  const notes = SCHEMA.slice(SCHEMA.indexOf('// notes:'));
  return imports + AGENT_SCHEMA_NOTE + notes.replace(/\n\}\);\n$/, '\n' + AGENT_TABLES + '});\n');
}

const CHAT_API = `// api/chat.ts — one assistant conversation per signed-in person.
//
//   GET  /api/chat   → { messages: [{ role, text }] }   the saved transcript
//   POST /api/chat   { message } → { reply, completion_reason, activity, spent_cents }
//
// The run is inline (sw.agent.run): it finishes inside this request, bounded by
// maxSteps and maxSpendCents. There is no agent id and nothing to cancel; see
// README.md before turning it into a durable sw.agent.start run.

// Every signed-in person gets their own conversation under this one name: the
// platform keys stored history by the verified user, so two people sending the
// same id never see each other's turns.
const CONVERSATION = 'assistant';

const SYSTEM = [
  'You help one person keep a short task list.',
  'Call list_tasks before answering questions about their tasks.',
  'You cannot add tasks. To suggest one, call propose_task; the person approves or rejects it in the page.',
  'After proposing, say plainly that it is waiting for their approval.',
].join(' ');

type Activity = { tool: string; tool_call_id: string; ok: boolean; detail: string };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

async function transcript(sw: SomewhereRuntimeContext): Promise<Response> {
  // Stored conversations are listed by their own id; ours is the one whose
  // client id is CONVERSATION. Both calls are scoped to the signed-in caller.
  const { conversations } = await sw.ai.conversations.list({ limit: 20 });
  const mine = conversations.find((c) => c.client_conversation_id === CONVERSATION);
  if (!mine) return Response.json({ messages: [] });
  const conversation = await sw.ai.conversations.get(mine.id);
  const messages = conversation.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: textOf(m.content) }))
    .filter((m) => m.text.trim() !== ''); // tool calls and results carry no text
  return Response.json({ messages });
}

export default async (req: Request, sw: SomewhereRuntimeContext): Promise<Response> => {
  await sw.auth.requireUser(req); // 401 AUTH_REQUIRED before a model call or read
  if (req.method === 'GET') return transcript(sw);
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
    ? body.message.trim() : '';
  if (!message || message.length > 2000) {
    return Response.json({ error: 'VALIDATION_ERROR', message: 'Send a message of 1–2000 characters.' }, { status: 400 });
  }

  const activity: Activity[] = [];
  try {
    const result = await sw.agent.run({
      conversation_id: CONVERSATION,
      messages: [{ role: 'user', content: message }],
      system: SYSTEM,
      maxSteps: 4,
      // Checked between billed calls: one call can cross it, and a step whose
      // cost is still unknown ends the run with completion_reason 'cost_pending'.
      maxSpendCents: 10,
      tools: {
        list_tasks: {
          description: 'List this person’s tasks, newest first.',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_input, { toolCallId }) => {
            // owner(): returns only the signed-in caller's rows.
            const { data } = await sw.db.from('tasks', {
              columns: ['id', 'title'], order: [['created_at', 'desc']], limit: 50,
            });
            activity.push({ tool: 'list_tasks', tool_call_id: toolCallId, ok: true, detail: \`\${data.length} task(s)\` });
            return data;
          },
        },
        propose_task: {
          description: 'Suggest one new task. It is NOT added until the person approves it.',
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string', description: 'Short task title' } },
            required: ['title'],
          },
          execute: async (input, { toolCallId }) => {
            const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
            if (!title) {
              activity.push({ tool: 'propose_task', tool_call_id: toolCallId, ok: false, detail: 'missing title' });
              throw new Error('title is required');
            }
            // Drafting is the only write the model can cause. toolCallId is the
            // dedupe key: the same call id twice leaves one proposal.
            await sw.db.insert('proposals', { tool_call_id: toolCallId, title }, { onConflict: 'ignore' });
            activity.push({ tool: 'propose_task', tool_call_id: toolCallId, ok: true, detail: title });
            return { status: 'waiting_for_approval', title };
          },
        },
      },
    });
    return Response.json({
      reply: result.text ?? '',
      completion_reason: result.completion_reason,
      activity,
      // Non-enumerable on the result, so read it directly. null = not known yet.
      spent_cents: result.total_cost_cents,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'AI_SPEND_CAP_EXCEEDED') {
      return Response.json({
        error: code,
        message: 'This reply hit its spending limit and stopped. Anything listed under activity already happened.',
        activity,
      }, { status: 402 });
    }
    throw error;
  }
};
`;

const PROPOSALS_API = `// api/proposals.ts — the human approval step, and the only path to the effect.
//
//   GET  /api/proposals   → { proposals: pending[], tasks: [] }
//   POST /api/proposals   { id, decision: 'approve' | 'reject' } → { proposal, task? }
//
// The assistant can only draft (api/chat.ts). A task row exists because the
// signed-in owner sent this POST, never because a model said so.
//
// Approving and creating the task are two writes, not one transaction. The
// approval is claimed first and is never reopened: if the task write fails or
// its outcome is unknown, the answer is 500 TASK_CREATION_UNCONFIRMED and the
// person checks their task list instead of approving again.

export default async (req: Request, sw: SomewhereRuntimeContext): Promise<Response> => {
  await sw.auth.requireUser(req);

  if (req.method === 'GET') {
    const [proposals, tasks] = await Promise.all([
      sw.db.from('proposals', {
        columns: ['id', 'title', 'created_at'], where: { status: 'pending' },
        order: [['created_at', 'asc']], limit: 20,
      }),
      sw.db.from('tasks', { columns: ['id', 'title'], order: [['created_at', 'desc']], limit: 50 }),
    ]);
    return Response.json({ proposals: proposals.data, tasks: tasks.data });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const id = body && typeof body === 'object' && 'id' in body ? Number(body.id) : NaN;
  const decision = body && typeof body === 'object' && 'decision' in body ? body.decision : null;
  if (!Number.isInteger(id) || (decision !== 'approve' && decision !== 'reject')) {
    return Response.json({ error: 'VALIDATION_ERROR', message: 'Send { id, decision: "approve" | "reject" }.' }, { status: 400 });
  }

  // Claim the decision first. The status guard makes a double click, a second
  // tab, a retry, or another person's id (owner scope) a zero-change 409, so
  // the task below is attempted at most once per proposal.
  const claimed = await sw.db.update('proposals', {
    set: { status: decision === 'approve' ? 'approved' : 'rejected' },
    where: { id, status: 'pending' },
  });
  const proposal = claimed.data[0];
  if (claimed.changes === 0 || !proposal) {
    return Response.json({ error: 'NOT_PENDING', message: 'That proposal is gone or already decided.' }, { status: 409 });
  }
  if (decision === 'reject') return Response.json({ proposal });

  try {
    const made = await sw.db.insert('tasks', { title: String(proposal.title) });
    return Response.json({ proposal, task: made.data[0] ?? null });
  } catch {
    // The write may have committed before the error reached us, so the
    // proposal stays approved: reopening it could create the task twice.
    return Response.json({
      error: 'TASK_CREATION_UNCONFIRMED',
      message: 'Your approval was recorded, but the task could not be confirmed. Refresh your task list; if it is missing, ask the assistant to propose it again.',
      proposal,
    }, { status: 500 });
  }
};
`;

// ------------------------------------------------------------- agent: frontend

const ASSISTANT_TYPES = `export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  text: string;
}

/** One tool call from the last reply, as api/chat.ts reports it. */
export interface ToolActivity {
  tool: string;
  tool_call_id: string;
  ok: boolean;
  detail: string;
}

/** A task the assistant drafted; it becomes a task only after approval. */
export interface Proposal {
  id: number;
  title: string;
}

export interface AgentTask {
  id: number;
  title: string;
}

export type ProposalDecision = 'approve' | 'reject';

/** api/chat.ts POST answer. \`spent_cents\` is null while the cost is not known yet. */
export interface ChatReply {
  reply: string;
  completion_reason: string;
  activity: ToolActivity[];
  spent_cents: number | null;
}

export type AssistantStatus = 'loading' | 'ready' | 'error';

/** Everything the panel draws. Real data and the fixtures both produce it. */
export interface AssistantView {
  status: AssistantStatus;
  messages: ChatMessage[];
  activity: ToolActivity[];
  proposals: Proposal[];
  tasks: AgentTask[];
  error: string | null;
}

export interface AssistantController {
  view: AssistantView;
  draft: string;
  limit: number;
  /** True for fixture previews: every control is disabled and nothing is sent. */
  readOnly: boolean;
  setDraft(next: string): void;
  canSend: boolean;
  sending: boolean;
  send(): Promise<void>;
  /** The proposal whose decision is being saved, if one is. */
  deciding: Proposal['id'] | null;
  decide(id: Proposal['id'], decision: ProposalDecision): Promise<void>;
  reload(): void;
}
`;

const ASSISTANT_SERVICE = `import type { AgentTask, ChatMessage, ChatReply, Proposal, ProposalDecision, ToolActivity } from '../../types/assistant';

// Calls to this app's own functions, api/chat.ts and api/proposals.ts. The
// session cookie rides along; the server decides whose rows these are.

export const MESSAGE_LIMIT = 2000;

export class AssistantRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Tool calls that already ran before the request failed (spend cap). */
    readonly activity: ToolActivity[] = [],
  ) {
    super(message);
    this.name = 'AssistantRequestError';
  }
}

interface FailureBody {
  message?: unknown;
  activity?: unknown;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure: FailureBody = body && typeof body === 'object' ? body : {};
    throw new AssistantRequestError(
      typeof failure.message === 'string' ? failure.message : 'The request failed (' + response.status + ').',
      response.status,
      Array.isArray(failure.activity) ? (failure.activity as ToolActivity[]) : [],
    );
  }
  return body as T;
}

export async function loadTranscript(): Promise<ChatMessage[]> {
  return (await call<{ messages: ChatMessage[] }>('/api/chat')).messages;
}

export function loadLists(): Promise<{ proposals: Proposal[]; tasks: AgentTask[] }> {
  return call('/api/proposals');
}

export function sendMessage(message: string): Promise<ChatReply> {
  return call('/api/chat', { method: 'POST', body: JSON.stringify({ message }) });
}

export async function decideProposal(id: Proposal['id'], decision: ProposalDecision): Promise<void> {
  await call('/api/proposals', { method: 'POST', body: JSON.stringify({ id, decision }) });
}

/** The reply as shown: a run that stopped early says why. */
export function replyText(reply: ChatReply): string {
  if (reply.completion_reason === 'model_done') return reply.reply;
  return ((reply.reply ? reply.reply + ' ' : '') + '(stopped: ' + reply.completion_reason + ')');
}

export function isSessionEnded(reason: unknown): boolean {
  return reason instanceof AssistantRequestError && reason.status === 401;
}

export function assistantErrorMessage(reason: unknown): string {
  if (isSessionEnded(reason)) return 'Your session ended. Sign in again.';
  if (reason instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  if (reason instanceof Error && reason.message) return reason.message;
  return 'Something went wrong. Try again.';
}
`;

const USE_ASSISTANT = `import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@somewhere-tech/sdk/react';
import type { AssistantController, AssistantView, Proposal, ProposalDecision } from '../../types/assistant';
import {
  AssistantRequestError,
  assistantErrorMessage,
  decideProposal,
  isSessionEnded,
  loadLists,
  loadTranscript,
  MESSAGE_LIMIT,
  replyText,
  sendMessage,
} from '../services/assistant';

const INITIAL: AssistantView = { status: 'loading', messages: [], activity: [], proposals: [], tasks: [], error: null };

// Mounted inside App's per-user boundary, so a new account starts fresh.
// Results that arrive after this view unmounted are dropped.
export function useAssistant(): AssistantController {
  const auth = useAuth();
  const mounted = useRef(true);
  const [view, setView] = useState<AssistantView>(INITIAL);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState<Proposal['id'] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setView((previous) => ({ ...previous, status: 'loading', error: null }));
    Promise.all([loadTranscript(), loadLists()])
      .then(([messages, lists]) => {
        if (current) setView((previous) => ({ ...previous, status: 'ready', messages, ...lists }));
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setView((previous) => ({ ...previous, status: 'error', error: assistantErrorMessage(reason) }));
        if (isSessionEnded(reason)) void auth.getUser();
      });
    return () => {
      current = false;
    };
  }, [reloadKey, auth]);

  async function refreshLists() {
    const lists = await loadLists();
    if (mounted.current) setView((previous) => ({ ...previous, ...lists }));
  }

  function fail(reason: unknown) {
    const ran = reason instanceof AssistantRequestError ? reason.activity : [];
    setView((previous) => ({ ...previous, error: assistantErrorMessage(reason), activity: ran.length ? ran : previous.activity }));
    if (isSessionEnded(reason)) void auth.getUser();
  }

  const message = draft.trim();
  const canSend = view.status === 'ready' && !sending && message.length > 0 && message.length <= MESSAGE_LIMIT;

  async function send() {
    if (!canSend) return;
    setSending(true);
    setDraft('');
    setView((previous) => ({ ...previous, error: null, activity: [], messages: [...previous.messages, { role: 'user', text: message }] }));
    try {
      const reply = await sendMessage(message);
      if (!mounted.current) return;
      setView((previous) => ({
        ...previous,
        activity: reply.activity,
        messages: [...previous.messages, { role: 'assistant', text: replyText(reply) }],
      }));
      await refreshLists();
    } catch (reason: unknown) {
      if (mounted.current) fail(reason);
    } finally {
      if (mounted.current) setSending(false);
    }
  }

  async function decide(id: Proposal['id'], decision: ProposalDecision) {
    if (deciding !== null) return;
    setDeciding(id);
    setView((previous) => ({ ...previous, error: null }));
    try {
      await decideProposal(id, decision);
      await refreshLists();
    } catch (reason: unknown) {
      if (!mounted.current) return;
      fail(reason);
      // A 409 means it was already decided elsewhere; show the current list.
      await refreshLists().catch(() => undefined);
    } finally {
      if (mounted.current) setDeciding(null);
    }
  }

  return {
    view,
    draft,
    limit: MESSAGE_LIMIT,
    readOnly: false,
    setDraft,
    canSend,
    sending,
    send,
    deciding,
    decide,
    reload: () => setReloadKey((key) => key + 1),
  };
}
`;

const ASSISTANT_FIXTURES = `import type { AssistantController, AssistantView, ChatMessage } from '../../types/assistant';
import { MESSAGE_LIMIT } from '../services/assistant';

// Declared preview states for the assistant panel. /fixtures?state=<name>
// renders one from this static data: no sign-in check, no API call, nothing
// read or written. flows/assistant-fixtures.json screenshots each of them.
// Add a state here and a goto/expect/screenshot triple to that flow.

export const FIXTURES_PATH = '/fixtures';

const longWord = 'Supercalifragilisticexpialidocious'.repeat(4);

export const ASSISTANT_FIXTURES = {
  loading: { status: 'loading', messages: [], activity: [], proposals: [], tasks: [], error: null },
  empty: { status: 'ready', messages: [], activity: [], proposals: [], tasks: [], error: null },
  error: {
    status: 'ready',
    messages: [{ role: 'user', text: 'Plan my week and add everything.' }],
    activity: [{ tool: 'list_tasks', tool_call_id: 'toolu_fixture_1', ok: true, detail: '2 task(s)' }],
    proposals: [],
    tasks: [{ id: 1, title: 'Renew passport' }, { id: 2, title: 'Book dentist' }],
    error: 'This reply hit its spending limit and stopped. Anything listed under activity already happened.',
  },
  populated: {
    status: 'ready',
    messages: [
      { role: 'user', text: 'What is on my list, and should I add something for the trip?' },
      { role: 'assistant', text: 'You have 2 tasks. I proposed “Pack chargers”; it is waiting for your approval.' },
    ],
    activity: [
      { tool: 'list_tasks', tool_call_id: 'toolu_fixture_1', ok: true, detail: '2 task(s)' },
      { tool: 'propose_task', tool_call_id: 'toolu_fixture_2', ok: true, detail: 'Pack chargers' },
    ],
    proposals: [{ id: 7, title: 'Pack chargers' }],
    tasks: [{ id: 1, title: 'Renew passport' }, { id: 2, title: 'Book dentist' }],
    error: null,
  },
  long: {
    status: 'ready',
    messages: Array.from({ length: 12 }, (_, i): ChatMessage => ({
      role: i % 2 ? 'assistant' : 'user',
      text: i === 5
        ? 'An unbroken word: ' + longWord
        : 'Turn ' + (i + 1) + '. ' + 'A longer message that wraps across several lines on a phone. '.repeat(3),
    })),
    activity: Array.from({ length: 4 }, (_, i) => ({
      tool: 'propose_task',
      tool_call_id: 'toolu_fixture_long_' + i,
      ok: i !== 3,
      detail: i === 3 ? 'missing title' : 'Step ' + (i + 1),
    })),
    proposals: Array.from({ length: 5 }, (_, i) => ({ id: 20 + i, title: i === 0 ? longWord : 'Proposed task number ' + (i + 1) + ' with a fairly long title' })),
    tasks: Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, title: 'Existing task ' + (i + 1) })),
    error: null,
  },
} satisfies Record<string, AssistantView>;

export type AssistantFixtureName = keyof typeof ASSISTANT_FIXTURES;

export function assistantFixture(name: string): AssistantView | null {
  return Object.hasOwn(ASSISTANT_FIXTURES, name) ? ASSISTANT_FIXTURES[name as AssistantFixtureName] : null;
}

/** A controller that renders the view and does nothing: every control is disabled. */
export function fixtureController(view: AssistantView): AssistantController {
  return {
    view,
    draft: '',
    limit: MESSAGE_LIMIT,
    readOnly: true,
    setDraft: () => undefined,
    canSend: false,
    sending: false,
    send: async () => undefined,
    deciding: null,
    decide: async () => undefined,
    reload: () => undefined,
  };
}
`;

const ASSISTANT_FIXTURES_PAGE = `import { ASSISTANT_FIXTURES, assistantFixture, fixtureController } from '../fixtures/assistant';
import { AssistantPanel } from '../ui/AssistantPanel';
import { EmptyState } from '../ui/feedback';

// /fixtures?state=<name>: the real panel drawn from static data. main.tsx
// mounts this page outside the sign-in provider, so it sends no request.
export function AssistantFixturesPage() {
  const name = new URLSearchParams(window.location.search).get('state') ?? '';
  const view = assistantFixture(name);
  return (
    <div className="content" data-fixture={view ? name : 'unknown'}>
      <p className="hint" role="status">
        {view ? 'Fixture: ' + name + '. Static preview data; nothing is sent.' : 'Unknown fixture.'}
      </p>
      {view ? (
        <AssistantPanel assistant={fixtureController(view)} />
      ) : (
        <EmptyState title="Pick a declared state.">{Object.keys(ASSISTANT_FIXTURES).map((n) => '?state=' + n).join(', ')}</EmptyState>
      )}
    </div>
  );
}
`;

const ASSISTANT_FIXTURES_FLOW = `{
  "actions": [
    { "goto": "/fixtures?state=loading" },
    { "expect": { "selector": "[data-fixture=\\"loading\\"] [data-status=\\"loading\\"]", "visible": true } },
    { "screenshot": "fixture-loading" },
    { "goto": "/fixtures?state=empty" },
    { "expect": { "selector": "[data-fixture=\\"empty\\"] [data-status=\\"ready\\"]", "visible": true } },
    { "screenshot": "fixture-empty" },
    { "goto": "/fixtures?state=error" },
    { "expect": { "selector": "[data-fixture=\\"error\\"] [role=\\"alert\\"]", "text": "spending limit" } },
    { "screenshot": "fixture-error" },
    { "goto": "/fixtures?state=populated" },
    { "expect": { "selector": "[data-fixture=\\"populated\\"] [aria-label=\\"Waiting for your approval\\"]", "text": "Pack chargers" } },
    { "screenshot": "fixture-populated" },
    { "goto": "/fixtures?state=long" },
    { "expect": { "selector": "[data-fixture=\\"long\\"] [data-role=\\"message\\"]", "count": 12 } },
    { "screenshot": "fixture-long" }
  ],
  "viewports": ["desktop", "mobile"]
}
`;

const STYLED_ASSISTANT_PANEL = `import type { FormEvent } from 'react';
import type { AssistantController } from '../../types/assistant';

export function AssistantPanel({ assistant }: { assistant: AssistantController }) {
  const { view } = assistant;
  const loading = view.status === 'loading';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void assistant.send();
  }

  return (
    <div className="assistant" data-status={view.status}>
      <section className="panel assistant__chat" aria-label="Conversation">
        <p className="panel__title">Assistant</p>
        <p className="hint">It reads your tasks and drafts new ones. Nothing is added until you approve it.</p>
        {loading ? <p className="muted" role="status">Loading your conversation…</p> : null}
        {view.status === 'ready' && view.messages.length === 0 ? (
          <p className="muted">No messages yet. Ask about your tasks, or ask for a plan.</p>
        ) : null}
        <ol className="transcript">
          {view.messages.map((message, index) => (
            <li key={index} data-role="message" className={'message message--' + message.role}>{message.text}</li>
          ))}
        </ol>
        {view.error ? (
          <div className="alert" role="alert">
            <p>{view.error}</p>
            {view.status === 'error' ? <button type="button" className="button button--quiet" onClick={assistant.reload}>Try again</button> : null}
          </div>
        ) : null}
        <form className="composer" onSubmit={onSubmit} aria-label="Send a message">
          <div className="field">
            <label htmlFor="assistant-message">Message</label>
            <textarea id="assistant-message" rows={2} maxLength={assistant.limit} disabled={loading || assistant.readOnly}
              placeholder="What should I do this week?" value={assistant.draft}
              onChange={(event) => assistant.setDraft(event.target.value)} />
          </div>
          <button type="submit" className="button" disabled={!assistant.canSend} aria-busy={assistant.sending}>
            {assistant.sending ? 'Thinking…' : 'Send'}
          </button>
        </form>
        {view.activity.length ? (
          <details className="activity" open>
            <summary>Tool activity for the last reply</summary>
            <ol>
              {view.activity.map((item, index) => (
                <li key={item.tool_call_id + index} className={item.ok ? 'activity__item' : 'activity__item activity__item--failed'}>
                  <strong>{item.tool}</strong> <span>{item.detail}</span> <code>{item.tool_call_id}</code>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </section>

      <aside className="assistant__side">
        {view.proposals.length ? (
          <section className="panel" aria-label="Waiting for your approval">
            <p className="section-title">Waiting for your approval</p>
            <ul className="proposals">
              {view.proposals.map((proposal) => (
                <li key={proposal.id} className="proposal">
                  <span className="proposal__title">{proposal.title}</span>
                  <span className="actions">
                    <button type="button" className="button" disabled={assistant.deciding !== null || assistant.readOnly}
                      aria-busy={assistant.deciding === proposal.id} onClick={() => void assistant.decide(proposal.id, 'approve')}>Approve</button>
                    <button type="button" className="button button--quiet" disabled={assistant.deciding !== null || assistant.readOnly}
                      onClick={() => void assistant.decide(proposal.id, 'reject')}>Reject</button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="panel" aria-label="Your tasks">
          <p className="section-title">Your tasks</p>
          {view.status === 'ready' && view.tasks.length === 0 ? <p className="muted">No tasks yet.</p> : null}
          <ul className="agent-tasks">
            {view.tasks.map((task) => <li key={task.id}>{task.title}</li>)}
          </ul>
        </section>
      </aside>
    </div>
  );
}
`;

const PLAIN_ASSISTANT_PANEL = `import type { FormEvent } from 'react';
import type { AssistantController } from '../../types/assistant';

export function AssistantPanel({ assistant }: { assistant: AssistantController }) {
  const { view } = assistant;
  const loading = view.status === 'loading';
  const locked = assistant.deciding !== null || assistant.readOnly;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void assistant.send();
  }

  return (
    <div data-status={view.status}>
      <section aria-label="Conversation">
        <h2>Assistant</h2>
        <p>It reads your tasks and drafts new ones. Nothing is added until you approve it.</p>
        {loading ? <p role="status">Loading your conversation…</p> : null}
        {view.status === 'ready' && view.messages.length === 0 ? <p>No messages yet.</p> : null}
        <ol>
          {view.messages.map((message, index) => (
            <li key={index} data-role="message"><strong>{message.role === 'user' ? 'You' : 'Assistant'}:</strong> {message.text}</li>
          ))}
        </ol>
        {view.error ? (
          <div role="alert">
            <p>{view.error}</p>
            {view.status === 'error' ? <button type="button" onClick={assistant.reload}>Try again</button> : null}
          </div>
        ) : null}
        <form onSubmit={onSubmit} aria-label="Send a message">
          <label htmlFor="assistant-message">Message</label>
          <textarea id="assistant-message" rows={2} maxLength={assistant.limit} disabled={loading || assistant.readOnly}
            value={assistant.draft} onChange={(event) => assistant.setDraft(event.target.value)} />
          <button type="submit" disabled={!assistant.canSend} aria-busy={assistant.sending}>{assistant.sending ? 'Thinking…' : 'Send'}</button>
        </form>
        {view.activity.length ? (
          <details open>
            <summary>Tool activity for the last reply</summary>
            <ol>
              {view.activity.map((item, index) => (
                <li key={item.tool_call_id + index}>{item.tool} {item.ok ? 'ok' : 'failed'}: {item.detail} ({item.tool_call_id})</li>
              ))}
            </ol>
          </details>
        ) : null}
      </section>
      {view.proposals.length ? (
        <section aria-label="Waiting for your approval">
          <h2>Waiting for your approval</h2>
          <ul>
            {view.proposals.map((proposal) => (
              <li key={proposal.id}>
                {proposal.title}{' '}
                <button type="button" disabled={locked} onClick={() => void assistant.decide(proposal.id, 'approve')}>Approve</button>{' '}
                <button type="button" disabled={locked} onClick={() => void assistant.decide(proposal.id, 'reject')}>Reject</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Your tasks">
        <h2>Your tasks</h2>
        {view.status === 'ready' && view.tasks.length === 0 ? <p>No tasks yet.</p> : null}
        <ul>{view.tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>
      </section>
    </div>
  );
}
`;

// ---------------------------------------------------------------------- pages
// One set of pages for both UI modes: hooks in, typed values and callbacks out.

const SIGN_IN_PAGE = `import { useCredentialsForm, useUnconfirmedSignOut } from '../auth/hooks';
import { APP_NAME } from '../config';
import { AuthCard } from '../ui/AuthCard';
import { SignOutUnconfirmed } from '../ui/feedback';

export function SignInPage() {
  const form = useCredentialsForm();
  const unconfirmed = useUnconfirmedSignOut();
  return (
    <>
      {unconfirmed ? <SignOutUnconfirmed pending={unconfirmed.pending} onRetry={unconfirmed.retry} /> : null}
      <AuthCard appName={APP_NAME} form={form} />
    </>
  );
}
`;

const SIGNED_IN_LAYOUT = `import type { ReactNode } from 'react';
import type { User } from '../../types/auth';
import { useSignOut } from '../auth/hooks';
import { APP_NAME } from '../config';
import { linkTo, ROUTES } from '../routes';
import { AppShell } from '../ui/AppShell';

/** The frame every signed-in page shares. */
export function SignedInLayout({ user, children }: { user: User; children: ReactNode }) {
  const signOut = useSignOut();
  return (
    <AppShell
      appName={APP_NAME}
      homeLink={linkTo(ROUTES.home)}
      account={{
        label: user.email ?? 'Signed in',
        onSignOut: () => void signOut.signOut(),
        signingOut: signOut.pending,
        error: signOut.error,
      }}
    >
      {children}
    </AppShell>
  );
}
`;

function homePage(privateData: boolean, agent: boolean): string {
  if (agent) {
    const notes = privateData;
    return `import type { User } from '../../types/auth';
import { useAssistant } from '../data/useAssistant';
${notes ? "import { useNotes } from '../data/useNotes';\n" : ''}import { AssistantPanel } from '../ui/AssistantPanel';
${notes ? "import { NotesBoard } from '../ui/NotesBoard';\n" : ''}import { SignedInLayout } from './SignedInLayout';

// The assistant example is removable: delete it here, AssistantPanel,
// useAssistant, services/assistant.ts, types/assistant.ts, src/fixtures/,
// AssistantFixturesPage, the /fixtures branch in main.tsx, api/chat.ts,
// api/proposals.ts and the tasks/proposals tables in db/schema.ts.
export function HomePage({ user }: { user: User }) {
  const assistant = useAssistant();
${notes ? '  const notes = useNotes();\n' : ''}  return (
    <SignedInLayout user={user}>
${notes ? '      <NotesBoard notes={notes} />\n' : ''}      <AssistantPanel assistant={assistant} />
    </SignedInLayout>
  );
}
`;
  }
  if (privateData) {
    return `import type { User } from '../../types/auth';
import { useNotes } from '../data/useNotes';
import { NotesBoard } from '../ui/NotesBoard';
import { SignedInLayout } from './SignedInLayout';

// The notes example is removable: delete this page's body, NotesBoard,
// useNotes, services/notes.ts, types/notes.ts and the table in db/schema.ts.
export function HomePage({ user }: { user: User }) {
  const notes = useNotes();
  return (
    <SignedInLayout user={user}>
      <NotesBoard notes={notes} />
    </SignedInLayout>
  );
}
`;
  }
  return `import type { User } from '../../types/auth';
import { EmptyState } from '../ui/feedback';
import { SignedInLayout } from './SignedInLayout';

// Your app starts here.
export function HomePage({ user }: { user: User }) {
  return (
    <SignedInLayout user={user}>
      <EmptyState title="You're signed in.">
        Build your app in src/pages/HomePage.tsx.
      </EmptyState>
    </SignedInLayout>
  );
}
`;
}

const NOT_FOUND_PAGE = `import type { User } from '../../types/auth';
import { linkTo, ROUTES } from '../routes';
import { EmptyState } from '../ui/feedback';
import { SignedInLayout } from './SignedInLayout';

export function NotFoundPage({ user }: { user: User }) {
  return (
    <SignedInLayout user={user}>
      <EmptyState title="Page not found.">
        <a {...linkTo(ROUTES.home)}>Go home</a>
      </EmptyState>
    </SignedInLayout>
  );
}
`;

// ------------------------------------------------------------ styled views
// Presentational: props in, markup out. No SDK, service or network calls.

const STYLED_FEEDBACK = `import type { ReactNode } from 'react';

export function LoadingScreen({ label }: { label: string }) {
  return (
    <main className="loading" aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      <p role="status">{label}</p>
    </main>
  );
}

export function Alert({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="alert" role="alert">
      <p>{children}</p>
      {action}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children ? <p className="empty__body">{children}</p> : null}
    </div>
  );
}

interface SessionUnavailableProps {
  keepsWork: boolean;
  retrying: boolean;
  onRetry(): void;
}

export function SignOutUnconfirmed({ pending, onRetry }: { pending: boolean; onRetry(): void }) {
  return (
    <div className="banner" role="alert">
      <p>We couldn't confirm sign-out with the server, so your session there may still be active.</p>
      <button type="button" className="button button--quiet" onClick={onRetry} disabled={pending} aria-busy={pending}>
        {pending ? 'Signing out…' : 'Sign out again'}
      </button>
    </div>
  );
}

export function SessionUnavailable({ keepsWork, retrying, onRetry }: SessionUnavailableProps) {
  return (
    <main className="loading">
      <div className="panel unavailable" role="alert">
        <p className="panel__title">We can't confirm your sign-in</p>
        <p className="muted">
          The server didn't answer. Check your connection and try again.
          {keepsWork ? ' Your unsaved changes are kept.' : ''}
        </p>
        <button type="button" className="button" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
          {retrying ? 'Trying…' : 'Try again'}
        </button>
      </div>
    </main>
  );
}
`;

const STYLED_AUTH_CARD = `import type { FormEvent } from 'react';
import type { CredentialsForm } from '../../types/auth';

export function AuthCard({ appName, form }: { appName: string; form: CredentialsForm }) {
  const signUp = form.mode === 'sign-up';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void form.submit();
  }

  return (
    <main className="auth">
      <div className="auth__intro">
        <p className="auth__app">{appName}</p>
        <h1 className="auth__title">{signUp ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted">{signUp ? 'It takes a few seconds.' : 'Sign in to continue.'}</p>
      </div>
      <form className="panel auth__form" onSubmit={onSubmit} noValidate aria-label={signUp ? 'Create account' : 'Sign in'}>
        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" type="email" name="email" autoComplete="email" inputMode="email" required autoFocus
            value={form.email} onChange={(event) => form.setEmail(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" name="password" required
            autoComplete={signUp ? 'new-password' : 'current-password'}
            minLength={signUp ? form.passwordMinLength : undefined}
            aria-describedby={signUp ? 'auth-password-hint' : undefined}
            value={form.password} onChange={(event) => form.setPassword(event.target.value)} />
          {signUp ? <p id="auth-password-hint" className="hint">At least {form.passwordMinLength} characters.</p> : null}
        </div>
        {form.error ? <p className="error" role="alert">{form.error}</p> : null}
        <button type="submit" className="button" disabled={!form.canSubmit} aria-busy={form.pending}>
          {form.pending ? 'Please wait…' : signUp ? 'Create account' : 'Sign in'}
        </button>
        <p className="auth__switch">
          {signUp ? 'Already have an account?' : 'New here?'}{' '}
          <button type="button" className="link-button" onClick={form.toggleMode} disabled={form.pending}>
            {signUp ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </form>
    </main>
  );
}
`;

const STYLED_APP_SHELL = `import type { ReactNode } from 'react';
import type { LinkProps } from '../routes';

export interface AccountSummary {
  label: string;
  onSignOut(): void;
  signingOut: boolean;
  error: string | null;
}

interface AppShellProps {
  appName: string;
  homeLink: LinkProps;
  account: AccountSummary;
  children: ReactNode;
}

export function AppShell({ appName, homeLink, account, children }: AppShellProps) {
  return (
    <div className="shell">
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="topbar">
        <a className="brand" {...homeLink}>{appName}</a>
        <div className="account">
          <span className="account__label" title={account.label}>{account.label}</span>
          <button type="button" className="button button--quiet" onClick={account.onSignOut} disabled={account.signingOut}>
            {account.signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>
      {account.error ? <p className="error topbar__error" role="alert">{account.error}</p> : null}
      <main id="content" className="content" tabIndex={-1}>{children}</main>
    </div>
  );
}
`;

const STYLED_NOTES_BOARD = `import type { FormEvent } from 'react';
import type { NotesController } from '../../types/notes';
import { Alert, EmptyState } from './feedback';

export function NotesBoard({ notes }: { notes: NotesController }) {
  const { draft, draftErrors, limits } = notes;
  const editing = notes.editingId !== null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void notes.save();
  }

  return (
    <div className="notes-board">
      <form className="panel" onSubmit={onSubmit} noValidate aria-labelledby="note-form-title">
        <h1 id="note-form-title" className="panel__title">{editing ? 'Edit note' : 'New note'}</h1>
        <div className="field">
          <label htmlFor="note-title">Title</label>
          <input id="note-title" name="title" required value={draft.title}
            aria-invalid={draftErrors.title ? true : undefined}
            aria-describedby={draftErrors.title ? 'note-title-error' : undefined}
            onChange={(event) => notes.setDraft({ ...draft, title: event.target.value })} />
          {draftErrors.title ? <p id="note-title-error" className="error">{draftErrors.title}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="note-body">Note <span className="hint">{draft.body.length}/{limits.body}</span></label>
          <textarea id="note-body" name="body" rows={4} value={draft.body}
            aria-invalid={draftErrors.body ? true : undefined}
            aria-describedby={draftErrors.body ? 'note-body-error' : undefined}
            onChange={(event) => notes.setDraft({ ...draft, body: event.target.value })} />
          {draftErrors.body ? <p id="note-body-error" className="error">{draftErrors.body}</p> : null}
        </div>
        <div className="actions">
          <button type="submit" className="button" disabled={!notes.canSave} aria-busy={notes.saving}>
            {notes.saving ? 'Saving…' : editing ? 'Save changes' : 'Add note'}
          </button>
          {editing ? <button type="button" className="button button--quiet" onClick={notes.cancelEdit} disabled={notes.saving}>Cancel</button> : null}
        </div>
        <p className={notes.notice?.tone === 'error' ? 'notice error' : 'notice'} role="status">{notes.notice?.text ?? ''}</p>
      </form>

      <section aria-labelledby="notes-title" aria-busy={notes.status === 'loading'}>
        <h2 id="notes-title" className="section-title">Your notes</h2>
        {notes.status === 'loading' ? <p className="muted" role="status">Loading notes…</p> : null}
        {notes.status === 'error' ? (
          <Alert action={<button type="button" className="button button--quiet" onClick={notes.reload}>Try again</button>}>
            {notes.loadError}
          </Alert>
        ) : null}
        {notes.status === 'ready' && notes.notes.length === 0 ? (
          <EmptyState title="No notes yet.">Only you can see the notes you add.</EmptyState>
        ) : null}
        {notes.status === 'ready' && notes.notes.length > 0 ? (
          <ul className="note-list">
            {notes.notes.map((note) => (
              <li key={note.id} className="note" aria-current={note.id === notes.editingId ? 'true' : undefined}>
                <div className="note__text">
                  <h3 className="note__title">{note.title}</h3>
                  {note.body ? <p className="note__body">{note.body}</p> : null}
                </div>
                <div className="note__actions">
                  <button type="button" className="link-button" onClick={() => notes.startEdit(note)} aria-label={'Edit ' + note.title}>Edit</button>
                  <button type="button" className="link-button link-button--danger" onClick={() => void notes.remove(note)}
                    disabled={notes.removingId === note.id} aria-label={'Delete ' + note.title}>
                    {notes.removingId === note.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {notes.truncated ? <p className="hint">Showing the first {notes.notes.length} notes.</p> : null}
      </section>
    </div>
  );
}
`;

// ------------------------------------------------------------- plain views
// --ui headless: the same exports and props as the styled views, as plain
// semantic markup with no CSS. Replace them with your own components.

const PLAIN_FEEDBACK = `import type { ReactNode } from 'react';

export function LoadingScreen({ label }: { label: string }) {
  return <main aria-busy="true"><p role="status">{label}</p></main>;
}

export function Alert({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div role="alert"><p>{children}</p>{action}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div><p><strong>{title}</strong></p>{children ? <p>{children}</p> : null}</div>;
}

interface SessionUnavailableProps {
  keepsWork: boolean;
  retrying: boolean;
  onRetry(): void;
}

export function SignOutUnconfirmed({ pending, onRetry }: { pending: boolean; onRetry(): void }) {
  return (
    <div role="alert">
      <p>We couldn't confirm sign-out with the server, so your session there may still be active.</p>
      <button type="button" onClick={onRetry} disabled={pending}>{pending ? 'Signing out…' : 'Sign out again'}</button>
    </div>
  );
}

export function SessionUnavailable({ keepsWork, retrying, onRetry }: SessionUnavailableProps) {
  return (
    <main role="alert">
      <p>We can't confirm your sign-in. Check your connection and try again.{keepsWork ? ' Your unsaved changes are kept.' : ''}</p>
      <button type="button" onClick={onRetry} disabled={retrying}>{retrying ? 'Trying…' : 'Try again'}</button>
    </main>
  );
}
`;

const PLAIN_AUTH_CARD = `import type { FormEvent } from 'react';
import type { CredentialsForm } from '../../types/auth';

export function AuthCard({ appName, form }: { appName: string; form: CredentialsForm }) {
  const signUp = form.mode === 'sign-up';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void form.submit();
  }

  return (
    <main>
      <h1>{signUp ? 'Create your account' : 'Sign in'} · {appName}</h1>
      <form onSubmit={onSubmit} noValidate>
        <p>
          <label htmlFor="auth-email">Email</label><br />
          <input id="auth-email" type="email" name="email" autoComplete="email" required autoFocus
            value={form.email} onChange={(event) => form.setEmail(event.target.value)} />
        </p>
        <p>
          <label htmlFor="auth-password">Password</label><br />
          <input id="auth-password" type="password" name="password" required
            autoComplete={signUp ? 'new-password' : 'current-password'}
            minLength={signUp ? form.passwordMinLength : undefined}
            value={form.password} onChange={(event) => form.setPassword(event.target.value)} />
        </p>
        {form.error ? <p role="alert">{form.error}</p> : null}
        <button type="submit" disabled={!form.canSubmit} aria-busy={form.pending}>
          {form.pending ? 'Please wait…' : signUp ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <p>
        <button type="button" onClick={form.toggleMode} disabled={form.pending}>
          {signUp ? 'Sign in' : 'Create an account'}
        </button>
      </p>
    </main>
  );
}
`;

const PLAIN_APP_SHELL = `import type { ReactNode } from 'react';
import type { LinkProps } from '../routes';

export interface AccountSummary {
  label: string;
  onSignOut(): void;
  signingOut: boolean;
  error: string | null;
}

interface AppShellProps {
  appName: string;
  homeLink: LinkProps;
  account: AccountSummary;
  children: ReactNode;
}

export function AppShell({ appName, homeLink, account, children }: AppShellProps) {
  return (
    <>
      <header>
        <a {...homeLink}>{appName}</a>{' '}
        <span>{account.label}</span>{' '}
        <button type="button" onClick={account.onSignOut} disabled={account.signingOut}>
          {account.signingOut ? 'Signing out…' : 'Sign out'}
        </button>
        {account.error ? <p role="alert">{account.error}</p> : null}
      </header>
      <main>{children}</main>
    </>
  );
}
`;

const PLAIN_NOTES_BOARD = `import type { FormEvent } from 'react';
import type { NotesController } from '../../types/notes';
import { Alert, EmptyState } from './feedback';

export function NotesBoard({ notes }: { notes: NotesController }) {
  const { draft, draftErrors } = notes;
  const editing = notes.editingId !== null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void notes.save();
  }

  return (
    <>
      <h1>{editing ? 'Edit note' : 'New note'}</h1>
      <form onSubmit={onSubmit} noValidate>
        <p>
          <label htmlFor="note-title">Title</label><br />
          <input id="note-title" name="title" required value={draft.title} aria-invalid={draftErrors.title ? true : undefined}
            onChange={(event) => notes.setDraft({ ...draft, title: event.target.value })} />
          {draftErrors.title ? <span role="alert"> {draftErrors.title}</span> : null}
        </p>
        <p>
          <label htmlFor="note-body">Note</label><br />
          <textarea id="note-body" name="body" value={draft.body} aria-invalid={draftErrors.body ? true : undefined}
            onChange={(event) => notes.setDraft({ ...draft, body: event.target.value })} />
          {draftErrors.body ? <span role="alert"> {draftErrors.body}</span> : null}
        </p>
        <button type="submit" disabled={!notes.canSave} aria-busy={notes.saving}>
          {notes.saving ? 'Saving…' : editing ? 'Save changes' : 'Add note'}
        </button>{' '}
        {editing ? <button type="button" onClick={notes.cancelEdit}>Cancel</button> : null}
        <p role="status">{notes.notice?.text ?? ''}</p>
      </form>
      <h2>Your notes</h2>
      {notes.status === 'loading' ? <p role="status">Loading notes…</p> : null}
      {notes.status === 'error' ? <Alert action={<button type="button" onClick={notes.reload}>Try again</button>}>{notes.loadError}</Alert> : null}
      {notes.status === 'ready' && notes.notes.length === 0 ? <EmptyState title="No notes yet." /> : null}
      <ul>
        {notes.notes.map((note) => (
          <li key={note.id}>
            <strong>{note.title}</strong> {note.body}{' '}
            <button type="button" onClick={() => notes.startEdit(note)} aria-label={'Edit ' + note.title}>Edit</button>{' '}
            <button type="button" onClick={() => void notes.remove(note)} disabled={notes.removingId === note.id} aria-label={'Delete ' + note.title}>Delete</button>
          </li>
        ))}
      </ul>
    </>
  );
}
`;

// --------------------------------------------------------------------- styles

const TOKENS_CSS = `/* Shared design values. app.css reads them; components and app.css can
   still override locally. Local font stacks only (no network fonts). */
:root {
  --font-body: "Avenir Next", "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", sans-serif;
  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;

  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.25rem;
  --text-display: clamp(2rem, 4.4vw, 3rem);

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;

  --radius-control: 8px;
  --radius-panel: 14px;

  --color-bg: #f5f3ee;
  --color-surface: #ffffff;
  --color-text: #1c1b18;
  --color-muted: #66615a;
  --color-border: #e0dbd1;
  --color-accent: #1d6b52;
  --color-on-accent: #ffffff;
  --color-danger: #b42318;
  --color-focus: #1d6b52;
}
`;

const APP_CSS = `*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  min-width: 320px;
  background: var(--color-bg);
  color: var(--color-text);
  font: 400 var(--text-base)/1.55 var(--font-body);
}
button, input, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }
.muted { color: var(--color-muted); }
.hint { margin: 0; color: var(--color-muted); font-size: var(--text-sm); font-weight: 400; }
.error { margin: 0; color: var(--color-danger); font-size: var(--text-sm); }
.skip-link { position: absolute; left: var(--space-3); top: -60px; padding: var(--space-2) var(--space-3); background: var(--color-text); color: var(--color-bg); }
.skip-link:focus { top: var(--space-3); }

.panel {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-6);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  box-shadow: 0 1px 2px rgba(28, 27, 24, 0.05), 0 16px 40px -28px rgba(28, 27, 24, 0.35);
}
.panel__title { margin: 0; font: 600 var(--text-lg)/1.2 var(--font-display); }

.field { display: grid; gap: 6px; }
.field label { display: flex; justify-content: space-between; font-size: var(--text-sm); font-weight: 600; }
.field input, .field textarea {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
}
.field textarea { resize: vertical; }
.field input:hover, .field textarea:hover { border-color: var(--color-muted); }
.field [aria-invalid="true"] { border-color: var(--color-danger); }

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 var(--space-4);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-control);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.button:hover:not(:disabled) { filter: brightness(1.08); }
.button:disabled { opacity: 0.5; cursor: not-allowed; }
.button--quiet { background: transparent; border-color: var(--color-border); color: var(--color-text); }
.link-button {
  min-height: 44px;
  padding: 0 var(--space-2);
  border: 0;
  background: none;
  color: var(--color-accent);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.link-button:disabled { opacity: 0.5; cursor: not-allowed; }
.link-button--danger { color: var(--color-danger); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }

/* Sign-in: split panel on wide screens, stacked on phones. */
.auth {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 400px);
  gap: var(--space-12);
  align-items: center;
  width: min(960px, calc(100% - 2 * var(--space-6)));
  min-height: 100vh;
  margin: 0 auto;
  padding: var(--space-12) 0;
}
.auth__app { margin: 0 0 var(--space-3); color: var(--color-accent); font-weight: 600; }
.auth__title { margin: 0 0 var(--space-3); font: 600 var(--text-display)/1.05 var(--font-display); letter-spacing: -0.02em; }
.auth__form .button { width: 100%; }
.auth__switch { margin: 0; text-align: center; color: var(--color-muted); font-size: var(--text-sm); }

.loading { display: grid; place-content: center; justify-items: center; gap: var(--space-3); min-height: 100vh; color: var(--color-muted); }
.unavailable { max-width: 380px; margin: 0 var(--space-4); color: var(--color-text); }
.unavailable p { margin: 0; }
.banner { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: center; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-danger); background: var(--color-surface); color: var(--color-danger); }
.banner p { margin: 0; }
.spinner { width: 24px; height: 24px; border: 3px solid var(--color-border); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Signed-in frame */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  width: min(1040px, calc(100% - 2 * var(--space-6)));
  margin: 0 auto;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--color-border);
}
.topbar__error { width: min(1040px, calc(100% - 2 * var(--space-6))); margin: var(--space-2) auto 0; }
.brand { font: 600 var(--text-lg)/1 var(--font-display); color: inherit; text-decoration: none; }
.account { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.account__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-size: var(--text-sm); }
.content { width: min(1040px, calc(100% - 2 * var(--space-6))); margin: 0 auto; padding: var(--space-8) 0 var(--space-12); outline: none; }

.empty { padding: var(--space-8) var(--space-6); border: 1px dashed var(--color-border); border-radius: var(--radius-panel); text-align: center; }
.empty__title { margin: 0; font: 600 var(--text-lg)/1.3 var(--font-display); }
.empty__body { margin: var(--space-2) 0 0; color: var(--color-muted); }

@media (max-width: 760px) {
  .auth { grid-template-columns: 1fr; gap: var(--space-6); align-content: start; }
}
@media (max-width: 480px) {
  .panel { padding: var(--space-4); }
}
@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 3s; }
}
`;

const NOTES_CSS = `/* Notes example: delete with src/ui/NotesBoard.tsx. */
.alert { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: space-between; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-danger); border-radius: var(--radius-control); color: var(--color-danger); background: var(--color-surface); }
.alert p { margin: 0; }
.notes-board { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); gap: var(--space-8); align-items: start; }
.notice { min-height: 1.4em; margin: 0; color: var(--color-muted); font-size: var(--text-sm); }
.section-title { margin: 0 0 var(--space-3); font-size: var(--text-sm); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-muted); }
.note-list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--color-border); }
.note { display: flex; gap: var(--space-4); justify-content: space-between; align-items: start; padding: var(--space-4) 0; border-bottom: 1px solid var(--color-border); }
.note[aria-current="true"] { box-shadow: inset 3px 0 0 var(--color-accent); padding-left: var(--space-3); }
.note__text { min-width: 0; }
.note__title { margin: 0; font: 600 var(--text-base)/1.35 var(--font-body); overflow-wrap: anywhere; }
.note__body { margin: var(--space-1) 0 0; color: var(--color-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.note__actions { display: flex; flex: none; }

@media (max-width: 760px) {
  .notes-board { grid-template-columns: 1fr; }
}
@media (max-width: 480px) {
  .note { flex-direction: column; gap: var(--space-1); }
  .note__actions { margin-left: calc(-1 * var(--space-2)); }
}
`;

// The notes CSS already defines these; the assistant adds them when notes is absent.
const ASSISTANT_SHARED_CSS = `.alert { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: space-between; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-danger); border-radius: var(--radius-control); color: var(--color-danger); background: var(--color-surface); }
.alert p { margin: 0; }
.section-title { margin: 0 0 var(--space-3); font-size: var(--text-sm); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-muted); }
`;

const ASSISTANT_CSS = `/* Assistant example: delete with src/ui/AssistantPanel.tsx. */
.assistant { display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); gap: var(--space-6); align-items: start; margin-top: var(--space-8); }
.assistant__side { display: grid; gap: var(--space-6); }
.transcript { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.message { max-width: 85%; padding: var(--space-2) var(--space-3); border-radius: var(--radius-control); white-space: pre-wrap; overflow-wrap: anywhere; }
.message--user { justify-self: end; background: var(--color-bg); }
.message--assistant { justify-self: start; border: 1px solid var(--color-border); }
.composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); align-items: end; }
.activity { color: var(--color-muted); font-size: var(--text-sm); }
.activity ol { margin: var(--space-2) 0 0; padding-left: var(--space-6); }
.activity code { overflow-wrap: anywhere; }
.activity__item--failed strong { color: var(--color-danger); }
.proposals, .agent-tasks { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.proposal { display: grid; gap: var(--space-2); }
.proposal__title, .agent-tasks li { overflow-wrap: anywhere; }
.agent-tasks li { padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-border); }

@media (max-width: 760px) {
  .assistant { grid-template-columns: 1fr; }
  .composer { grid-template-columns: 1fr; }
}
`;

// ----------------------------------------------------------------- magic-link

const MAGIC_LINK_TYPES = `/** The "email me a sign-in link" form on the sign-in page. */
export interface MagicLinkRequest {
  email: string;
  pending: boolean;
  /** The address the last link was sent to, until the email is edited. */
  sentTo: string | null;
  error: string | null;
  canSubmit: boolean;
  setEmail(value: string): void;
  submit(): Promise<void>;
}

/**
 * The /auth/magic page the emailed link opens. verifying: the one-time token
 * is being exchanged for the session. failed: it was missing, already used,
 * expired or revoked. On success the page leaves, so there is no third state.
 */
export type MagicLinkLanding =
  | { status: 'verifying' }
  | { status: 'failed'; error: string };
`;

const MAGIC_LINK_HOOKS = `import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@somewhere-tech/sdk/react';
import type { MagicLinkLanding, MagicLinkRequest } from '../../types/magic-link';
import { authErrorMessage } from '../services/auth';

// Sign-in links. The packaged route api/auth/[...path].ts sends the email
// (POST /api/auth/magic-link) and redeems it (/api/auth/magic-link/verify).
// The email opens /auth/magic?token=…; the token works once.

export function useMagicLinkRequest(): MagicLinkRequest {
  const auth = useAuth();
  const [email, setEmailValue] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = !pending && email.trim() !== '';

  async function submit() {
    if (!canSubmit) return;
    const address = email.trim();
    setPending(true);
    setError(null);
    try {
      await auth.sendMagicLink({ email: address });
      setSentTo(address);
    } catch (reason: unknown) {
      setError(authErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  return {
    email,
    pending,
    sentTo,
    error,
    canSubmit,
    setEmail(value) {
      setEmailValue(value);
      setSentTo(null);
    },
    submit,
  };
}

/**
 * Where to go after signing in: the link's redirect_uri when it is a page of
 * this app (an invitation link carries ?invite_id=… there), otherwise home.
 * Another origin is never followed.
 */
export function landingTarget(search: string, origin: string): string {
  const requested = new URLSearchParams(search).get('redirect_uri');
  if (!requested) return '/';
  try {
    const url = new URL(requested, origin);
    return url.origin === origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

export function useMagicLinkLanding(): MagicLinkLanding {
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // the token works once; never verify it twice
    started.current = true;
    const token = new URLSearchParams(window.location.search).get('token');
    const target = landingTarget(window.location.search, window.location.origin);
    if (!token) {
      setError('This sign-in link is incomplete. Request a new one.');
      return;
    }
    // Keep the one-time token out of the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
    auth.verifyMagicLink({ token })
      // A full load: the app starts again with the new session.
      .then(() => window.location.replace(target))
      .catch((reason: unknown) => setError(authErrorMessage(reason)));
  }, [auth]);

  return error === null ? { status: 'verifying' } : { status: 'failed', error };
}
`;

const MAGIC_LINK_PAGE = `import { useMagicLinkLanding } from '../auth/magic-link';
import { MagicLinkStatus } from '../ui/MagicLink';

// /auth/magic: the page the emailed sign-in or invitation link opens.
export function MagicLinkPage() {
  const landing = useMagicLinkLanding();
  return <MagicLinkStatus landing={landing} />;
}
`;

const MAGIC_SIGN_IN_PAGE = `import { useCredentialsForm, useUnconfirmedSignOut } from '../auth/hooks';
import { useMagicLinkRequest } from '../auth/magic-link';
import { APP_NAME } from '../config';
import { AuthCard } from '../ui/AuthCard';
import { SignOutUnconfirmed } from '../ui/feedback';
import { MagicLinkForm } from '../ui/MagicLink';

export function SignInPage() {
  const form = useCredentialsForm();
  const magicLink = useMagicLinkRequest();
  const unconfirmed = useUnconfirmedSignOut();
  return (
    <>
      {unconfirmed ? <SignOutUnconfirmed pending={unconfirmed.pending} onRetry={unconfirmed.retry} /> : null}
      <AuthCard appName={APP_NAME} form={form}>
        <MagicLinkForm request={magicLink} />
      </AuthCard>
    </>
  );
}
`;

const STYLED_MAGIC_LINK = `import type { FormEvent } from 'react';
import type { MagicLinkLanding, MagicLinkRequest } from '../../types/magic-link';

export function MagicLinkForm({ request }: { request: MagicLinkRequest }) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void request.submit();
  }
  return (
    <form className="panel auth__form" onSubmit={onSubmit} noValidate aria-label="Email me a sign-in link">
      <div className="field">
        <label htmlFor="magic-email">No password? Get a sign-in link</label>
        <input id="magic-email" type="email" name="email" autoComplete="email" inputMode="email" required
          value={request.email} onChange={(event) => request.setEmail(event.target.value)} />
      </div>
      {request.error ? <p className="error" role="alert">{request.error}</p> : null}
      {request.sentTo ? <p className="hint" role="status">Check {request.sentTo} for your sign-in link. It works once.</p> : null}
      <button type="submit" className="button button--quiet" disabled={!request.canSubmit} aria-busy={request.pending}>
        {request.pending ? 'Sending…' : 'Email me a sign-in link'}
      </button>
    </form>
  );
}

export function MagicLinkStatus({ landing }: { landing: MagicLinkLanding }) {
  if (landing.status === 'verifying') {
    return (
      <main className="loading" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        <p role="status">Signing you in…</p>
      </main>
    );
  }
  return (
    <main className="loading">
      <p className="error" role="alert">{landing.error}</p>
      <a href="/">Back to sign-in</a>
    </main>
  );
}
`;

const PLAIN_MAGIC_LINK = `import type { FormEvent } from 'react';
import type { MagicLinkLanding, MagicLinkRequest } from '../../types/magic-link';

export function MagicLinkForm({ request }: { request: MagicLinkRequest }) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void request.submit();
  }
  return (
    <form onSubmit={onSubmit} noValidate aria-label="Email me a sign-in link">
      <p>
        <label htmlFor="magic-email">No password? Get a sign-in link</label><br />
        <input id="magic-email" type="email" name="email" autoComplete="email" required
          value={request.email} onChange={(event) => request.setEmail(event.target.value)} />
      </p>
      {request.error ? <p role="alert">{request.error}</p> : null}
      {request.sentTo ? <p role="status">Check {request.sentTo} for your sign-in link. It works once.</p> : null}
      <button type="submit" disabled={!request.canSubmit} aria-busy={request.pending}>
        {request.pending ? 'Sending…' : 'Email me a sign-in link'}
      </button>
    </form>
  );
}

export function MagicLinkStatus({ landing }: { landing: MagicLinkLanding }) {
  if (landing.status === 'verifying') return <main aria-busy="true"><p role="status">Signing you in…</p></main>;
  return (
    <main>
      <p role="alert">{landing.error}</p>
      <a href="/">Back to sign-in</a>
    </main>
  );
}
`;

function replaceOnce(text: string, find: string, replacement: string): string {
  const at = text.indexOf(find);
  if (at === -1 || text.indexOf(find, at + 1) !== -1) throw new Error(`init template: expected one ${JSON.stringify(find)}`);
  return text.slice(0, at) + replacement + text.slice(at + find.length);
}

/** The sign-in card with room below its form for the sign-in-link form. */
function authCard(styled: boolean, magicLink: boolean): string {
  const card = styled ? STYLED_AUTH_CARD : PLAIN_AUTH_CARD;
  if (!magicLink) return card;
  let out = replaceOnce(card, "import type { FormEvent } from 'react';", "import type { FormEvent, ReactNode } from 'react';");
  out = replaceOnce(out, '{ appName, form }: { appName: string; form: CredentialsForm }',
    '{ appName, form, children }: { appName: string; form: CredentialsForm; children?: ReactNode }');
  if (styled) {
    out = replaceOnce(out, '      <form className="panel auth__form"', '      <div className="auth__column">\n      <form className="panel auth__form"');
    out = replaceOnce(out, '      </form>\n    </main>', '      </form>\n      {children}\n      </div>\n    </main>');
  } else {
    out = replaceOnce(out, '      </p>\n    </main>', '      </p>\n      {children}\n    </main>');
  }
  return out;
}

/** App.tsx with /auth/magic in front of the sign-in gate: the person is not
 *  signed in yet when the emailed sign-in or invitation link opens it. */
function appTsx(): string {
  let out = replaceOnce(APP, "import { HomePage } from './pages/HomePage';\n",
    "import { HomePage } from './pages/HomePage';\nimport { MagicLinkPage } from './pages/MagicLinkPage';\n");
  out = replaceOnce(out, '  const session = useAuthState();\n\n',
    "  const pathname = usePathname();\n  const session = useAuthState();\n\n  // An emailed sign-in or invitation link lands here before a session exists.\n  if (pathname === '/auth/magic') return <MagicLinkPage />;\n");
  return out;
}

/** Cut the text from `start` up to (not including) `end`; both must occur once. */
function cutBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to <= from || text.indexOf(start, from + 1) !== -1 || text.indexOf(end, to + 1) !== -1) {
    throw new Error(`init template: expected one ${JSON.stringify(start)} before one ${JSON.stringify(end)}`);
  }
  return text.slice(0, from) + text.slice(to);
}

// The plain auth starter keeps the /auth/magic landing (sign-in and
// invitation links open it, tsk_28753a0e) and leaves out only the
// "email me a sign-in link" form, which the magic-link module adds.
function magicLinkTypes(request: boolean): string {
  return request ? MAGIC_LINK_TYPES : cutBetween(MAGIC_LINK_TYPES, '/** The "email me a sign-in link" form', '/**\n * The /auth/magic page');
}

function magicLinkHooks(request: boolean): string {
  if (request) return MAGIC_LINK_HOOKS;
  let out = replaceOnce(MAGIC_LINK_HOOKS, "import type { MagicLinkLanding, MagicLinkRequest } from '../../types/magic-link';",
    "import type { MagicLinkLanding } from '../../types/magic-link';");
  out = replaceOnce(out, '// Sign-in links. The packaged route api/auth/[...path].ts sends the email\n// (POST /api/auth/magic-link) and redeems it (/api/auth/magic-link/verify).\n',
    '// Sign-in and invitation links. The packaged route api/auth/[...path].ts\n// redeems them (/api/auth/magic-link/verify).\n');
  return cutBetween(out, 'export function useMagicLinkRequest', '/**\n * Where to go after signing in');
}

function magicLinkViews(styled: boolean, request: boolean): string {
  const views = styled ? STYLED_MAGIC_LINK : PLAIN_MAGIC_LINK;
  if (request) return views;
  let out = replaceOnce(views, "import type { FormEvent } from 'react';\n", '');
  out = replaceOnce(out, "import type { MagicLinkLanding, MagicLinkRequest } from '../../types/magic-link';",
    "import type { MagicLinkLanding } from '../../types/magic-link';");
  return cutBetween(out, 'export function MagicLinkForm', 'export function MagicLinkStatus');
}

const MAGIC_LINK_CSS = `/* Sign-in links: delete with src/ui/MagicLink.tsx. */
.auth__column { display: grid; gap: var(--space-4); }
`;

// --------------------------------------------------------------- verify-email

const VERIFY_EMAIL_HOOK = `import { useEffect, useState } from 'react';
import { useAuth } from '@somewhere-tech/sdk/react';
import type { EmailVerification } from '../../types/auth';
import { authErrorMessage } from '../services/auth';

// Email verification for the signed-in account, through the packaged route
// api/auth/[...path].ts (GET/POST /api/auth/verify-email and
// POST /api/auth/request-email-verification). The session cookie decides the
// account; this page never holds a token. Accounts that signed in with a link
// are already verified, so they never see the panel.
export function useEmailVerification(): EmailVerification {
  const auth = useAuth();
  const [status, setStatus] = useState<EmailVerification['status']>('checking');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setStatus('checking');
    auth.emailVerified()
      .then((verified) => { if (current) setStatus(verified ? 'verified' : 'unverified'); })
      .catch(() => { if (current) setStatus('unavailable'); });
    return () => { current = false; };
  }, [auth, attempt]);

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (reason: unknown) {
      setError(authErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  return {
    status,
    code,
    sent,
    pending,
    error,
    canSubmit: !pending && /^[0-9]{6}$/.test(code.trim()),
    setCode,
    sendCode: () => run(async () => { await auth.requestEmailVerification(); setSent(true); }),
    submit: () => run(async () => { await auth.verifyEmail({ code: code.trim() }); setStatus('verified'); }),
    retry: () => setAttempt((value) => value + 1),
  };
}
`;

const STYLED_VERIFY_EMAIL = `import type { FormEvent } from 'react';
import type { EmailVerification } from '../../types/auth';

export function VerifyEmailPanel({ verification }: { verification: EmailVerification }) {
  if (verification.status === 'checking' || verification.status === 'verified') return null;
  if (verification.status === 'unavailable') {
    return (
      <div className="banner" role="alert">
        <p>Could not check whether your email is verified.</p>
        <button type="button" className="button button--quiet" onClick={verification.retry}>Try again</button>
      </div>
    );
  }
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verification.submit();
  }
  return (
    <section className="panel verify-email" aria-label="Verify your email">
      <p><strong>Verify your email.</strong> {verification.sent ? 'Enter the 6-digit code we emailed you.' : 'We will email you a 6-digit code.'}</p>
      {verification.sent ? (
        <form className="verify-email__form" onSubmit={onSubmit} noValidate>
          <label htmlFor="verify-code">Code</label>
          <input id="verify-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
            value={verification.code} onChange={(event) => verification.setCode(event.target.value)} />
          <button type="submit" className="button" disabled={!verification.canSubmit} aria-busy={verification.pending}>Verify</button>
          <button type="button" className="link-button" onClick={() => void verification.sendCode()} disabled={verification.pending}>Send a new code</button>
        </form>
      ) : (
        <button type="button" className="button" onClick={() => void verification.sendCode()} disabled={verification.pending} aria-busy={verification.pending}>
          Email me a code
        </button>
      )}
      {verification.error ? <p className="error" role="alert">{verification.error}</p> : null}
    </section>
  );
}
`;

const PLAIN_VERIFY_EMAIL = `import type { FormEvent } from 'react';
import type { EmailVerification } from '../../types/auth';

export function VerifyEmailPanel({ verification }: { verification: EmailVerification }) {
  if (verification.status === 'checking' || verification.status === 'verified') return null;
  if (verification.status === 'unavailable') {
    return (
      <p role="alert">
        Could not check whether your email is verified. <button type="button" onClick={verification.retry}>Try again</button>
      </p>
    );
  }
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verification.submit();
  }
  return (
    <section aria-label="Verify your email">
      <p>Verify your email. {verification.sent ? 'Enter the 6-digit code we emailed you.' : 'We will email you a 6-digit code.'}</p>
      {verification.sent ? (
        <form onSubmit={onSubmit} noValidate>
          <label htmlFor="verify-code">Code</label>{' '}
          <input id="verify-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
            value={verification.code} onChange={(event) => verification.setCode(event.target.value)} />{' '}
          <button type="submit" disabled={!verification.canSubmit} aria-busy={verification.pending}>Verify</button>{' '}
          <button type="button" onClick={() => void verification.sendCode()} disabled={verification.pending}>Send a new code</button>
        </form>
      ) : (
        <button type="button" onClick={() => void verification.sendCode()} disabled={verification.pending} aria-busy={verification.pending}>
          Email me a code
        </button>
      )}
      {verification.error ? <p role="alert">{verification.error}</p> : null}
    </section>
  );
}
`;

const VERIFY_EMAIL_CSS = `/* Email verification panel (src/ui/VerifyEmail.tsx). */
.verify-email { display: grid; gap: var(--space-3); margin-bottom: var(--space-6); }
.verify-email p { margin: 0; }
.verify-email__form { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.verify-email__form input { width: 8ch; letter-spacing: 0.2em; }
`;

/** The signed-in frame, with the verify-email panel above every page. */
function signedInLayout(): string {
  let out = replaceOnce(SIGNED_IN_LAYOUT, "import { useSignOut } from '../auth/hooks';\n",
    "import { useSignOut } from '../auth/hooks';\nimport { useEmailVerification } from '../auth/useEmailVerification';\n");
  out = replaceOnce(out, "import { AppShell } from '../ui/AppShell';\n", "import { AppShell } from '../ui/AppShell';\nimport { VerifyEmailPanel } from '../ui/VerifyEmail';\n");
  out = replaceOnce(out, '  const signOut = useSignOut();\n', '  const signOut = useSignOut();\n  const verification = useEmailVerification();\n');
  out = replaceOnce(out, '      {children}\n', '      <VerifyEmailPanel verification={verification} />\n      {children}\n');
  return out;
}

// --------------------------------------------------------------------- readme

function readme(selection: InitSelection): string {
  const styled = selection.ui === 'styled';
  const privateData = selection.modules.includes('private-data');
  const agent = selection.modules.includes('agent');
  const magicLink = selection.modules.includes('magic-link');
  const lines = [
    '# somewhere.tech app',
    '',
    '## Where things go',
    '',
    '- Your app: `src/pages/HomePage.tsx`. Add a page: a path in `src/routes.ts`, a case in `src/App.tsx`, a file in `src/pages/`.',
    styled
      ? '- Look: `src/styles/tokens.css` (shared values), `src/styles/app.css`, and the views in `src/ui/`. Views take props only; rewrite or replace them freely.'
      : '- Look: `src/ui/` holds plain semantic views. Replace them with your own components; keep their props, or change the pages that pass them.',
    '- Sign-in: `src/auth/hooks.ts` (state and actions) over the SDK client in `src/services/auth.ts` and the SDK route `api/auth/[...path].ts`. Email verification: `src/auth/useEmailVerification.ts` and `src/ui/VerifyEmail.tsx`.',
  ];
  lines.push(magicLink
    ? '- Sign-in links: `src/auth/magic-link.ts` (send and redeem), `src/pages/MagicLinkPage.tsx` (the `/auth/magic` page the email opens), `src/ui/MagicLink.tsx` (views).'
    : '- Sign-in and invitation links: `src/auth/magic-link.ts` (redeem), `src/pages/MagicLinkPage.tsx` (the `/auth/magic` page the email opens), `src/ui/MagicLink.tsx` (view).');
  if (privateData) {
    lines.push('- Data: `db/schema.ts` (tables and browser permissions), `src/services/notes.ts` (calls), `src/data/useNotes.ts` (state). The notes example is removable.');
  }
  if (agent) {
    lines.push('- Assistant: `api/chat.ts` (the agent run and its tools), `api/proposals.ts` (approve/reject), `src/services/assistant.ts`, `src/data/useAssistant.ts`, `src/ui/AssistantPanel.tsx`. Preview states: `src/fixtures/assistant.ts`.');
  }
  lines.push(
    '',
    '## Auth',
    '',
    'Auth is handled by `@somewhere-tech/sdk`. The session is an httpOnly cookie;',
    'app code does not store or send a token. `src/App.tsx` shows private pages only',
    'for an account the server confirmed: a loading screen until the first check',
    'answers, and a "try again" screen when the server cannot be reached (pages',
    'already open stay mounted but hidden, so unsaved input survives). Signing out',
    'clears private pages at once and shows "Signing out…" until the server answers;',
    'if it cannot confirm, the sign-in page says so and offers "Sign out again". The gate is',
    'only UX: functions and `db/schema.ts` decide what a request may read or write.',
    'A password account sees a "Verify your email" panel until it enters the 6-digit',
    'code the platform emails it (`auth.requestEmailVerification` / `auth.verifyEmail`',
    'through the same SDK route; the session cookie decides the account).',
    'Password reset, OAuth and MFA are not generated.',
    '',
    '## Sign-in and invitation links',
    '',
    'An emailed link opens `/auth/magic?token=…`, which `src/App.tsx` routes in front',
    'of the sign-in gate. The page exchanges the one-time token for the same cookie',
    'session (`auth.verifyMagicLink`, once per page load; a failure is shown, never',
    'retried) and then opens the link\'s `redirect_uri` when it is a page of this app,',
    'otherwise `/`. Invitations from `sw.auth.invite` (including group invitations)',
    'land here; redeeming one signs the invitee in and accepts the invitation.',
  );
  if (magicLink) {
    lines.push(
      '',
      'The sign-in page also emails a one-time sign-in link (`auth.sendMagicLink`).',
      'The first link creates the account. The email shows the project name: create',
      'the project with `somewhere init --name "Your App" --subdomain your-app`.',
      'Test it with `<name>@<subdomain>.test.somewhere.site`, then',
      '`somewhere email test-inbox <address>` prints the link. `somewhere docs sw.auth`',
    );
  }
  if (privateData) {
    lines.push(
      '',
      '## Private data',
      '',
      '`db/schema.ts` declares `notes` with `owner()`, so the generated `somewhere:data`',
      'client returns and changes only the signed-in user\'s rows; the browser code',
      'sends no user filter. Functions you add can bypass this with explicit',
      'server-authority calls and must check the caller themselves. The title/body',
      'length limits are form checks only. Contract: `somewhere docs declared-data`.',
    );
  }
  if (agent) {
    lines.push(
      '',
      '## Assistant',
      '',
      '`api/chat.ts` runs `sw.agent.run` inline inside the request: no agent id, nothing',
      'to cancel, no streaming. The reply and its tool activity arrive together.',
      '',
      '- Reads: `list_tasks` uses `sw.db.from`. `tasks` and `proposals` are `owner()`,',
      '  so every structured call is scoped to the person who sent the message. Keep',
      '  tools on these calls; do not switch them to server-authority reads.',
      '- Effects need a person. `propose_task` only inserts a pending proposal.',
      '  `POST /api/proposals` writes the task after the owner clicks Approve; its',
      '  guarded update makes a double click, a second tab or another user\'s id a',
      '  409 that writes nothing.',
      '- Approval and task creation are two writes, not one transaction. The approval',
      '  is claimed first and never reopened. If the task write fails or its outcome',
      '  is unknown, the answer is 500 `TASK_CREATION_UNCONFIRMED`: refresh the task',
      '  list, and if the task is missing ask the assistant to propose it again.',
      '- `toolCallId` is a dedupe key, not exactly-once. Proposals are unique on it,',
      '  so the same call id twice leaves one row. Inline it is the model\'s tool-use',
      '  id; durable runs use `agentId:turn:index`.',
      '- Spend is bounded, not priced in advance: `maxSteps: 4`, `maxSpendCents: 10`,',
      '  checked between billed calls, so one call can cross it. Then the turn answers',
      '  402 `AI_SPEND_CAP_EXCEEDED` and lists the tools that already ran. A step whose',
      '  cost is unknown ends with `completion_reason: \'cost_pending\'`; the page shows',
      '  every reason other than `model_done`.',
      '- History is saved by the platform under `conversation_id: \'assistant\'`, keyed',
      '  to the verified user. `GET /api/chat` reads it back.',
      '- No `model` is set, so the run uses the `sw.ai.chat` default; add `provider`',
      '  and `model` from `ai_catalog` to choose another.',
      '',
      'Making it durable (`sw.agent.start`, `sw.agent.cancel`) is a separate design:',
      'step callbacks run without the original request, so the owner-scoped tools',
      'above would have no signed-in user. Cancel stops later steps; it does not undo',
      'a tool that already ran. `somewhere docs sw.agent`',
      '',
      '### Preview states',
      '',
      '`/fixtures?state=loading|empty|error|populated|long` draws the real panel from',
      '`src/fixtures/assistant.ts`. `src/main.tsx` mounts it outside the sign-in',
      'provider, so it sends no request and reads or writes nothing; controls are',
      'disabled. `somewhere verify --url <app-url> --flow flows/assistant-fixtures.json`',
      'screenshots each state on desktop and mobile. It reports page errors; it does',
      'not map them to a line in `src/`. Fixtures render your own source; they are',
      'not a sandbox for code you did not write.',
    );
  }
  lines.push(
    '',
    '## Run',
    '',
    '```sh',
    'somewhere typecheck',
    'somewhere deploy',
    'somewhere verify',
    '```',
    '',
    'Deploy the raw source; the platform compiles it.',
    '',
  );
  return lines.join('\n');
}

/** Where to build, restyle, route and change data, for the init report. */
export function extensionPoints(selection: InitSelection): Record<string, string> {
  const points: Record<string, string> = {
    app: 'src/pages/HomePage.tsx',
    routes: 'src/routes.ts + src/App.tsx',
    look: selection.ui === 'styled' ? 'src/styles/tokens.css, src/styles/app.css, src/ui/' : 'src/ui/',
    auth: 'src/auth/hooks.ts',
  };
  points.magic_link = 'src/auth/magic-link.ts, src/pages/MagicLinkPage.tsx';
  if (selection.modules.includes('private-data')) points.data = 'db/schema.ts, src/services/notes.ts, src/data/useNotes.ts';
  if (selection.modules.includes('agent')) points.assistant = 'api/chat.ts, api/proposals.ts, src/data/useAssistant.ts, src/fixtures/assistant.ts';
  return points;
}

// ---------------------------------------------------------------------- build

export function createFeatureTemplate(
  selection: InitSelection,
  options: FeatureTemplateOptions,
): InitScaffoldFile[] {
  const styled = selection.ui === 'styled';
  const privateData = selection.modules.includes('private-data');
  const agent = selection.modules.includes('agent');
  const magicLink = selection.modules.includes('magic-link');
  const files: InitScaffoldFile[] = [
    { path: '.gitignore', content: 'node_modules\ndist\nbuild\n.env\n' },
    { path: 'AGENTS.md', content: INIT_AGENTS_MD },
    { path: 'CLAUDE.md', content: INIT_CLAUDE_MD },
    { path: 'README.md', content: readme(selection) },
    { path: 'package.json', content: PACKAGE_JSON },
    { path: 'tsconfig.json', content: TSCONFIG },
    { path: 'index.html', content: indexHtml(options.appName) },
    { path: 'api/auth/[...path].ts', content: AUTH_API },
    { path: 'types/auth.ts', content: AUTH_TYPES },
    { path: 'src/main.tsx', content: mainTsx(styled, agent) },
    { path: 'src/App.tsx', content: appTsx() },
    { path: 'src/config.ts', content: configTs(options.appName) },
    { path: 'src/routes.ts', content: ROUTES },
    { path: 'src/services/auth.ts', content: AUTH_SERVICE },
    { path: 'src/auth/hooks.ts', content: AUTH_HOOKS },
    { path: 'src/pages/SignInPage.tsx', content: magicLink ? MAGIC_SIGN_IN_PAGE : SIGN_IN_PAGE },
    { path: 'src/pages/SignedInLayout.tsx', content: signedInLayout() },
    { path: 'src/auth/useEmailVerification.ts', content: VERIFY_EMAIL_HOOK },
    { path: 'src/ui/VerifyEmail.tsx', content: styled ? STYLED_VERIFY_EMAIL : PLAIN_VERIFY_EMAIL },
    { path: 'src/pages/HomePage.tsx', content: homePage(privateData, agent) },
    { path: 'src/pages/NotFoundPage.tsx', content: NOT_FOUND_PAGE },
    { path: 'src/ui/feedback.tsx', content: styled ? STYLED_FEEDBACK : PLAIN_FEEDBACK },
    { path: 'src/ui/AuthCard.tsx', content: authCard(styled, magicLink) },
    { path: 'src/ui/AppShell.tsx', content: styled ? STYLED_APP_SHELL : PLAIN_APP_SHELL },
    { path: 'types/magic-link.ts', content: magicLinkTypes(magicLink) },
    { path: 'src/auth/magic-link.ts', content: magicLinkHooks(magicLink) },
    { path: 'src/pages/MagicLinkPage.tsx', content: MAGIC_LINK_PAGE },
    { path: 'src/ui/MagicLink.tsx', content: magicLinkViews(styled, magicLink) },
  ];
  if (styled) {
    files.push(
      { path: 'src/styles/tokens.css', content: TOKENS_CSS },
      { path: 'src/styles/app.css', content: [APP_CSS, VERIFY_EMAIL_CSS, ...(magicLink ? [MAGIC_LINK_CSS] : []), ...(privateData ? [NOTES_CSS] : []), ...(agent ? [privateData ? ASSISTANT_CSS : ASSISTANT_SHARED_CSS + ASSISTANT_CSS] : [])].join('\n') },
    );
  }
  if (privateData || agent) files.push({ path: 'db/schema.ts', content: schemaTs(privateData, agent) });
  if (privateData) {
    files.push(
      { path: 'types/notes.ts', content: NOTES_TYPES },
      { path: 'src/services/notes.ts', content: NOTES_SERVICE },
      { path: 'src/data/useNotes.ts', content: USE_NOTES },
      { path: 'src/ui/NotesBoard.tsx', content: styled ? STYLED_NOTES_BOARD : PLAIN_NOTES_BOARD },
    );
  }
  if (agent) {
    files.push(
      { path: 'api/chat.ts', content: CHAT_API },
      { path: 'api/proposals.ts', content: PROPOSALS_API },
      { path: 'types/assistant.ts', content: ASSISTANT_TYPES },
      { path: 'src/services/assistant.ts', content: ASSISTANT_SERVICE },
      { path: 'src/data/useAssistant.ts', content: USE_ASSISTANT },
      { path: 'src/fixtures/assistant.ts', content: ASSISTANT_FIXTURES },
      { path: 'src/pages/AssistantFixturesPage.tsx', content: ASSISTANT_FIXTURES_PAGE },
      { path: 'src/ui/AssistantPanel.tsx', content: styled ? STYLED_ASSISTANT_PANEL : PLAIN_ASSISTANT_PANEL },
      { path: 'flows/assistant-fixtures.json', content: ASSISTANT_FIXTURES_FLOW },
    );
  }
  return files;
}
