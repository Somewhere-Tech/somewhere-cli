/**
 * Local-typecheck scaffolding for a pulled project tree.
 *
 * `somewhere pull` brings down raw source but no tsconfig.json / package.json,
 * so a local `tsc --noEmit` has nothing to run against — a dropped import
 * (TS2304 "X is not defined") sails through and only 500s in production. This
 * writes the two files a typecheck needs, lenient enough that untyped esm.sh
 * deps don't drown the real "undefined symbol" signal:
 *   - skipLibCheck            — don't typecheck dep .d.ts (and most deps ship none)
 *   - noImplicitAny: false    — untyped imports become `any`, not errors
 *   - moduleResolution bundler + jsx react-jsx — match the deploy compiler
 *
 * Both files are written ONLY when absent. A project that ships its own
 * tsconfig.json / package.json keeps it untouched.
 */

import { TYPECHECK_TYPESCRIPT_VERSION } from './typecheck-version.js';

export const SCAFFOLD_TSCONFIG_FILENAME = 'tsconfig.json';
export const SCAFFOLD_PACKAGE_FILENAME = 'package.json';

/**
 * The lenient tsconfig that catches undefined symbols (TS2304) without
 * flagging every untyped dependency import. Returned as a pretty JSON string.
 */
export function buildScaffoldTsconfig(): string {
  const config = {
    // Written by `somewhere pull` so `tsc --noEmit` / `somewhere typecheck`
    // can catch undefined symbols before deploy. Edit freely — it's yours now.
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      jsx: 'react-jsx',
      strict: true,
      // Lenient where untyped esm.sh deps would otherwise create noise that
      // buries the real "undefined symbol" errors we care about.
      noImplicitAny: false,
      skipLibCheck: true,
      allowJs: true,
      checkJs: false,
      esModuleInterop: true,
      resolveJsonModule: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
    },
    // TypeScript 5.9.3 and 7.1-dev both returned TS18003 for a fresh Vite
    // src/main.tsx when this was the bare directory string ".".
    include: ['**/*'],
    exclude: ['node_modules', 'dist', 'build'],
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * A minimal package.json carrying whatever deps we could recover. `deps` comes
 * from a pulled package.json if the project shipped one; otherwise empty (the
 * lenient tsconfig treats unresolved imports as `any`, so a typecheck still
 * runs and still catches local undefined-symbol bugs).
 */
export function buildScaffoldPackageJson(
  projectName: string,
  deps: Record<string, string>,
): string {
  const pkg = {
    name: sanitizePackageName(projectName),
    private: true,
    version: '0.0.0',
    type: 'module',
    // Scaffolded by `somewhere pull` for local typechecking. Your deployed
    // dependency versions live on the platform; this mirrors them when known.
    dependencies: deps,
    devDependencies: {
      typescript: TYPECHECK_TYPESCRIPT_VERSION,
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

/** npm package names: lowercase, no spaces, safe charset. */
export function sanitizePackageName(name: string): string {
  const cleaned = String(name || 'somewhere-project')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return cleaned || 'somewhere-project';
}

/**
 * Pull a `dependencies` map out of a pulled package.json's raw text, if one
 * was in the project source. Returns {} on anything unparseable — the
 * scaffold stays lenient by design, so a missing/garbled deps map is fine.
 */
export function extractDeps(packageJsonText: string | undefined): Record<string, string> {
  if (!packageJsonText) return {};
  try {
    const parsed = JSON.parse(packageJsonText) as {
      dependencies?: Record<string, string>;
    };
    const deps = parsed.dependencies;
    if (deps && typeof deps === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(deps)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // unparseable — fall through to empty
  }
  return {};
}
