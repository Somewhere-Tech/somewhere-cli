/** Local dev server for the verdict API — mounts the real route handlers with
 *  an in-memory stand-in for D1, so you can run the actual CLI against it with
 *  live npm/OSV/GitHub data before deploying:
 *
 *    GITHUB_TOKEN=$(gh auth token) node server/scripts/local-serve.mjs &
 *    SWPX_VERDICT_URL=http://localhost:8787 node bin/swpx.js check left-pad --json
 *
 *  Not deployed; a developer convenience only. The in-memory cache resets on
 *  restart. Requires Node 18+ (global Request/Response/fetch). */

import { createServer } from 'node:http';
import singleHandler from '../api/verdict/[pkg]/[version].js';
import batchHandler from '../api/verdict/batch.js';
import prewarmHandler from '../api/admin/prewarm.js';

const PORT = Number(process.env.PORT) || 8787;

const COLUMNS = [
  'package', 'version', 'computed_at', 'has_provenance', 'provenance_commit', 'provenance_repo',
  'has_install_scripts', 'install_script_types', 'is_minified', 'capabilities', 'typosquat_of',
  'typosquat_distance', 'has_github_tag', 'github_repo', 'publish_time', 'publisher', 'description',
  'description_match', 'description_match_reason', 'diff_review', 'diff_review_reason',
  'diff_from_version', 'weekly_downloads', 'verdict', 'verdict_signals',
];

/** Minimal in-memory sw.db that understands exactly the two statements db.mjs emits. */
function makeDb() {
  const store = new Map();
  return {
    query: async (sql, params) => {
      if (sql.startsWith('SELECT')) {
        const [name, version] = params;
        const row = store.get(`${name}@${version}`);
        return { data: row ? [row] : [] };
      }
      if (sql.startsWith('INSERT')) {
        const row = Object.fromEntries(COLUMNS.map((c, i) => [c, params[i]]));
        store.set(`${row.package}@${row.version}`, row);
        return { changes: 1 };
      }
      return { data: [] };
    },
  };
}

const sw = {
  env: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    PREWARM_KEY: process.env.PREWARM_KEY,
    TOP_PACKAGES_URL: process.env.TOP_PACKAGES_URL,
  },
  db: makeDb(),
};

function route(pathname, method) {
  if (method === 'GET' && /^\/api\/verdict\/[^/]+\/[^/]+$/.test(pathname)) return singleHandler;
  if (method === 'POST' && pathname === '/api/verdict/batch') return batchHandler;
  if (method === 'POST' && pathname === '/api/admin/prewarm') return prewarmHandler;
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handler = route(url.pathname, req.method);
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
  const request = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  try {
    const response = await handler(request, sw);
    const text = await response.text();
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
    res.end(text);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'HANDLER_THREW', message: String(err?.stack || err) }));
  }
});

server.listen(PORT, () => console.error(`verdict API (local) on http://localhost:${PORT}`));
