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
    "@somewhere-tech/sdk": "0.10.0",
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
 * unavailable: the server could not confirm a session, and none was confirmed
 * on this page. suspended: a re-check failed for the account confirmed on this
 * page; its pages stay mounted but hidden until the session is confirmed.
 */
export type AuthState =
  | { status: 'loading' }
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
      return { status: 'signed-out' };
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

function mainTsx(styled: boolean): string {
  const styles = styled ? `import './styles/tokens.css';\nimport './styles/app.css';\n` : '';
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
  id: number | string;
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

function homePage(privateData: boolean): string {
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

// --------------------------------------------------------------------- readme

function readme(selection: InitSelection): string {
  const styled = selection.ui === 'styled';
  const privateData = selection.modules.includes('private-data');
  const lines = [
    '# somewhere.tech app',
    '',
    '## Where things go',
    '',
    '- Your app: `src/pages/HomePage.tsx`. Add a page: a path in `src/routes.ts`, a case in `src/App.tsx`, a file in `src/pages/`.',
    styled
      ? '- Look: `src/styles/tokens.css` (shared values), `src/styles/app.css`, and the views in `src/ui/`. Views take props only; rewrite or replace them freely.'
      : '- Look: `src/ui/` holds plain semantic views. Replace them with your own components; keep their props, or change the pages that pass them.',
    '- Sign-in: `src/auth/hooks.ts` (state and actions) over the SDK client in `src/services/auth.ts` and the SDK route `api/auth/[...path].ts`.',
  ];
  if (privateData) {
    lines.push('- Data: `db/schema.ts` (tables and browser permissions), `src/services/notes.ts` (calls), `src/data/useNotes.ts` (state). The notes example is removable.');
  }
  lines.push(
    '',
    '## Auth',
    '',
    'Auth is handled by `@somewhere-tech/sdk`. The session is an httpOnly cookie;',
    'app code does not store or send a token. `src/App.tsx` shows private pages only',
    'for an account the server confirmed: a loading screen until the first check',
    'answers, and a "try again" screen when the server cannot be reached (pages',
    'already open stay mounted but hidden, so unsaved input survives). The gate is',
    'only UX: functions and `db/schema.ts` decide what a request may read or write.',
    'Password reset, OAuth and MFA are not generated.',
  );
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
  if (selection.modules.includes('private-data')) points.data = 'db/schema.ts, src/services/notes.ts, src/data/useNotes.ts';
  return points;
}

// ---------------------------------------------------------------------- build

export function createFeatureTemplate(
  selection: InitSelection,
  options: FeatureTemplateOptions,
): InitScaffoldFile[] {
  const styled = selection.ui === 'styled';
  const privateData = selection.modules.includes('private-data');
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
    { path: 'src/main.tsx', content: mainTsx(styled) },
    { path: 'src/App.tsx', content: APP },
    { path: 'src/config.ts', content: configTs(options.appName) },
    { path: 'src/routes.ts', content: ROUTES },
    { path: 'src/services/auth.ts', content: AUTH_SERVICE },
    { path: 'src/auth/hooks.ts', content: AUTH_HOOKS },
    { path: 'src/pages/SignInPage.tsx', content: SIGN_IN_PAGE },
    { path: 'src/pages/SignedInLayout.tsx', content: SIGNED_IN_LAYOUT },
    { path: 'src/pages/HomePage.tsx', content: homePage(privateData) },
    { path: 'src/pages/NotFoundPage.tsx', content: NOT_FOUND_PAGE },
    { path: 'src/ui/feedback.tsx', content: styled ? STYLED_FEEDBACK : PLAIN_FEEDBACK },
    { path: 'src/ui/AuthCard.tsx', content: styled ? STYLED_AUTH_CARD : PLAIN_AUTH_CARD },
    { path: 'src/ui/AppShell.tsx', content: styled ? STYLED_APP_SHELL : PLAIN_APP_SHELL },
  ];
  if (styled) {
    files.push(
      { path: 'src/styles/tokens.css', content: TOKENS_CSS },
      { path: 'src/styles/app.css', content: privateData ? APP_CSS + '\n' + NOTES_CSS : APP_CSS },
    );
  }
  if (privateData) {
    files.push(
      { path: 'db/schema.ts', content: SCHEMA },
      { path: 'types/notes.ts', content: NOTES_TYPES },
      { path: 'src/services/notes.ts', content: NOTES_SERVICE },
      { path: 'src/data/useNotes.ts', content: USE_NOTES },
      { path: 'src/ui/NotesBoard.tsx', content: styled ? STYLED_NOTES_BOARD : PLAIN_NOTES_BOARD },
    );
  }
  return files;
}
