/** Driver for POST /api/backfill — runs the mechanical backfill to convergence.
 *
 *  Usage (after the endpoint is deployed):
 *    PREWARM_KEY=... node scripts/backfill-run.mjs [--base https://npm.somewhere.tech] [--limit 150] [--max-passes 8]
 *
 *  It: (1) snapshots the worklist, (2) runs full passes — each pass walks the
 *  cursor to the end — and stops when a whole pass changes 0 rows (converged) or
 *  the pass cap is hit, (3) prints a before/after count by verdict level.
 *  Safe to re-run and safe to Ctrl-C: the endpoint is idempotent and resumable. */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1]);
const BASE = (args.get('base') || 'https://npm.somewhere.tech').replace(/\/$/, '');
const LIMIT = parseInt(args.get('limit') || '150', 10);
const MAX_PASSES = parseInt(args.get('max-passes') || '8', 10);
const KEY = process.env.PREWARM_KEY;
if (!KEY) { console.error('Set PREWARM_KEY in the environment.'); process.exit(1); }

const post = async (path) => {
  const r = await fetch(`${BASE}/api/backfill${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j.data;
};
const enc = encodeURIComponent;

const before = (await post('?count=1')).remaining;
console.log('worklist BEFORE:', JSON.stringify(before));

let totalChanged = 0;
for (let pass = 1; pass <= MAX_PASSES; pass++) {
  let cursor = { package: '', version: '' };
  let passChanged = 0;
  let passProcessed = 0;
  for (;;) {
    const d = await post(`?limit=${LIMIT}&after=${enc(cursor.package)}&after_version=${enc(cursor.version)}`);
    passChanged += d.changed;
    passProcessed += d.processed;
    cursor = d.nextCursor;
    process.stdout.write(`\r  pass ${pass}: processed ${passProcessed}, changed ${passChanged}   `);
    if (!d.hasMore) break;
  }
  totalChanged += passChanged;
  console.log(`\r  pass ${pass}: processed ${passProcessed}, changed ${passChanged} — done`);
  if (passChanged === 0) { console.log(`converged after ${pass} pass(es).`); break; }
}

const after = (await post('?count=1')).remaining;
console.log('worklist AFTER: ', JSON.stringify(after));
console.log(`total rows rewritten: ${totalChanged}`);
