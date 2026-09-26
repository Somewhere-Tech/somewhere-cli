import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTypecheck } from '../dist/lib/typecheck.js';

// The generated `sw` type is the platform's own runtime declaration, vendored by
// scripts/vendor-declared-data.mjs (pfb_e53f8065214e). A handler written from the
// docs must typecheck clean against it, and an undeclared binding must still fail:
// the context is a real type, never `any`.
const schema = `export default schema({
  rounds: table({ id: id(), title: text(), votes: integer({ default: 0 }) }, { scope: serverOnly() }),
});`;
const compilerOptions = { strict: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'] };

function project(t, handler, schemaSource = schema) {
  const root = mkdtempSync(join(tmpdir(), 'sw-runtime-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions, include: ['src', 'api'] }),
    'db/schema.ts': schemaSource,
    'src/main.ts': 'export {};',
    'api/handler.ts': handler,
  };
  for (const [file, value] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), value);
  }
  return runTypecheck(root, { installTypePackages: false });
}

const docsHandler = `export default async function (req: Request, sw: SomewhereRuntimeContext) {
  const made = await sw.db.insert('rounds', { title: 'First round' });
  const round = made.data[0];
  if (!round) throw new Error('Insert returned no row');
  const id = String(round.id);
  await sw.db.update('rounds', { increment: { votes: 1 }, where: { id } });
  const open = await sw.db.server.from('rounds', { where: { votes: { gte: 1 } }, order: ['id', 'desc'], limit: 20 });
  const total: number = (await sw.db.server.count('rounds')).data;
  const raw = await sw.db.server.query('SELECT id, title FROM rounds WHERE id = ?', [id]);
  const own = await sw.db.query('SELECT id FROM rounds WHERE id = ?', [id]);
  const batch = await sw.db.server.batch([{ sql: 'SELECT COUNT(*) AS n FROM rounds' }]);
  const login = await sw.auth.loginWithCookie(req, { email: 'reader@example.test', password: 'password' });
  const signedIn = login.mfa_required ? null : login.user.email;
  const tally = await sw.db.aggregate('rounds', { count: true, sum: 'votes', groupBy: ['title'] });
  const sent = await sw.email.send({ to: 'reader@example.test', subject: 'Round closed', text: 'The winner is in.' });
  await sw.db.remove('rounds', { where: { id } });
  return Response.json({ open: open.data, total, raw: raw.data, own: own.count, n: batch[0].data, signedIn, tally: tally.data, sent: sent.id });
}
`;

test('a docs-following handler typechecks clean against the generated sw type', async t => {
  const result = await project(t, docsHandler);
  assert.equal(result.ok, true, result.raw);
});

test('undeclared sw bindings still fail: the generated context is not any', async t => {
  const result = await project(t, `export default async function (req: Request, sw: SomewhereRuntimeContext) {
  sw.nonexistent;
  await sw.db.server.nonexistent('rounds');
  return new Response(null);
}
`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(error => [error.file, error.code]), [['api/handler.ts', 'TS2339'], ['api/handler.ts', 'TS2339']], result.raw);
  assert.match(result.raw, /Property 'nonexistent' does not exist on type 'SomewhereRuntimeContext'/);
  assert.match(result.raw, /Property 'nonexistent' does not exist on type 'SomewhereServerDb'/);
});

// Server reads of declared tables (pfb_d9739a248171): rows carry db/schema.ts's
// declared types, as the browser client's do. The race-7 builder cast 7 of 8
// results; these are its handlers with the casts removed.
const bookclubSchema = `import { id, integer, schema, serverOnly, table, text, timestamp } from 'somewhere/db';
export default schema({
  rounds: table({
    id: id(), organiser_id: text(), organiser_email: text(), status: text({ default: 'open' }),
    open_slot: text({ nullable: true, unique: true }), winner_proposal_id: integer({ nullable: true }),
    meeting_date: text({ nullable: true }), emails_sent: integer({ default: 0 }),
    created_at: timestamp({ default: 'now' }), closed_at: text({ nullable: true }),
  }, { scope: serverOnly() }),
  proposals: table({
    id: id(), round_id: integer({ references: 'rounds' }), title: text(), author: text(), pitch: text(),
    proposer_id: text(), proposer_email: text(), created_at: timestamp({ default: 'now' }),
  }, { scope: serverOnly(), indexes: [['round_id']] }),
  votes: table({
    id: id(), round_id: integer({ references: 'rounds' }), user_id: text(),
    proposal_id: integer({ references: 'proposals' }), created_at: timestamp({ default: 'now' }),
  }, { scope: serverOnly(), unique: [['round_id', 'user_id']] }),
});`;
const bookclubHandler = `async function openRound(sw: SomewhereRuntimeContext) {
  const { data } = await sw.db.from('rounds', { where: { status: 'open' }, order: [['id', 'desc']], limit: 1 });
  return data[0] ?? null;
}
const escapeHtml = (value: string) => value.replace(/[&<>]/g, '');
export const close = sw.endpoint({
  auth: 'required',
  body: { proposal_id: 'number' },
  handler: async ({ body, user }, sw) => {
    const round = await openRound(sw);
    if (!round) throw new Error('No open round');
    const organiser: boolean = round.organiser_id === user.id;
    const props = await sw.db.from('proposals', { where: { round_id: round.id }, order: [['id', 'asc']], limit: 200 });
    const tally = await sw.db.aggregate('votes', { count: true, groupBy: ['proposal_id'], where: { round_id: round.id }, limit: 100 });
    const counts = new Map(tally.data.map(row => [Number(row.proposal_id), Number(row.count)]));
    const winner = props.data[0];
    if (!winner) throw new Error('No proposals');
    await sw.db.update('rounds', { where: { id: round.id }, set: { status: 'closed', open_slot: null, winner_proposal_id: winner.id } });
    await sw.db.insert('rounds', { organiser_id: user.id, organiser_email: user.email ?? '', open_slot: 'open' }, { onConflict: 'ignore' });
    const html = escapeHtml(winner.title) + escapeHtml(winner.author) + escapeHtml(winner.pitch);
    const { data: [proposal] } = await sw.db.from('proposals', { where: { id: body.proposal_id, round_id: round.id }, limit: 1 });
    if (proposal) await sw.db.insert('votes', { round_id: round.id, user_id: user.id, proposal_id: proposal.id }, { onConflict: 'update' });
    const closedRounds = await sw.db.from('rounds', { where: { status: 'closed' }, order: [['id', 'desc']], limit: 10 });
    const winnerIds = closedRounds.data.map(r => r.winner_proposal_id).filter(v => v != null);
    const winners = winnerIds.length ? (await sw.db.from('proposals', { where: { id: { in: winnerIds } }, limit: 10 })).data : [];
    return { organiser, html, counts: counts.size, winners: winners.map(w => ({ title: w.title, author: w.author })) };
  },
});
`;

test('declared tables: server rows, writes and aggregates typecheck with no casts', async t => {
  const result = await project(t, bookclubHandler, bookclubSchema);
  assert.equal(result.ok, true, result.raw);
});

test('declared tables: an undeclared table and a mistyped column are type errors', async t => {
  const expectations = `export default async function (req: Request, sw: SomewhereRuntimeContext) {
  // @ts-expect-error db/schema.ts does not declare this table.
  await sw.db.from('nope');
  const { data: [round] } = await sw.db.server.from('rounds', { limit: 1 });
  // @ts-expect-error title is a declared text column.
  const votes: number | undefined = round?.title;
  return Response.json({ votes });
}
`;
  const clean = await project(t, expectations);
  assert.equal(clean.ok, true, clean.raw);
  const result = await project(t, expectations.replace(/^.*@ts-expect-error.*\n/gm, ''));
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(error => [error.file, error.code]), [['api/handler.ts', 'TS2345'], ['api/handler.ts', 'TS2322']], result.raw);
  assert.match(result.raw, /Argument of type '"nope"' is not assignable to parameter of type '"rounds"'/);
});

// Drift check: the vendored bytes must equal a fresh bundle of the platform's
// runtime-types source. Set SOMEWHERE_PLATFORM_SOURCE to a platform checkout
// (with the compiler's pinned esbuild installed) before cutting a CLI release.
const platformSource = process.env.SOMEWHERE_PLATFORM_SOURCE;
test('vendored runtime declaration matches the platform source', { skip: platformSource ? false : 'SOMEWHERE_PLATFORM_SOURCE is not set' }, () => {
  const script = new URL('../scripts/vendor-declared-data.mjs', import.meta.url).pathname;
  const output = execFileSync(process.execPath, [script, platformSource, '--check'], { encoding: 'utf8' });
  assert.match(output, /parity verified/);
});
