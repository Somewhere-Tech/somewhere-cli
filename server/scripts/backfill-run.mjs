/** Driver for POST /api/backfill — runs the mechanical backfill to convergence.
 *
 *  Usage (after the endpoint is deployed):
 *    PREWARM_KEY=... node scripts/backfill-run.mjs [--base https://npm.somewhere.tech] [--limit 150] [--max-passes 8]
 *
 *  Survives a slow/failed slice: it checks the response is JSON before parsing,
 *  and retries a 5xx or non-JSON body (e.g. a gateway HTML error page) with
 *  exponential backoff instead of crashing. Slice size is clamped so one slice
 *  can't approach the gateway timeout. Safe to re-run and safe to Ctrl-C — the
 *  endpoint is idempotent and resumable. */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1]);
const BASE = (args.get('base') || 'https://npm.somewhere.tech').replace(/\/$/, '');
// Zero-fetch slices are fast, but keep a hard ceiling so a slice can't run long
// enough to hit the gateway timeout even under DB latency.
const LIMIT = Math.min(200, Math.max(1, parseInt(args.get('limit') || '150', 10) || 150));
const MAX_PASSES = parseInt(args.get('max-passes') || '8', 10);
const KEY = process.env.PREWARM_KEY;
if (!KEY) { console.error('Set PREWARM_KEY in the environment.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, tries = 5) {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    let res, text, ct;
    try {
      res = await fetch(`${BASE}/api/backfill${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: '{}',
      });
      ct = res.headers.get('content-type') || '';
      text = await res.text();
    } catch (e) {
      // transport error (reset/timeout) — retry
      if (attempt >= tries) throw new Error(`network error after ${tries} tries: ${e.message}`);
      process.stdout.write(`\n  network error, retry ${attempt}/${tries} in ${delay}ms…`);
      await sleep(delay); delay *= 2; continue;
    }
    // Only trust a 2xx JSON body. A 5xx or an HTML gateway page → retry.
    if (res.ok && ct.includes('application/json')) {
      let j;
      try { j = JSON.parse(text); } catch { j = null; }
      if (j?.ok) return j.data;
      if (j && j.ok === false) throw new Error(`api error: ${JSON.stringify(j).slice(0, 200)}`);
    }
    if (attempt >= tries) {
      throw new Error(`non-JSON/${res.status} after ${tries} tries: ${String(text).slice(0, 120)}`);
    }
    process.stdout.write(`\n  ${res.status} / ${ct || 'no-ct'}, retry ${attempt}/${tries} in ${delay}ms…`);
    await sleep(delay); delay *= 2;
  }
}
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
    process.stdout.write(`\r  pass ${pass}: processed ${passProcessed}, changed ${passChanged}     `);
    if (!d.hasMore) break;
  }
  totalChanged += passChanged;
  console.log(`\r  pass ${pass}: processed ${passProcessed}, changed ${passChanged} — done`);
  if (passChanged === 0) { console.log(`converged after ${pass} pass(es).`); break; }
}

const after = (await post('?count=1')).remaining;
console.log('worklist AFTER: ', JSON.stringify(after));
console.log(`total rows rewritten: ${totalChanged}`);
