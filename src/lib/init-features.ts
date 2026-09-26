// The module menu for `somewhere init --features`. A const table, not a
// plugin system: each module names what it requires, and the resolver adds
// those requirements and reports them. Files come from init-feature-template.ts.

export const INIT_MODULE_IDS = ['auth', 'private-data'] as const;
export type InitModuleId = (typeof INIT_MODULE_IDS)[number];

export const INIT_UI_MODES = ['styled', 'headless'] as const;
export type InitUiMode = (typeof INIT_UI_MODES)[number];

interface InitModuleDefinition {
  id: InitModuleId;
  summary: string;
  requires: readonly InitModuleId[];
}

const MODULES: readonly InitModuleDefinition[] = [
  {
    id: 'auth',
    summary: 'Email/password sign-up, sign-in and sign-out through the SDK cookie session: the packaged /api/auth route, an auth provider and hooks, sign-in and account pages, and a signed-out gate with a loading state.',
    requires: [],
  },
  {
    id: 'private-data',
    summary: 'A notes table each signed-in user owns (db/schema.ts owner()), read and written from the browser through the generated somewhere:data client, with validation, error mapping and no-change results.',
    requires: ['auth'],
  },
];

const UI_MODES: readonly { id: InitUiMode; summary: string }[] = [
  { id: 'styled', summary: 'Presentational components in src/ui and design tokens in src/styles/tokens.css. Restyle or delete them without touching auth or data behaviour.' },
  { id: 'headless', summary: 'Same types, services, hooks and routing; pages use plain semantic markup and there is no CSS, for an app that brings its own UI.' },
];

// Listed so an agent reading the catalog does not invent them from scratch.
const NOT_OFFERED: readonly { id: string; reason: string }[] = [
  { id: 'private-files', reason: 'Not offered by init yet; see `somewhere docs declared-files`.' },
  { id: 'password-reset', reason: 'Not generated. Build it on the documented auth contract (`somewhere docs sw.auth`).' },
  { id: 'oauth', reason: 'Not generated. See `somewhere docs auth-client`.' },
  { id: 'mfa', reason: 'Not generated.' },
  { id: 'payments', reason: 'Not generated. See `somewhere docs payments`.' },
  { id: 'teams', reason: 'Not generated. See member() scopes in `somewhere docs declared-data`.' },
  { id: 'public-sharing', reason: 'Not generated. See publicRead in `somewhere docs declared-data`.' },
];

export interface InitSelection {
  /** Module ids as the caller asked for them, deduplicated, in registry order. */
  requested: InitModuleId[];
  /** Modules added because a requested module requires them. */
  added: InitModuleId[];
  /** Every module that will be generated, in registry order. */
  modules: InitModuleId[];
  ui: InitUiMode;
}

/** A usage error: the command exits 2 before any login, request or write. */
export class InitSelectionError extends Error {}

function isModuleId(value: string): value is InitModuleId {
  return (INIT_MODULE_IDS as readonly string[]).includes(value);
}

function isUiMode(value: string): value is InitUiMode {
  return (INIT_UI_MODES as readonly string[]).includes(value);
}

export function resolveInitSelection(features: string, ui = 'styled'): InitSelection {
  const ids = features.split(',').map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new InitSelectionError(`--features needs at least one module: ${INIT_MODULE_IDS.join(', ')}.`);
  }
  const unknown = ids.filter((id) => !isModuleId(id));
  if (unknown.length) {
    const offered = NOT_OFFERED.filter((entry) => unknown.includes(entry.id));
    const detail = offered.map((entry) => ` ${entry.id}: ${entry.reason}`).join('');
    throw new InitSelectionError(
      `Unknown --features ${unknown.join(', ')}. Available: ${INIT_MODULE_IDS.join(', ')}.${detail}`,
    );
  }
  if (!isUiMode(ui)) {
    throw new InitSelectionError(`Unknown --ui ${ui}. Use one of: ${INIT_UI_MODES.join(', ')}.`);
  }

  const wanted = new Set(ids as InitModuleId[]);
  const selected = new Set<InitModuleId>();
  const visit = (id: InitModuleId) => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dependency of moduleDefinition(id).requires) visit(dependency);
  };
  for (const id of wanted) visit(id);

  const inOrder = (set: Set<InitModuleId>) => INIT_MODULE_IDS.filter((id) => set.has(id));
  return {
    requested: inOrder(wanted),
    added: INIT_MODULE_IDS.filter((id) => selected.has(id) && !wanted.has(id)),
    modules: inOrder(selected),
    ui,
  };
}

function moduleDefinition(id: InitModuleId): InitModuleDefinition {
  return MODULES.find((entry) => entry.id === id)!;
}

export interface InitCatalog {
  version: 1;
  command: string;
  modules: { id: InitModuleId; summary: string; requires: InitModuleId[]; files: string[] }[];
  ui: { id: InitUiMode; summary: string; files: string[] }[];
  defaults: { ui: InitUiMode };
  not_offered: { id: string; reason: string }[];
}

/**
 * The machine-readable menu. `filesFor` lists the paths a selection writes;
 * each module's `files` are the paths it adds over its requirements (styled),
 * and each UI mode's `files` are the paths only that mode writes.
 */
export function initCatalog(filesFor: (selection: InitSelection) => string[]): InitCatalog {
  const selection = (modules: InitModuleId[], ui: InitUiMode = 'styled'): InitSelection =>
    ({ requested: modules, added: [], modules, ui });
  const difference = (all: string[], base: string[]) => all.filter((path) => !base.includes(path)).sort();
  const everything = [...INIT_MODULE_IDS];
  return {
    version: 1,
    command: 'somewhere init --name <slug> --features <ids> [--ui styled|headless] [--dry-run] [--json]',
    modules: MODULES.map((entry) => ({
      id: entry.id,
      summary: entry.summary,
      requires: [...entry.requires],
      files: difference(
        filesFor(selection([...entry.requires, entry.id])),
        entry.requires.length ? filesFor(selection([...entry.requires])) : [],
      ),
    })),
    ui: UI_MODES.map((mode) => ({
      id: mode.id,
      summary: mode.summary,
      files: difference(
        filesFor(selection(everything, mode.id)),
        filesFor(selection(everything, mode.id === 'styled' ? 'headless' : 'styled')),
      ),
    })),
    defaults: { ui: 'styled' },
    not_offered: NOT_OFFERED.map((entry) => ({ ...entry })),
  };
}

/** One line for humans: "auth, private-data (auth added: required by private-data) · ui styled". */
export function describeSelection(selection: InitSelection): string {
  const added = selection.added.map((id) => {
    const by = selection.requested.filter((requested) => moduleDefinition(requested).requires.includes(id));
    return `${id} added: required by ${by.join(', ')}`;
  });
  return `${selection.modules.join(', ')}${added.length ? ` (${added.join('; ')})` : ''} · ui ${selection.ui}`;
}
