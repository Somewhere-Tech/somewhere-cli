// Keep the scaffold and the no-install fallback on the same tested compiler.
// An unversioned `npx typescript` can jump to a new major whose CLI contract
// differs from the tsconfig we generate.
export const TYPECHECK_TYPESCRIPT_VERSION = '5.9.3';
