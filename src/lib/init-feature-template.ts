import type { InitScaffoldFile } from './init-scaffold.js';
import type { InitSelection } from './init-features.js';
import { INIT_AGENTS_MD, INIT_CLAUDE_MD } from './init-agent-guide.js';

// Files for `somewhere init --features`. Behaviour (types, services, hooks,
// routing) is shared by both UI modes; `styled` adds src/ui + src/styles and
// pages that compose them, `headless` writes plain-markup pages instead.

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

// ---------------------------------------------------------------- auth: server

const AUTH_API = `export { somewhereAuth as default } from '@somewhere-tech/sdk/server';
`;

// ----------------------------------------------------------------- auth: types

const AUTH_TYPES = `import type { User } from '@somewhere-tech/sdk/auth';

export type { User };

/** loading: the first session check has not answered and nothing is cached. */
export type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'signed-out'; user: null }
  | { status: 'signed-in'; user: User };

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
`;

// -------------------------------------------------------------- auth: services

const AUTH_SERVICE = `import { AuthError, createSomewhereAuth } from '@somewhere-tech/sdk/auth';

// The app's only auth client. It talks to api/auth/[...path].ts (the SDK's
// packaged handler). The session is an httpOnly cookie the browser keeps;
// nothing in this app reads, stores or sends a token.
export const auth = createSomewhereAuth();

export const PASSWORD_MIN_LENGTH = 8;

export function authErrorMessage(reason: unknown): string {
  if (reason instanceof AuthError && reason.message) return reason.message;
  if (reason instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  if (reason instanceof Error && reason.message) return reason.message;
  return 'Something went wrong. Try again.';
}
`;

// ----------------------------------------------------------------- auth: hooks

const AUTH_PROVIDER = `import type { ReactNode } from 'react';
import { SomewhereAuthProvider } from '@somewhere-tech/sdk/react';
import { auth } from '../services/auth';

/** The SDK provider bound to the app's client: it checks /api/auth/me once on
 *  load and re-renders on sign-in and sign-out. */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <SomewhereAuthProvider client={auth}>{children}</SomewhereAuthProvider>;
}
`;

const AUTH_HOOKS = `import { useState } from 'react';
import { useAuth, useAuthLoading, useUser } from '@somewhere-tech/sdk/react';
import type { AuthState, CredentialsForm, CredentialsMode, SignOutAction } from '../../types/auth';
import { authErrorMessage, PASSWORD_MIN_LENGTH } from '../services/auth';

export function useAuthState(): AuthState {
  const user = useUser();
  const loading = useAuthLoading();
  if (user) return { status: 'signed-in', user };
  return loading ? { status: 'loading', user: null } : { status: 'signed-out', user: null };
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
      // The provider now has the user, so the sign-in page unmounts.
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
    } finally {
      setPending(false);
    }
  }

  return { pending, error, signOut };
}
`;

// --------------------------------------------------------------------- routing

const ROUTES = `import { useEffect, useState, type MouseEvent } from 'react';

// Single entry: the platform serves index.html for every extensionless path
// (/account, /anything), so the app routes on location.pathname. To add a
// page, add its path here and a case in App.tsx.
export const ROUTES = {
  home: '/',
  account: '/account',
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

/** Props for an <a> that navigates in-app but keeps new-tab/copy-link behaviour. */
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

const APP = `import { useAuthState } from './auth/hooks';
import { AccountPage } from './pages/AccountPage';
import { HomePage } from './pages/HomePage';
import { LoadingPage } from './pages/LoadingPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SignInPage } from './pages/SignInPage';
import { ROUTES, usePathname } from './routes';

// Routing and the sign-in gate only. Every path is private here: signed-out
// visitors see the sign-in page at whatever URL they opened, and land on it
// again after signing in. For a public page, route it above the gate.
export function App() {
  const session = useAuthState();
  const pathname = usePathname();

  if (session.status === 'loading') return <LoadingPage />;
  if (session.status === 'signed-out') return <SignInPage />;

  switch (pathname) {
    case ROUTES.home:
      return <HomePage user={session.user} />;
    case ROUTES.account:
      return <AccountPage user={session.user} />;
    default:
      return <NotFoundPage user={session.user} />;
  }
}
`;

function mainTsx(styled: boolean): string {
  const styles = styled ? `import './styles/tokens.css';\nimport './styles/app.css';\n` : '';
  return `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
${styles}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
`;
}

function configTs(appName: string): string {
  return `// Shown in the header, the sign-in page and the tab title (index.html).
export const APP_NAME = ${JSON.stringify(appName)};
`;
}

// -------------------------------------------------------- private-data: server

const SCHEMA = `import { id, owner, schema, table, text } from 'somewhere/db';

// notes: owner() means each signed-in user reads and writes only their own
// rows. The platform enforces it on the browser client (somewhere:data),
// direct HTTP and sw.db inside functions, so no code in this app filters by
// user. \`somewhere docs declared-data\` is the contract.
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

// --------------------------------------------------------- private-data: types

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

/** unchanged: nothing differed, so nothing was written. missing: the note no
 *  longer exists for this user (deleted elsewhere, or never theirs). */
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

// ------------------------------------------------------ private-data: services

const NOTES_SERVICE = `import { data, DataError } from 'somewhere:data';
import type { Note, NoteDraft, NoteDraftErrors, NoteId, NoteRemoveResult, NoteSaveResult } from '../../types/notes';

export const NOTE_LIMITS = { title: 120, body: 4000 } as const;
const PAGE_SIZE = 100;

// Rows arrive already limited to the signed-in user (owner() in
// db/schema.ts). Never add a user filter here; the platform owns it.

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

export function sameDraft(note: Note, draft: NoteDraft): boolean {
  const next = normalizeDraft(draft);
  return note.title === next.title && note.body === next.body;
}

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

/** A missing note and a note this user may not write answer the same way. */
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
      case 'DATA_INPUT_INVALID':
      case 'DATA_VALUE_INVALID':
      case 'DATA_INPUT_TOO_LARGE':
        return reason.message || 'That note could not be saved as written.';
      default:
        return reason.message || 'The request failed (' + reason.status + ').';
    }
  }
  if (reason instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  if (reason instanceof Error && reason.message) return reason.message;
  return 'Something went wrong. Try again.';
}
`;

// --------------------------------------------------------- private-data: hooks

const USE_NOTES = `import { useEffect, useState } from 'react';
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

/** Notes for one signed-in user. Changing userId clears everything first, so
 *  one account never sees another's rows while the new list loads. */
export function useNotes(userId: string): NotesController {
  const auth = useAuth();
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
    let current = true;
    setStatus('loading');
    setNotes([]);
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
  }, [userId, reloadKey, auth]);

  useEffect(() => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setNotice(null);
  }, [userId]);

  const errors = validateDraft(draft);
  // An empty title only disables the button; it is not shouted at while typing.
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
        setNotes((list) => [...list, created]);
        setNotice({ tone: 'info', text: 'Added.' });
      }
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
    } catch (reason: unknown) {
      fail(reason);
    } finally {
      setSaving(false);
    }
  }

  async function remove(note: Note) {
    setRemovingId(note.id);
    setNotice(null);
    try {
      const result = await removeNote(note.id);
      setNotes((list) => list.filter((item) => item.id !== note.id));
      if (editingId === note.id) {
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
      }
      setNotice(result.kind === 'removed'
        ? { tone: 'info', text: 'Deleted.' }
        : { tone: 'info', text: 'That note was already removed.' });
    } catch (reason: unknown) {
      fail(reason);
    } finally {
      setRemovingId(null);
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

// ------------------------------------------------------------------- styled ui

const UI_FEEDBACK = `import type { ReactNode } from 'react';

export function LoadingScreen({ label }: { label: string }) {
  return (
    <main className="loading-screen" aria-busy="true">
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
`;

const UI_AUTH_CARD = `import type { FormEvent } from 'react';
import type { CredentialsForm } from '../../types/auth';

interface AuthCardProps {
  appName: string;
  form: CredentialsForm;
}

export function AuthCard({ appName, form }: AuthCardProps) {
  const signUp = form.mode === 'sign-up';
  const passwordHint = 'At least ' + form.passwordMinLength + ' characters.';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void form.submit();
  }

  return (
    <main className="auth">
      <section className="auth__intro" aria-labelledby="auth-title">
        <p className="eyebrow">{appName}</p>
        <h1 id="auth-title" className="display">
          {signUp ? 'Open an account.' : 'Welcome back.'}
        </h1>
        <p className="lede">
          {signUp ? 'One account, private to you. It takes a few seconds.' : 'Sign in to pick up where you left off.'}
        </p>
      </section>

      <form className="card auth__form" onSubmit={onSubmit} noValidate>
        <h2 className="card__title">{signUp ? 'Create account' : 'Sign in'}</h2>
        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            autoFocus
            value={form.email}
            onChange={(event) => form.setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            name="password"
            autoComplete={signUp ? 'new-password' : 'current-password'}
            required
            minLength={signUp ? form.passwordMinLength : undefined}
            aria-describedby={signUp ? 'auth-password-hint' : undefined}
            value={form.password}
            onChange={(event) => form.setPassword(event.target.value)}
          />
          {signUp ? <p id="auth-password-hint" className="field__hint">{passwordHint}</p> : null}
        </div>
        {form.error ? <p className="form-error" role="alert">{form.error}</p> : null}
        <button type="submit" className="button" disabled={!form.canSubmit} aria-busy={form.pending}>
          {form.pending ? (signUp ? 'Creating account…' : 'Signing in…') : (signUp ? 'Create account' : 'Sign in')}
        </button>
        <p className="auth__switch">
          {signUp ? 'Already have an account?' : 'New here?'}{' '}
          <button type="button" className="text-button" onClick={form.toggleMode} disabled={form.pending}>
            {signUp ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </form>
    </main>
  );
}
`;

const UI_APP_SHELL = `import type { ReactNode } from 'react';
import type { LinkProps } from '../routes';

interface AppShellProps {
  appName: string;
  homeLink: LinkProps;
  menu: ReactNode;
  children: ReactNode;
}

export function AppShell({ appName, homeLink, menu, children }: AppShellProps) {
  return (
    <div className="shell">
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="shell__header">
        <a className="brand" {...homeLink}>{appName}</a>
        {menu}
      </header>
      <main id="content" className="shell__main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
`;

const UI_ACCOUNT_MENU = `import { useEffect, useId, useRef, useState } from 'react';
import type { LinkProps } from '../routes';

interface AccountMenuProps {
  label: string;
  accountLink: LinkProps;
  onSignOut(): void;
  signingOut: boolean;
  error: string | null;
}

// Menu open/closed is presentation state; signing out is the caller's action.
export function AccountMenu({ label, accountLink, onSignOut, signingOut, error }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="menu__trigger"
        aria-label={'Account menu, ' + label}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(!open)}
      >
        <span className="menu__avatar" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
        <span className="menu__label">{label}</span>
      </button>
      <div id={menuId} className="menu__panel" hidden={!open}>
        <a className="menu__item" {...accountLink} onClick={(event) => { setOpen(false); accountLink.onClick(event); }}>
          Account
        </a>
        <button type="button" className="menu__item" onClick={onSignOut} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
      {error ? <p className="menu__error" role="alert">{error}</p> : null}
    </div>
  );
}
`;

const UI_ACCOUNT_DETAILS = `interface AccountDetailsProps {
  email: string | null;
  userId: string;
  verified: boolean | null;
  onSignOut(): void;
  signingOut: boolean;
}

export function AccountDetails({ email, userId, verified, onSignOut, signingOut }: AccountDetailsProps) {
  return (
    <section className="page" aria-labelledby="account-title">
      <p className="eyebrow">Account</p>
      <h1 id="account-title" className="display display--page">{email ?? 'Your account'}</h1>
      <dl className="details card">
        <div>
          <dt>Email</dt>
          <dd>{email ?? 'Not set'}</dd>
        </div>
        <div>
          <dt>Email verified</dt>
          <dd>{verified === null ? 'Unknown' : verified ? 'Yes' : 'Not yet'}</dd>
        </div>
        <div>
          <dt>User ID</dt>
          <dd className="mono">{userId}</dd>
        </div>
      </dl>
      <button type="button" className="button button--quiet" onClick={onSignOut} disabled={signingOut}>
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  );
}
`;

const UI_WELCOME = `import type { LinkProps } from '../routes';

export function WelcomePanel({ name, accountLink }: { name: string; accountLink: LinkProps }) {
  return (
    <section className="page" aria-labelledby="welcome-title">
      <p className="eyebrow">Signed in</p>
      <h1 id="welcome-title" className="display display--page">You're in.</h1>
      <p className="lede">Signed in as <strong>{name}</strong>. This page is private; build your app here, in src/pages/HomePage.tsx.</p>
      <p><a className="button button--quiet" {...accountLink}>View account</a></p>
    </section>
  );
}
`;

const UI_NOT_FOUND = `import type { LinkProps } from '../routes';

export function NotFound({ homeLink }: { homeLink: LinkProps }) {
  return (
    <section className="page" aria-labelledby="not-found-title">
      <p className="eyebrow">404</p>
      <h1 id="not-found-title" className="display display--page">Nothing lives here.</h1>
      <p><a className="button button--quiet" {...homeLink}>Go home</a></p>
    </section>
  );
}
`;

const UI_NOTES_BOARD = `import type { FormEvent } from 'react';
import type { NotesController } from '../../types/notes';
import { Alert, EmptyState } from './feedback';

export function NotesBoard({ notes: controller, heading }: { notes: NotesController; heading: string }) {
  const { draft, draftErrors, limits } = controller;
  const editing = controller.editingId !== null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void controller.save();
  }

  return (
    <div className="board">
      <section className="board__compose" aria-labelledby="compose-title">
        <p className="eyebrow">{heading}</p>
        <h1 id="compose-title" className="display display--page">{editing ? 'Edit note' : 'New note'}</h1>
        <form className="card compose" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="note-title">Title</label>
            <input
              id="note-title"
              name="title"
              required
              maxLength={limits.title + 1}
              aria-invalid={draftErrors.title ? true : undefined}
              aria-describedby={draftErrors.title ? 'note-title-error' : undefined}
              value={draft.title}
              onChange={(event) => controller.setDraft({ ...draft, title: event.target.value })}
            />
            {draftErrors.title ? <p id="note-title-error" className="field__error">{draftErrors.title}</p> : null}
          </div>
          <div className="field">
            <label htmlFor="note-body">
              Note <span className="field__count">{draft.body.length}/{limits.body}</span>
            </label>
            <textarea
              id="note-body"
              name="body"
              rows={5}
              aria-invalid={draftErrors.body ? true : undefined}
              aria-describedby={draftErrors.body ? 'note-body-error' : undefined}
              value={draft.body}
              onChange={(event) => controller.setDraft({ ...draft, body: event.target.value })}
            />
            {draftErrors.body ? <p id="note-body-error" className="field__error">{draftErrors.body}</p> : null}
          </div>
          <div className="actions">
            <button type="submit" className="button" disabled={!controller.canSave} aria-busy={controller.saving}>
              {controller.saving ? 'Saving…' : editing ? 'Save changes' : 'Add note'}
            </button>
            {editing ? (
              <button type="button" className="button button--quiet" onClick={controller.cancelEdit} disabled={controller.saving}>
                Cancel
              </button>
            ) : null}
          </div>
          <p className={'notice notice--' + (controller.notice?.tone ?? 'info')} role="status" aria-live="polite">
            {controller.notice?.text ?? ''}
          </p>
        </form>
      </section>

      <section className="board__list" aria-labelledby="notes-title" aria-busy={controller.status === 'loading'}>
        <h2 id="notes-title" className="section-title">
          Your notes {controller.status === 'ready' ? <span className="count">{controller.notes.length}</span> : null}
        </h2>
        {controller.status === 'loading' ? (
          <ol className="notes notes--loading" aria-label="Loading notes">
            <li className="note note--skeleton" /><li className="note note--skeleton" /><li className="note note--skeleton" />
          </ol>
        ) : null}
        {controller.status === 'error' ? (
          <Alert action={<button type="button" className="button button--quiet" onClick={controller.reload}>Try again</button>}>
            {controller.loadError}
          </Alert>
        ) : null}
        {controller.status === 'ready' && controller.notes.length === 0 ? (
          <EmptyState title="No notes yet.">Write the first one. Only you can see it.</EmptyState>
        ) : null}
        {controller.status === 'ready' && controller.notes.length > 0 ? (
          <ol className="notes">
            {controller.notes.map((note, index) => (
              <li key={note.id} className={'note' + (note.id === controller.editingId ? ' note--editing' : '')}>
                <span className="note__index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <div className="note__content">
                  <h3 className="note__title">{note.title}</h3>
                  {note.body ? <p className="note__body">{note.body}</p> : null}
                </div>
                <div className="note__actions">
                  <button type="button" className="text-button" onClick={() => controller.startEdit(note)} aria-label={'Edit ' + note.title}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-button text-button--danger"
                    onClick={() => void controller.remove(note)}
                    disabled={controller.removingId === note.id}
                    aria-label={'Delete ' + note.title}
                  >
                    {controller.removingId === note.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        {controller.truncated ? <p className="field__hint">Showing the first {controller.notes.length} notes.</p> : null}
      </section>
    </div>
  );
}
`;

// ---------------------------------------------------------------- styled pages

const STYLED_LOADING_PAGE = `import { LoadingScreen } from '../ui/feedback';

export function LoadingPage() {
  return <LoadingScreen label="Checking your session…" />;
}
`;

const STYLED_SIGN_IN_PAGE = `import { useCredentialsForm } from '../auth/hooks';
import { APP_NAME } from '../config';
import { AuthCard } from '../ui/AuthCard';

export function SignInPage() {
  const form = useCredentialsForm();
  return <AuthCard appName={APP_NAME} form={form} />;
}
`;

const STYLED_LAYOUT = `import type { ReactNode } from 'react';
import type { User } from '../../types/auth';
import { useSignOut } from '../auth/hooks';
import { APP_NAME } from '../config';
import { linkTo, ROUTES } from '../routes';
import { AccountMenu } from '../ui/AccountMenu';
import { AppShell } from '../ui/AppShell';

/** The signed-in frame every private page shares. */
export function SignedInLayout({ user, children }: { user: User; children: ReactNode }) {
  const signOut = useSignOut();
  return (
    <AppShell
      appName={APP_NAME}
      homeLink={linkTo(ROUTES.home)}
      menu={(
        <AccountMenu
          label={user.email ?? 'Account'}
          accountLink={linkTo(ROUTES.account)}
          onSignOut={() => void signOut.signOut()}
          signingOut={signOut.pending}
          error={signOut.error}
        />
      )}
    >
      {children}
    </AppShell>
  );
}
`;

function styledHomePage(privateData: boolean): string {
  if (privateData) {
    return `import type { User } from '../../types/auth';
import { useNotes } from '../data/useNotes';
import { NotesBoard } from '../ui/NotesBoard';
import { SignedInLayout } from './SignedInLayout';

export function HomePage({ user }: { user: User }) {
  const notes = useNotes(user.id);
  return (
    <SignedInLayout user={user}>
      <NotesBoard notes={notes} heading="Private notes" />
    </SignedInLayout>
  );
}
`;
  }
  return `import type { User } from '../../types/auth';
import { linkTo, ROUTES } from '../routes';
import { WelcomePanel } from '../ui/WelcomePanel';
import { SignedInLayout } from './SignedInLayout';

export function HomePage({ user }: { user: User }) {
  return (
    <SignedInLayout user={user}>
      <WelcomePanel name={user.email ?? 'there'} accountLink={linkTo(ROUTES.account)} />
    </SignedInLayout>
  );
}
`;
}

const STYLED_ACCOUNT_PAGE = `import type { User } from '../../types/auth';
import { useSignOut } from '../auth/hooks';
import { AccountDetails } from '../ui/AccountDetails';
import { SignedInLayout } from './SignedInLayout';

export function AccountPage({ user }: { user: User }) {
  const signOut = useSignOut();
  const verified = typeof user.email_verified === 'boolean' ? user.email_verified : null;
  return (
    <SignedInLayout user={user}>
      <AccountDetails
        email={user.email}
        userId={user.id}
        verified={verified}
        onSignOut={() => void signOut.signOut()}
        signingOut={signOut.pending}
      />
    </SignedInLayout>
  );
}
`;

const STYLED_NOT_FOUND_PAGE = `import type { User } from '../../types/auth';
import { linkTo, ROUTES } from '../routes';
import { NotFound } from '../ui/NotFound';
import { SignedInLayout } from './SignedInLayout';

export function NotFoundPage({ user }: { user: User }) {
  return (
    <SignedInLayout user={user}>
      <NotFound homeLink={linkTo(ROUTES.home)} />
    </SignedInLayout>
  );
}
`;

// -------------------------------------------------------------- headless pages

const HEADLESS_LOADING_PAGE = `export function LoadingPage() {
  return (
    <main aria-busy="true">
      <p role="status">Checking your session…</p>
    </main>
  );
}
`;

const HEADLESS_SIGN_IN_PAGE = `import type { FormEvent } from 'react';
import { useCredentialsForm } from '../auth/hooks';
import { APP_NAME } from '../config';

// Behaviour comes from useCredentialsForm; replace this markup with your own.
export function SignInPage() {
  const form = useCredentialsForm();
  const signUp = form.mode === 'sign-up';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void form.submit();
  }

  return (
    <main>
      <h1>{signUp ? 'Create an account' : 'Sign in'} to {APP_NAME}</h1>
      <form onSubmit={onSubmit} noValidate>
        <p>
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" type="email" name="email" autoComplete="email" required autoFocus value={form.email} onChange={(event) => form.setEmail(event.target.value)} />
        </p>
        <p>
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            name="password"
            autoComplete={signUp ? 'new-password' : 'current-password'}
            required
            minLength={signUp ? form.passwordMinLength : undefined}
            value={form.password}
            onChange={(event) => form.setPassword(event.target.value)}
          />
        </p>
        {form.error ? <p role="alert">{form.error}</p> : null}
        <button type="submit" disabled={!form.canSubmit} aria-busy={form.pending}>
          {form.pending ? 'Please wait…' : signUp ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <button type="button" onClick={form.toggleMode} disabled={form.pending}>
        {signUp ? 'Have an account? Sign in' : 'New here? Create an account'}
      </button>
    </main>
  );
}
`;

const HEADLESS_LAYOUT = `import type { ReactNode } from 'react';
import type { User } from '../../types/auth';
import { useSignOut } from '../auth/hooks';
import { APP_NAME } from '../config';
import { linkTo, ROUTES } from '../routes';

export function SignedInLayout({ user, children }: { user: User; children: ReactNode }) {
  const signOut = useSignOut();
  return (
    <>
      <header>
        <a {...linkTo(ROUTES.home)}>{APP_NAME}</a>
        <nav aria-label="Account">
          <a {...linkTo(ROUTES.account)}>{user.email ?? 'Account'}</a>{' '}
          <button type="button" onClick={() => void signOut.signOut()} disabled={signOut.pending}>
            {signOut.pending ? 'Signing out…' : 'Sign out'}
          </button>
        </nav>
        {signOut.error ? <p role="alert">{signOut.error}</p> : null}
      </header>
      <main>{children}</main>
    </>
  );
}
`;

function headlessHomePage(privateData: boolean): string {
  if (!privateData) {
    return `import type { User } from '../../types/auth';
import { SignedInLayout } from './SignedInLayout';

export function HomePage({ user }: { user: User }) {
  return (
    <SignedInLayout user={user}>
      <h1>Hello, {user.email ?? 'there'}.</h1>
      <p>This page is private. Build your app here.</p>
    </SignedInLayout>
  );
}
`;
  }
  return `import type { FormEvent } from 'react';
import type { User } from '../../types/auth';
import { useNotes } from '../data/useNotes';
import { SignedInLayout } from './SignedInLayout';

// Behaviour comes from useNotes; replace this markup with your own.
export function HomePage({ user }: { user: User }) {
  const notes = useNotes(user.id);
  const { draft, draftErrors } = notes;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void notes.save();
  }

  return (
    <SignedInLayout user={user}>
      <h1>{notes.editingId === null ? 'New note' : 'Edit note'}</h1>
      <form onSubmit={onSubmit} noValidate>
        <p>
          <label htmlFor="note-title">Title</label>
          <input id="note-title" name="title" required value={draft.title} aria-invalid={draftErrors.title ? true : undefined} onChange={(event) => notes.setDraft({ ...draft, title: event.target.value })} />
          {draftErrors.title ? <span role="alert">{draftErrors.title}</span> : null}
        </p>
        <p>
          <label htmlFor="note-body">Note</label>
          <textarea id="note-body" name="body" value={draft.body} aria-invalid={draftErrors.body ? true : undefined} onChange={(event) => notes.setDraft({ ...draft, body: event.target.value })} />
          {draftErrors.body ? <span role="alert">{draftErrors.body}</span> : null}
        </p>
        <button type="submit" disabled={!notes.canSave} aria-busy={notes.saving}>{notes.saving ? 'Saving…' : 'Save'}</button>
        {notes.editingId !== null ? <button type="button" onClick={notes.cancelEdit}>Cancel</button> : null}
        <p role="status" aria-live="polite">{notes.notice?.text ?? ''}</p>
      </form>

      <h2>Your notes</h2>
      {notes.status === 'loading' ? <p role="status">Loading notes…</p> : null}
      {notes.status === 'error' ? (
        <p role="alert">{notes.loadError} <button type="button" onClick={notes.reload}>Try again</button></p>
      ) : null}
      {notes.status === 'ready' && notes.notes.length === 0 ? <p>No notes yet.</p> : null}
      <ul>
        {notes.notes.map((note) => (
          <li key={note.id}>
            <strong>{note.title}</strong> {note.body}{' '}
            <button type="button" onClick={() => notes.startEdit(note)}>Edit</button>{' '}
            <button type="button" onClick={() => void notes.remove(note)} disabled={notes.removingId === note.id}>Delete</button>
          </li>
        ))}
      </ul>
    </SignedInLayout>
  );
}
`;
}

const HEADLESS_ACCOUNT_PAGE = `import type { User } from '../../types/auth';
import { SignedInLayout } from './SignedInLayout';

export function AccountPage({ user }: { user: User }) {
  return (
    <SignedInLayout user={user}>
      <h1>Account</h1>
      <dl>
        <dt>Email</dt>
        <dd>{user.email ?? 'Not set'}</dd>
        <dt>User ID</dt>
        <dd>{user.id}</dd>
      </dl>
    </SignedInLayout>
  );
}
`;

const HEADLESS_NOT_FOUND_PAGE = `import type { User } from '../../types/auth';
import { linkTo, ROUTES } from '../routes';
import { SignedInLayout } from './SignedInLayout';

export function NotFoundPage({ user }: { user: User }) {
  return (
    <SignedInLayout user={user}>
      <h1>Page not found</h1>
      <p><a {...linkTo(ROUTES.home)}>Go home</a></p>
    </SignedInLayout>
  );
}
`;

// ---------------------------------------------------------------------- styles

const TOKENS_CSS = `/* Design tokens: the restyle surface. src/styles/app.css reads only these,
   so a new look is usually a new copy of this block. Local fonts only. */
:root {
  color-scheme: light;

  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  --font-body: "Avenir Next", "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", Helvetica, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --display-weight: 600;
  --display-tracking: -0.025em;
  --display-transform: none;
  --display-size: clamp(2.6rem, 6.4vw, 4.75rem);

  --color-bg: #f3ede2;
  --color-surface: #fffcf6;
  --color-ink: #1c1915;
  --color-muted: #6d6358;
  --color-line: #dcd1c0;
  --color-accent: #c2411c;
  --color-accent-ink: #fffcf6;
  --color-danger: #a3161a;
  --color-focus: #c2411c;

  --radius: 6px;
  --radius-control: 4px;
  --space: 8px;
  --control-height: 46px;
  --shadow: 0 1px 0 var(--color-line), 0 24px 48px -32px rgba(28, 25, 21, 0.45);
  --backdrop: radial-gradient(120% 80% at 100% 0%, rgba(194, 65, 28, 0.08), transparent 60%),
    repeating-linear-gradient(0deg, transparent 0 31px, rgba(28, 25, 21, 0.045) 31px 32px);
  --measure: 1120px;
}
`;

const APP_CSS = `/* Component styles. Values come from tokens.css. */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
  background: var(--backdrop), var(--color-bg);
  color: var(--color-ink);
  font: 400 1rem/1.55 var(--font-body);
}
button, input, textarea { font: inherit; color: inherit; }
a { color: inherit; }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }
[hidden] { display: none !important; }

.skip-link { position: absolute; left: 12px; top: -48px; padding: 8px 12px; background: var(--color-ink); color: var(--color-bg); z-index: 10; }
.skip-link:focus { top: 12px; }

.eyebrow {
  margin: 0 0 calc(var(--space) * 1.5);
  color: var(--color-accent);
  font: 600 0.78rem/1 var(--font-mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.display {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--display-size);
  font-weight: var(--display-weight);
  letter-spacing: var(--display-tracking);
  line-height: 0.98;
  text-transform: var(--display-transform);
  text-wrap: balance;
  overflow-wrap: anywhere;
}
.display--page { font-size: calc(var(--display-size) * 0.62); line-height: 1.05; }
.lede { max-width: 44ch; overflow-wrap: anywhere; margin: calc(var(--space) * 2) 0 0; color: var(--color-muted); font-size: 1.125rem; }
.mono { font-family: var(--font-mono); font-size: 0.9em; word-break: break-all; }

.card {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: calc(var(--space) * 3);
}
.card__title { margin: 0 0 calc(var(--space) * 2); font: 600 1.05rem/1.2 var(--font-body); }

.field { display: grid; gap: 6px; margin-bottom: calc(var(--space) * 2); }
.field label { display: flex; justify-content: space-between; font-weight: 600; font-size: 0.95rem; }
.field input, .field textarea {
  width: 100%;
  min-height: var(--control-height);
  padding: 10px 12px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  background: var(--color-bg);
  transition: border-color 120ms ease, background-color 120ms ease;
}
.field textarea { resize: vertical; min-height: 120px; }
.field input:hover, .field textarea:hover { border-color: var(--color-muted); }
.field input:focus-visible, .field textarea:focus-visible { outline-offset: 0; background: var(--color-surface); }
.field [aria-invalid="true"] { border-color: var(--color-danger); }
.field__hint, .field__count { color: var(--color-muted); font-size: 0.85rem; font-weight: 400; }
.field__error, .form-error { margin: 0; color: var(--color-danger); font-size: 0.9rem; }
.form-error { margin-bottom: calc(var(--space) * 2); }

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-height);
  padding: 0 calc(var(--space) * 2.5);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-control);
  background: var(--color-accent);
  color: var(--color-accent-ink);
  font-weight: 650;
  text-decoration: none;
  cursor: pointer;
  transition: transform 120ms ease, filter 120ms ease;
}
.button:hover:not(:disabled) { filter: brightness(1.08); }
.button:active:not(:disabled) { transform: translateY(1px); }
.button:disabled { opacity: 0.45; cursor: not-allowed; }
.button--quiet { background: transparent; color: var(--color-ink); border-color: var(--color-line); }
.auth__form .button { width: 100%; }
.text-button {
  min-height: 32px;
  padding: 4px 6px;
  border: 0;
  background: none;
  color: var(--color-accent);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.text-button:disabled { opacity: 0.5; cursor: not-allowed; }
.text-button--danger { color: var(--color-danger); }

/* Sign-in */
.auth {
  display: grid;
  gap: calc(var(--space) * 5);
  align-items: center;
  width: min(var(--measure), calc(100% - 32px));
  min-height: 100vh;
  margin: 0 auto;
  padding: calc(var(--space) * 6) 0;
  grid-template-columns: minmax(0, 1.15fr) minmax(300px, 420px);
}
.auth__intro { animation: rise 520ms ease both; }
.auth__form { animation: rise 520ms 90ms ease both; }
.auth__switch { margin: calc(var(--space) * 2) 0 0; color: var(--color-muted); text-align: center; }

/* Loading */
.loading-screen { display: grid; place-content: center; justify-items: center; gap: 12px; min-height: 100vh; color: var(--color-muted); }
.spinner { width: 28px; height: 28px; border: 3px solid var(--color-line); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 800ms linear infinite; }

/* Shell */
.shell__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: min(var(--measure), calc(100% - 32px));
  margin: 0 auto;
  padding: calc(var(--space) * 2.5) 0;
  border-bottom: 1px solid var(--color-line);
}
.brand { font: var(--display-weight) 1.35rem/1 var(--font-display); letter-spacing: var(--display-tracking); text-transform: var(--display-transform); text-decoration: none; }
.shell__main { width: min(var(--measure), calc(100% - 32px)); margin: 0 auto; padding: calc(var(--space) * 5) 0 calc(var(--space) * 8); outline: none; }
.page { max-width: 640px; animation: rise 420ms ease both; }
.page .card { margin: calc(var(--space) * 3) 0; }

/* Account menu */
.menu { position: relative; }
.menu__trigger {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  max-width: 260px;
  padding: 4px 12px 4px 4px;
  border: 1px solid var(--color-line);
  border-radius: 999px;
  background: var(--color-surface);
  cursor: pointer;
}
.menu__avatar { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: var(--color-ink); color: var(--color-bg); font-weight: 700; flex: none; }
.menu__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.92rem; }
.menu__panel {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 5;
  display: grid;
  min-width: 200px;
  padding: 6px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  background: var(--color-surface);
  box-shadow: var(--shadow);
}
.menu__item {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--radius-control);
  background: none;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.menu__item:hover, .menu__item:focus-visible { background: var(--color-bg); }
.menu__error { position: absolute; right: 0; margin: 6px 0 0; color: var(--color-danger); font-size: 0.85rem; }

/* Account details */
.details { display: grid; gap: 14px; margin: 0; }
.details div { display: grid; grid-template-columns: 140px 1fr; gap: 12px; }
.details dt { color: var(--color-muted); }
.details dd { margin: 0; }

/* Notes */
.board { display: grid; gap: calc(var(--space) * 6); grid-template-columns: minmax(280px, 400px) minmax(0, 1fr); align-items: start; }
.board__compose { position: sticky; top: 24px; animation: rise 420ms ease both; }
.board__compose .card { margin-top: calc(var(--space) * 3); }
.board__list { animation: rise 420ms 80ms ease both; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
.notice { min-height: 1.4em; margin: calc(var(--space) * 1.5) 0 0; font-size: 0.92rem; color: var(--color-muted); }
.notice--error { color: var(--color-danger); }
.section-title { display: flex; align-items: baseline; gap: 10px; margin: 0 0 calc(var(--space) * 2); padding-bottom: 10px; border-bottom: 2px solid var(--color-ink); font: 600 0.8rem/1 var(--font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
.count { color: var(--color-accent); }
.notes { display: grid; margin: 0; padding: 0; list-style: none; }
.note {
  display: grid;
  grid-template-columns: 3ch minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
  padding: calc(var(--space) * 2) 0;
  border-bottom: 1px solid var(--color-line);
}
.note--editing { background: linear-gradient(90deg, rgba(194, 65, 28, 0.08), transparent 70%); }
.note__index { color: var(--color-accent); font: 600 0.85rem/1.9 var(--font-mono); }
.note__title { margin: 0; font: var(--display-weight) 1.3rem/1.25 var(--font-display); letter-spacing: var(--display-tracking); overflow-wrap: anywhere; }
.note__body { margin: 6px 0 0; color: var(--color-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.note__actions { display: flex; gap: 4px; }
.note--skeleton { min-height: 76px; background: linear-gradient(90deg, transparent, var(--color-line), transparent) 0 0 / 200% 100%; opacity: 0.5; animation: shimmer 1.2s linear infinite; }
.alert { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 16px; border: 1px solid var(--color-danger); border-radius: var(--radius); color: var(--color-danger); background: var(--color-surface); }
.alert p { margin: 0; }
.empty { padding: calc(var(--space) * 5) calc(var(--space) * 3); border: 1px dashed var(--color-line); border-radius: var(--radius); text-align: center; }
.empty__title { margin: 0; font: var(--display-weight) 1.5rem/1.2 var(--font-display); }
.empty__body { margin: 8px 0 0; color: var(--color-muted); }

@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes shimmer { to { background-position: -200% 0; } }

@media (max-width: 820px) {
  .auth { grid-template-columns: 1fr; align-content: start; gap: calc(var(--space) * 4); padding-top: calc(var(--space) * 7); }
  .board { grid-template-columns: 1fr; gap: calc(var(--space) * 5); }
  .board__compose { position: static; }
}
@media (max-width: 520px) {
  .card { padding: calc(var(--space) * 2.25); }
  .menu__label { display: none; }
  .menu__trigger { padding-right: 4px; }
  .details div { grid-template-columns: 1fr; gap: 2px; }
  .note { grid-template-columns: 1fr; gap: 6px; }
  .note__index { display: none; }
  .note__actions { margin-left: -6px; }
  .text-button { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition: none !important; }
}
`;

// ---------------------------------------------------------------------- readme

function readme(selection: InitSelection): string {
  const styled = selection.ui === 'styled';
  const privateData = selection.modules.includes('private-data');
  const lines = [
    '# somewhere.tech app',
    '',
    `Generated by \`somewhere init --features ${selection.modules.join(',')} --ui ${selection.ui}\`.`,
    '',
    '## Where things live',
    '',
    '| Change | Edit | Leave alone |',
    '|---|---|---|',
  ];
  if (styled) {
    lines.push('| Colours, fonts, radius, spacing | `src/styles/tokens.css` | |');
    lines.push('| Component look | `src/styles/app.css`, `src/ui/*.tsx` (props only; safe to rewrite or delete) | |');
  } else {
    lines.push('| Markup | `src/pages/*.tsx` (plain markup over the hooks; replace freely) | |');
  }
  lines.push('| App name | `src/config.ts`, `index.html` | |');
  lines.push('| Add a page | `src/routes.ts` (path) + `src/App.tsx` (case) + `src/pages/` | |');
  lines.push('| Sign-in behaviour | `src/auth/hooks.ts` | `api/auth/[...path].ts`, `src/services/auth.ts` (SDK) |');
  if (privateData) {
    lines.push('| Note fields | `db/schema.ts` (+ `client` block), `types/notes.ts`, `src/services/notes.ts` | owner scoping (the platform applies `owner()`) |');
    lines.push('| Note state | `src/data/useNotes.ts` | |');
  }
  lines.push(
    '',
    '## Auth',
    '',
    'Auth is handled by `@somewhere-tech/sdk`: `api/auth/[...path].ts` is its packaged',
    'handler and `src/services/auth.ts` its client. The session is an httpOnly cookie;',
    'app code never stores or sends a token. `src/App.tsx` shows a loading screen until',
    'the first session check answers, then the sign-in page or the routed page.',
    'Password reset, OAuth and MFA are not generated.',
  );
  if (privateData) {
    lines.push(
      '',
      '## Private data',
      '',
      '`db/schema.ts` declares `notes` with `owner()`: each user reads and writes only',
      'their own rows, on every path. `src/services/notes.ts` calls the generated',
      '`somewhere:data` client and never filters by user. Updates report',
      '"No changes" when nothing differed and "already removed" when the note is gone.',
      'Contract: `somewhere docs declared-data`.',
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
    'Deploy the raw source; the platform compiles it. Failures: `somewhere logs --tail 10`,',
    'then `somewhere errors`.',
    '',
  );
  return lines.join('\n');
}

// ----------------------------------------------------------------------- build

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
    { path: 'src/auth/AuthProvider.tsx', content: AUTH_PROVIDER },
    { path: 'src/auth/hooks.ts', content: AUTH_HOOKS },
  ];

  if (privateData) {
    files.push(
      { path: 'db/schema.ts', content: SCHEMA },
      { path: 'types/notes.ts', content: NOTES_TYPES },
      { path: 'src/services/notes.ts', content: NOTES_SERVICE },
      { path: 'src/data/useNotes.ts', content: USE_NOTES },
    );
  }

  if (styled) {
    files.push(
      { path: 'src/styles/tokens.css', content: TOKENS_CSS },
      { path: 'src/styles/app.css', content: APP_CSS },
      { path: 'src/ui/feedback.tsx', content: UI_FEEDBACK },
      { path: 'src/ui/AuthCard.tsx', content: UI_AUTH_CARD },
      { path: 'src/ui/AppShell.tsx', content: UI_APP_SHELL },
      { path: 'src/ui/AccountMenu.tsx', content: UI_ACCOUNT_MENU },
      { path: 'src/ui/AccountDetails.tsx', content: UI_ACCOUNT_DETAILS },
      { path: 'src/ui/NotFound.tsx', content: UI_NOT_FOUND },
      { path: 'src/pages/LoadingPage.tsx', content: STYLED_LOADING_PAGE },
      { path: 'src/pages/SignInPage.tsx', content: STYLED_SIGN_IN_PAGE },
      { path: 'src/pages/SignedInLayout.tsx', content: STYLED_LAYOUT },
      { path: 'src/pages/HomePage.tsx', content: styledHomePage(privateData) },
      { path: 'src/pages/AccountPage.tsx', content: STYLED_ACCOUNT_PAGE },
      { path: 'src/pages/NotFoundPage.tsx', content: STYLED_NOT_FOUND_PAGE },
    );
    files.push(privateData
      ? { path: 'src/ui/NotesBoard.tsx', content: UI_NOTES_BOARD }
      : { path: 'src/ui/WelcomePanel.tsx', content: UI_WELCOME });
  } else {
    files.push(
      { path: 'src/pages/LoadingPage.tsx', content: HEADLESS_LOADING_PAGE },
      { path: 'src/pages/SignInPage.tsx', content: HEADLESS_SIGN_IN_PAGE },
      { path: 'src/pages/SignedInLayout.tsx', content: HEADLESS_LAYOUT },
      { path: 'src/pages/HomePage.tsx', content: headlessHomePage(privateData) },
      { path: 'src/pages/AccountPage.tsx', content: HEADLESS_ACCOUNT_PAGE },
      { path: 'src/pages/NotFoundPage.tsx', content: HEADLESS_NOT_FOUND_PAGE },
    );
  }

  return files;
}
