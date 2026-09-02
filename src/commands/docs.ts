import { once } from 'node:events';
import { Command } from 'commander';
import { loadConfig } from '../lib/config.js';
import { dim, error, printJson } from '../lib/output.js';
import { callPlatformHelpTool } from './advisor.js';

// Platform docs from the CLI — works with ZERO credentials (tsk_497b7eeb /
// tsk_2ae9dce9 funnel work). The docs are public text URLs on the apex, so an
// anonymous agent that just discovered `--temporary` can learn everything it
// can run without logging in: `somewhere docs start`. Deliberately a plain
// fetch-and-print (no auth, no spinner, raw text to stdout) — the consumer is
// usually a coding agent piping this into context.
const DOCS_BASE = process.env.SOMEWHERE_DOCS_BASE?.replace(/\/$/, '') || 'https://somewhere.tech';

const TOPICS: Record<string, { path: string; blurb: string }> = {
  start: {
    path: '/start.txt',
    blurb: 'Anonymous quickstart — one-command deploy with no account, app shape, what works, how to keep it',
  },
  docs: {
    path: '/docs.txt',
    blurb: 'Full platform reference for agents (large)',
  },
  guides: {
    path: '/guides.txt',
    blurb: 'Recipes and walkthroughs',
  },
  security: {
    path: '/security.txt',
    blurb: 'Security practices and posture',
  },
  migration: {
    path: '/migration.txt',
    blurb: 'How to leave — export everything, portability',
  },
  llms: {
    path: '/llms.txt',
    blurb: 'Everything in one document (very large)',
  },
};

// Aliases so the discovery-hint wording and natural agent guesses all land.
const ALIASES: Record<string, string> = {
  anon: 'start',
  anonymous: 'start',
  temporary: 'start',
  quickstart: 'start',
  help: 'docs',
  all: 'llms',
};

/** The public corpus that carries every manual topic, served unauthenticated.
 *  This is the same material the platform `docs` tool returns, so an anonymous
 *  read is a real answer and not a downgraded one. */
const PUBLIC_CORPUS_PATH = '/llms-full.txt';

/** A manual topic heading in the corpus ends with its key in parentheses:
 *  `## Setup — Install the CLI and connect MCP (setup)`. Method-call headings
 *  (`## sw.fs.versions(path)`) also end in parentheses, so a heading only counts
 *  as a topic boundary when the corpus separator `---` sits right above it. */
const TOPIC_HEADING = /^#{1,3} .*\(([^()]+)\)\s*$/;

export interface PublicTopicSection {
  key: string;
  title: string;
  body: string;
}

function headingKey(line: string): string | null {
  const match = TOPIC_HEADING.exec(line);
  if (!match) return null;
  const key = match[1].trim();
  // Keys are single tokens. `(collaborated projects)` is prose, not a key.
  if (key.length === 0 || key.length > 48 || /\s/.test(key)) return null;
  return key;
}

/** True when `lines[i]` opens a topic: the corpus puts a `---` rule (then at
 *  most a blank line) above every topic heading after the first. */
function isTopicBoundary(lines: readonly string[], i: number): boolean {
  for (let back = i - 1; back >= 0 && back >= i - 2; back--) {
    if (lines[back].trim() === '') continue;
    return lines[back].trim() === '---';
  }
  return false;
}

/** Where each manual topic starts, in document order. */
function topicStarts(lines: readonly string[]): { key: string; index: number }[] {
  const starts: { key: string; index: number }[] = [];
  let seenLibrary = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,2} Topic library\s*$/.test(lines[i])) {
      seenLibrary = true;
      continue;
    }
    const key = headingKey(lines[i]);
    if (key === null) continue;
    // The first topic follows the library header directly, with no rule above.
    if (!isTopicBoundary(lines, i) && !(seenLibrary && starts.length === 0)) continue;
    starts.push({ key, index: i });
  }
  return starts;
}

/** Every manual topic key the public corpus carries, in document order. */
export function publicTopicKeys(corpus: string): string[] {
  const keys: string[] = [];
  for (const { key } of topicStarts(corpus.split('\n'))) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Pull one manual topic out of the public corpus. Matching is on the key in
 *  the heading, case-insensitively, so `docs SETUP` and `docs setup` agree. */
export function findPublicTopicSection(
  corpus: string,
  requested: string,
): PublicTopicSection | null {
  const wanted = requested.trim().toLowerCase();
  if (!wanted) return null;
  const lines = corpus.split('\n');
  const starts = topicStarts(lines);
  const at = starts.findIndex(({ key }) => key.toLowerCase() === wanted);
  if (at === -1) return null;

  const { key, index } = starts[at];
  const end = at + 1 < starts.length ? starts[at + 1].index : lines.length;
  const title = lines[index].replace(/^#{1,3}\s*/, '').trim();
  // Drop the `---` rule that introduces the next topic.
  const body = lines.slice(index, end).join('\n').replace(/\s*\n---\s*$/, '').replace(/\s+$/, '');
  return { key, title, body };
}

/** A stored credential the platform would accept — read WITHOUT `getToken()`,
 *  whose "Not logged in" path exits the process. A docs read must never take
 *  that path: the corpus is public. */
export function hasUsableCredential(): boolean {
  const config = loadConfig();
  if (!config?.token) return false;
  if (config.temporary && config.temp_expires_at
      && new Date(config.temp_expires_at).getTime() <= Date.now()) {
    return false;
  }
  return true;
}

async function fetchPublicCorpus(): Promise<string> {
  const res = await fetch(DOCS_BASE + PUBLIC_CORPUS_PATH);
  if (!res.ok) {
    throw new Error(`Could not fetch ${DOCS_BASE}${PUBLIC_CORPUS_PATH} (HTTP ${res.status}).`);
  }
  return res.text();
}

export async function writeResponseBodyToStdout(res: Response): Promise<void> {
  if (!res.body) return;

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !process.stdout.write(value)) {
        await once(process.stdout, 'drain');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function registerDocs(program: Command) {
  program
    .command('docs [topic]')
    .description(
      'Read platform docs. No login needed — every topic is public. Quick topics: ' +
        Object.keys(TOPICS).join(', ') +
        '. Example manual topic: `somewhere docs sw.db`.',
    )
    .option('--list', 'List available topics instead of streaming documentation')
    .option('--json', 'Print the selected document in a JSON envelope')
    .action(async (topic: string | undefined, opts: { list?: boolean; json?: boolean }) => {
      if (opts.list) {
        if (opts.json) {
          printJson({
            topics: Object.entries(TOPICS).map(([name, entry]) => ({
              name,
              path: entry.path,
              description: entry.blurb,
            })),
          });
          return;
        }
        console.log('Platform docs — no login needed. Usage: somewhere docs <topic>\n');
        for (const [name, t] of Object.entries(TOPICS)) {
          console.log(`  ${name.padEnd(10)} ${t.blurb}`);
        }
        console.log(`\n${dim('No account yet? Start with: somewhere docs start')}`);
        return;
      }
      const requestedTopic = topic ?? 'docs';
      const key = TOPICS[requestedTopic]
        ? requestedTopic
        : ALIASES[requestedTopic.toLowerCase()];
      const entry = key ? TOPICS[key] : undefined;
      if (!entry) {
        // Manual topics (tsk_926fbf8e). The platform tool gives the signed-in
        // read; the SAME material is served unauthenticated in the public
        // corpus. So: use the credential when there is one, and otherwise —
        // or when the authenticated read fails for any reason, auth included —
        // answer from the public corpus. A docs read never says "Not logged
        // in": the docs are public.
        let authenticatedFailure: string | null = null;
        if (hasUsableCredential()) {
          try {
            const content = await callPlatformHelpTool('docs', { topic: requestedTopic });
            if (opts.json) printJson({ topic: requestedTopic, content });
            else process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
            return;
          } catch (e) {
            authenticatedFailure = e instanceof Error ? e.message : String(e);
          }
        }

        try {
          const corpus = await fetchPublicCorpus();
          const section = findPublicTopicSection(corpus, requestedTopic);
          if (section) {
            if (opts.json) {
              printJson({
                topic: section.key,
                url: DOCS_BASE + PUBLIC_CORPUS_PATH,
                source: 'public',
                content: `${section.body}\n`,
              });
            } else {
              process.stdout.write(`${section.body}\n`);
            }
            return;
          }
          const known = publicTopicKeys(corpus);
          error(
            `No documentation topic named "${requestedTopic}".`
            + (known.length ? ` Topics: ${known.join(', ')}.` : '')
            + ' Or run: somewhere docs --list',
          );
          process.exitCode = 1;
        } catch (e) {
          error(authenticatedFailure ?? (e instanceof Error ? e.message : String(e)));
          process.exitCode = 1;
        }
        return;
      }
      try {
        const res = await fetch(DOCS_BASE + entry.path);
        if (!res.ok) {
          error(`Could not fetch ${DOCS_BASE}${entry.path} (HTTP ${res.status}). Try again shortly, or open it in a browser.`);
          process.exit(1);
        }
        if (opts.json) {
          printJson({
            topic: key,
            url: DOCS_BASE + entry.path,
            content: await res.text(),
          });
          return;
        }
        await writeResponseBodyToStdout(res);
      } catch (e) {
        error(`Could not reach ${DOCS_BASE} — check your connection. (${e instanceof Error ? e.message : String(e)})`);
        process.exit(1);
      }
    });
}
