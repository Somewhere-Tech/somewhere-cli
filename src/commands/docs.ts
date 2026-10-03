import { fetchWithProxy as fetch } from '../lib/http.js';
import { once } from 'node:events';
import { Command } from 'commander';
import { loadConfig } from '../lib/config.js';
import { dim, error, printJson, printJsonError } from '../lib/output.js';
import { cachedLatestVersion, isMinorBehind, NPM_UPDATE_COMMAND } from '../lib/notify/providers/update.js';
import { CLI_VERSION } from '../lib/version.js';
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

/** Generated from PLATFORM_HELP_TOPICS and served without credentials. Each
 * page carries its actual canonical body; do not reconstruct topics from
 * references in the long-form corpus. */
const PUBLIC_MANIFEST_PATH = '/docs-manifest.json';

export interface PublicDocsSection {
  id: string;
  heading: string;
  start: number;
  end: number;
}

export interface PublicDocsPage {
  id: string;
  title: string;
  section: string | null;
  body: string;
  /** Compact default view, when the platform publishes one. */
  summary?: string;
  summary_complete?: boolean;
  /** Offsets into `body`; each section includes its nested subsections. */
  sections?: PublicDocsSection[];
}

export type DocsView = { kind: 'default' } | { kind: 'full' } | { kind: 'section'; id: string };

interface RenderedDocs {
  content: string;
  view?: string;
  complete?: boolean;
  failure?: DocsFailure;
}

interface DocsFailure {
  error: 'DOCS_SECTION_INDEX_UNAVAILABLE' | 'DOCS_SECTION_NOT_FOUND' | 'DOCS_TOPIC_NOT_FOUND';
  message: string;
  hint: string;
  matches?: string[];
}

const DOCS_SECTION_MAX_CHARS = 12000;

/** Edit distance with a lexical tie-break keeps recovery suggestions stable. */
function closestMatches(wanted: string, candidates: string[]): string[] {
  const query = wanted.trim().toLowerCase();
  const distance = (candidate: string): number => {
    let row = Array.from({ length: query.length + 1 }, (_, index) => index);
    for (const char of candidate.toLowerCase()) {
      const next = [row[0] + 1];
      for (let index = 1; index <= query.length; index++) {
        next[index] = Math.min(next[index - 1] + 1, row[index] + 1,
          row[index - 1] + (char === query[index - 1] ? 0 : 1));
      }
      row = next;
    }
    return row[query.length];
  };
  return [...new Set(candidates)].map((id) => ({ id, score: distance(id) }))
    .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 3).map(({ id }) => id);
}

function commandArg(value: string): string {
  return /^[a-zA-Z0-9._-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function reportDocsFailure(failure: DocsFailure, json: boolean, topic: string): void {
  if (json) {
    printJsonError(failure.error, failure.message, {
      topic, hint: failure.hint, ...(failure.matches ? { matches: failure.matches } : {}),
    });
  } else {
    error(failure.message);
    console.error(failure.hint);
  }
  process.exitCode = 1;
}

function parseSections(value: unknown, bodyLength: number): PublicDocsSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value.filter((entry): entry is PublicDocsSection => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.id === 'string' && candidate.id.trim().length > 0
      && typeof candidate.heading === 'string' && candidate.heading.trim().length > 0
      && Number.isInteger(candidate.start) && Number.isInteger(candidate.end)
      && (candidate.start as number) >= 0 && (candidate.start as number) < (candidate.end as number)
      && (candidate.end as number) <= bodyLength;
  });
  return sections.map(({ id, heading, start, end }) => ({ id, heading, start, end }));
}

/** Render indexed public views without expanding a failed section request. */
export function renderPublicDocsView(page: PublicDocsPage, view: DocsView): RenderedDocs {
  if (view.kind === 'full') return { content: renderPublicPage(page), view: 'full', complete: true };
  if (view.kind === 'default') {
    return page.summary
      ? { content: withNewline(page.summary), view: 'summary', complete: page.summary_complete === true }
      : { content: renderPublicPage(page), view: 'full', complete: true };
  }
  const sections = parseSections(page.sections, page.body.length);
  const fail = (failure: DocsFailure): RenderedDocs => ({
    content: '', view: 'section', complete: false, failure,
  });
  if (!sections?.length) {
    return fail({
      error: 'DOCS_SECTION_INDEX_UNAVAILABLE',
      message: `No usable section index for "${page.id}".`,
      hint: `Run: somewhere docs ${commandArg(page.id)} --full`,
    });
  }
  const wanted = view.id.trim().replace(/^#+\s*/, '').toLowerCase();
  const match = sections.find((section) => section.id.toLowerCase() === wanted)
    ?? sections.find((section) => headingText(section).toLowerCase() === wanted);
  if (!match) {
    const matches = closestMatches(wanted, sections.map(({ id }) => id));
    return fail({
      error: 'DOCS_SECTION_NOT_FOUND',
      message: `No section "${view.id}" in ${page.id}. Closest sections: ${matches.join(', ')}.`,
      matches,
      hint: `Run: somewhere docs ${commandArg(page.id)} --section ${commandArg(matches[0])}`,
    });
  }
  const text = page.body.slice(match.start, match.end);
  const children = sections.filter((section) => section.start > match.start && section.end <= match.end)
    .sort((a, b) => a.start - b.start);
  if (text.trimEnd().length > DOCS_SECTION_MAX_CHARS && children.length > 0) {
    const kilo = (chars: number): string => chars < 1000 ? `${chars}` : `${(chars / 1000).toFixed(1)}k`;
    const lead = page.body.slice(match.start, children[0].start).trimEnd();
    const index = children.map((section) => `- ${section.id} · ${kilo(section.end - section.start)}`).join('\n');
    return {
      content: `${lead}\n\nThis section is ${kilo(text.trimEnd().length)} chars; its subsections (id · size):\n`
        + `${index}\n\nOne subsection: somewhere docs ${commandArg(page.id)} --section <id>\n`,
      view: 'section', complete: false,
    };
  }
  return { content: withNewline(text), view: 'section', complete: false };
}

/** The platform prefixes docs tool responses with
 *  `[docs] topic=<t> view=<v> complete=<bool> ...`; older platforms do not. */
export function parseDocsStatusLine(content: string): { view?: string; complete?: boolean } {
  const first = /^\[docs\][^\n]*/.exec(content)?.[0];
  if (!first) return {};
  const view = /\bview=([a-z]+)/.exec(first)?.[1];
  const complete = /\bcomplete=(true|false)\b/.exec(first)?.[1];
  return {
    ...(view ? { view } : {}),
    ...(complete ? { complete: complete === 'true' } : {}),
  };
}

/** Manifest headings are the raw markdown line (`## Reads`). */
function headingText(section: PublicDocsSection): string {
  return section.heading.replace(/^#+\s*/, '').trim();
}

function withNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function parsePublicDocsManifest(value: unknown): PublicDocsPage[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { pages?: unknown }).pages)) {
    throw new Error('Public docs manifest is missing its pages array.');
  }
  return (value as { pages: unknown[] }).pages.map((page, index) => {
    if (!page || typeof page !== 'object') {
      throw new Error(`Public docs manifest page ${index} is not an object.`);
    }
    const candidate = page as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || !candidate.id
        || typeof candidate.title !== 'string' || !candidate.title
        || (candidate.section !== null && (typeof candidate.section !== 'string' || !candidate.section))
        || typeof candidate.body !== 'string' || !candidate.body) {
      throw new Error(`Public docs manifest page ${index} is missing id, title, section, or body.`);
    }
    const sections = parseSections(candidate.sections, candidate.body.length);
    return {
      id: candidate.id,
      title: candidate.title,
      section: candidate.section,
      body: candidate.body,
      ...(typeof candidate.summary === 'string' && candidate.summary ? { summary: candidate.summary } : {}),
      ...(typeof candidate.summary_complete === 'boolean' ? { summary_complete: candidate.summary_complete } : {}),
      ...(sections ? { sections } : {}),
    };
  });
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

export interface PublicDocsGroup {
  id: string;
  title: string;
  pages: string[];
}

/** The manifest's reading-order groups. Older manifests have none; the index
 *  then groups by each page's own `section`. */
export function parsePublicDocsGroups(value: unknown): PublicDocsGroup[] {
  const groups = value && typeof value === 'object' ? (value as { sections?: unknown }).sections : undefined;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group): PublicDocsGroup[] => {
    if (!group || typeof group !== 'object') return [];
    const { id, title, pages } = group as Record<string, unknown>;
    if (typeof id !== 'string' || typeof title !== 'string' || !Array.isArray(pages)) return [];
    return [{ id, title, pages: pages.filter((page): page is string => typeof page === 'string') }];
  });
}

async function fetchPublicManifestWithGroups(): Promise<{ pages: PublicDocsPage[]; groups: PublicDocsGroup[] }> {
  const res = await fetch(DOCS_BASE + PUBLIC_MANIFEST_PATH, {
    headers: { 'User-Agent': 'somewhere-cli' },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch ${DOCS_BASE}${PUBLIC_MANIFEST_PATH} (HTTP ${res.status}).`);
  }
  try {
    const body = await res.json() as unknown;
    return { pages: parsePublicDocsManifest(body), groups: parsePublicDocsGroups(body) };
  } catch (cause) {
    throw new Error(`Could not read ${DOCS_BASE}${PUBLIC_MANIFEST_PATH}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function fetchPublicManifest(): Promise<PublicDocsPage[]> {
  return (await fetchPublicManifestWithGroups()).pages;
}

/** The topic index: every public topic with its one-line title, in the
 *  manifest's reading order, plus how to open a topic, a section, or search.
 *  This is what bare `somewhere docs` prints — the full manual is ~18k lines
 *  and only appears behind an explicit `--full` (tsk_a86f8a12). */
export function renderDocsIndex(pages: PublicDocsPage[], groups: PublicDocsGroup[]): string {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const listed = new Set<string>();
  const blocks: Array<{ title: string; pages: PublicDocsPage[] }> = [];
  for (const group of groups) {
    const members = group.pages.map((id) => byId.get(id)).filter((page): page is PublicDocsPage => Boolean(page));
    members.forEach((page) => listed.add(page.id));
    if (members.length) blocks.push({ title: group.title, pages: members });
  }
  const rest = pages.filter((page) => !listed.has(page.id));
  if (rest.length) blocks.push({ title: groups.length ? 'Other topics' : 'Topics', pages: rest });
  const width = Math.max(0, ...pages.map(({ id }) => id.length));
  const lines = ['Platform docs — no login needed.', '', 'Public topics:'];
  for (const block of blocks) {
    lines.push('', `${block.title}`);
    for (const page of block.pages) lines.push(`  ${page.id.padEnd(width)}  ${page.title}`);
  }
  lines.push('', 'Quick links:');
  for (const [name, entry] of Object.entries(TOPICS)) lines.push(`  ${name.padEnd(10)} ${entry.blurb}`);
  lines.push(
    '',
    'Open a topic:     somewhere docs <topic>                 (summary with its section ids)',
    'Open a section:   somewhere docs <topic> --section <id>',
    'Whole topic:      somewhere docs <topic> --full',
    'Search all docs:  somewhere docs search <term>',
    'Full manual:      somewhere docs --full                  (very large)',
  );
  return lines.join('\n') + '\n';
}

export interface DocsSearchResult {
  topic: string;
  title: string;
  section: string | null;
  heading: string | null;
  snippet: string;
  open: string;
}

const DOCS_SEARCH_LIMIT = 20;
const SNIPPET_RADIUS = 90;

/** Case-insensitive search over the public manifest. Every word must appear
 *  in the same section; each hit is reported against the innermost section
 *  that contains its first match, with the command that opens it. Title and
 *  heading hits rank first, then the number of occurrences. */
export function searchPublicDocs(pages: PublicDocsPage[], query: string): DocsSearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: Array<DocsSearchResult & { score: number }> = [];
  for (const page of pages) {
    const sections = parseSections(page.sections, page.body.length) ?? [];
    const lower = page.body.toLowerCase();
    // Leaf spans: the body split at every section start, so each match maps to
    // the innermost section that contains it.
    const starts = [...new Set([0, ...sections.map((section) => section.start)])].sort((a, b) => a - b);
    const seen = new Set<string>();
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index];
      const end = starts[index + 1] ?? page.body.length;
      const span = lower.slice(start, end);
      if (!words.every((word) => span.includes(word))) continue;
      const innermost = sections
        .filter((section) => section.start <= start && section.end >= end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      const key = innermost?.id ?? '';
      if (seen.has(key)) continue;
      seen.add(key);
      const at = start + span.indexOf(words[0]);
      const from = Math.max(0, at - SNIPPET_RADIUS);
      const to = Math.min(page.body.length, at + words[0].length + SNIPPET_RADIUS);
      const snippet = `${from > 0 ? '…' : ''}${page.body.slice(from, to).replace(/\s+/g, ' ').trim()}${to < page.body.length ? '…' : ''}`;
      const heading = innermost ? headingText(innermost) : null;
      const occurrences = words.reduce((count, word) => count + span.split(word).length - 1, 0);
      const titleHit = words.every((word) => `${page.id} ${page.title} ${heading ?? ''}`.toLowerCase().includes(word));
      scored.push({
        topic: page.id,
        title: page.title,
        section: innermost?.id ?? null,
        heading,
        snippet,
        open: innermost
          ? `somewhere docs ${commandArg(page.id)} --section ${commandArg(innermost.id)}`
          : `somewhere docs ${commandArg(page.id)} --full`,
        score: (titleHit ? 1000 : 0) + occurrences,
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
    .slice(0, DOCS_SEARCH_LIMIT)
    .map(({ score: _score, ...result }) => result);
}

/** Published docs describe the latest CLI. When this CLI is a minor release or
 *  more behind, say so before the agent concludes the docs are wrong
 *  (tsk_f681c871). Reads the cached latest version only, so docs never wait on
 *  the network; honors CI and the notifications opt-out; never fails the read. */
function warnIfDocsNewerThanCli(): void {
  if (process.env.CI || process.env.SOMEWHERE_NO_NOTIFICATIONS) return;
  try {
    const latest = cachedLatestVersion();
    if (latest && isMinorBehind(CLI_VERSION, latest)) {
      console.error(
        `! These docs describe somewhere CLI ${latest}; this CLI is ${CLI_VERSION}, so some commands or flags `
        + `shown here may not exist in it yet. Update with: somewhere update (or ${NPM_UPDATE_COMMAND})`,
      );
    }
  } catch {
    // the version check is advisory
  }
}

function renderPublicPage(page: PublicDocsPage): string {
  return `# ${page.title}\n\n${page.body.trimEnd()}\n`;
}

export async function writeResponseBodyToStdout(res: Pick<Response, 'body'>): Promise<void> {
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
    .command('docs [topic] [terms...]')
    .description(
      'Read platform docs. No login needed — every topic is public. With no topic, prints the topic index. '
        + 'Search with `somewhere docs search <term>`. Quick topics: '
        + Object.keys(TOPICS).join(', ')
        + '. Example manual topic: `somewhere docs sw.db`.',
    )
    .option('--list', 'List available topics (the same index bare `somewhere docs` prints)')
    .option('--full', 'Print the complete topic instead of its summary; with no topic, the full manual')
    .option('--section <id>', 'Print one section of a topic (ids are listed in the summary)')
    .option('--json', 'Print the selected document in a JSON envelope')
    .addHelpText('after', '\nExamples:\n'
      + '  somewhere docs                         # topic index\n'
      + '  somewhere docs search magic link       # matching sections across every topic\n'
      + '  somewhere docs sw.auth                 # topic summary with section ids\n'
      + '  somewhere docs sw.auth --section <id>  # one section\n'
      + '  somewhere docs --full                  # the whole manual (very large)\n'
      + '\n`somewhere docs search` with no term opens the search primitive topic.\n')
    .action(async (
      topic: string | undefined,
      terms: string[],
      opts: { list?: boolean; full?: boolean; section?: string; json?: boolean },
    ) => {
      if (opts.full && opts.section !== undefined) {
        error('Pass --full or --section <id>, not both.');
        process.exitCode = 1;
        return;
      }
      const searching = topic === 'search' && terms.length > 0;
      if (terms.length > 0 && !searching) {
        error(`Unexpected argument "${terms[0]}". Open one topic at a time, or search: somewhere docs search ${terms.join(' ')}`);
        process.exitCode = 1;
        return;
      }
      warnIfDocsNewerThanCli();
      if (searching) {
        if (opts.full || opts.section !== undefined || opts.list) {
          error('docs search takes only a term (and --json).');
          process.exitCode = 1;
          return;
        }
        const query = terms.join(' ');
        try {
          const results = searchPublicDocs(await fetchPublicManifest(), query);
          if (opts.json) {
            printJson({ query, count: results.length, results });
            return;
          }
          if (!results.length) {
            console.log(`No docs sections mention "${query}". Browse the index: somewhere docs`);
            return;
          }
          for (const result of results) {
            console.log(`${result.topic}${result.section ? ` › ${result.section}` : ''}  ${dim(result.heading ?? result.title)}`);
            console.log(`  ${result.snippet}`);
            console.log(`  ${dim(result.open)}`);
          }
          if (results.length === DOCS_SEARCH_LIMIT) {
            console.log(dim(`Showing the first ${DOCS_SEARCH_LIMIT} matches; add a word to narrow the search.`));
          }
        } catch (e) {
          error(e instanceof Error ? e.message : String(e), e);
          process.exitCode = 1;
        }
        return;
      }
      const view: DocsView = opts.section !== undefined
        ? { kind: 'section', id: opts.section }
        : opts.full ? { kind: 'full' } : { kind: 'default' };
      if (opts.list || (topic === undefined && view.kind === 'default')) {
        try {
          const { pages, groups } = await fetchPublicManifestWithGroups();
          const quickLinks = Object.entries(TOPICS).map(([name, entry]) => ({
            name,
            path: entry.path,
            description: entry.blurb,
          }));
          if (opts.json) {
            printJson({
              topics: pages.map(({ id, title, section }) => ({
                name: id,
                title,
                section,
                source: PUBLIC_MANIFEST_PATH,
              })),
              quick_links: quickLinks,
            });
            return;
          }
          process.stdout.write(renderDocsIndex(pages, groups));
          console.log(`\n${dim('No account yet? Start with: somewhere docs start')}`);
        } catch (e) {
          error(e instanceof Error ? e.message : String(e), e);
          process.exitCode = 1;
        }
        return;
      }
      const requestedTopic = topic ?? 'docs';
      const key = TOPICS[requestedTopic]
        ? requestedTopic
        : ALIASES[requestedTopic.toLowerCase()];
      const entry = key ? TOPICS[key] : undefined;
      if (entry && view.kind === 'section') {
        reportDocsFailure({
          error: 'DOCS_SECTION_INDEX_UNAVAILABLE',
          message: `"${requestedTopic}" is a whole-file quick link without sections.`,
          hint: `Run: somewhere docs ${commandArg(key ?? requestedTopic)} --full`,
        }, opts.json === true, requestedTopic);
        return;
      }
      if (!entry) {
        // Manual topics (tsk_926fbf8e). The platform tool gives the signed-in
        // read; the generated public manifest carries each canonical page body
        // for anonymous reads. Never reconstruct a topic from cross-references
        // in another document.
        let authenticatedFailure: string | null = null;
        if (hasUsableCredential()) {
          try {
            const content = await callPlatformHelpTool('docs', {
              topic: requestedTopic,
              ...(view.kind === 'full' ? { detail: 'full' } : {}),
              ...(view.kind === 'section' ? { section: view.id } : {}),
            });
            const status = parseDocsStatusLine(content);
            if (/^Topic "[^\n]*" not found\./.test(content)
                || (view.kind === 'section' && (status.view !== 'section' || /(?:^|\n)No section "/.test(content)))) {
              throw new Error('Authenticated docs did not return the requested view; trying the public index.');
            }
            if (opts.json) printJson({ topic: requestedTopic, ...status, content });
            else process.stdout.write(withNewline(content));
            return;
          } catch (e) {
            authenticatedFailure = e instanceof Error ? e.message : String(e);
          }
        }

        try {
          const pages = await fetchPublicManifest();
          const page = pages.find(({ id }) => id.toLowerCase() === requestedTopic.toLowerCase());
          if (page) {
            const rendered = renderPublicDocsView(page, view);
            if (rendered.failure) {
              reportDocsFailure(rendered.failure, opts.json === true, page.id);
              return;
            }
            if (opts.json) {
              printJson({
                topic: page.id,
                url: DOCS_BASE + PUBLIC_MANIFEST_PATH,
                source: 'public',
                ...(page.summary || page.summary_complete !== undefined || view.kind !== 'default'
                  ? { view: rendered.view, complete: rendered.complete }
                  : {}),
                content: rendered.content,
              });
            } else {
              process.stdout.write(rendered.content);
            }
            return;
          }
          const matches = closestMatches(requestedTopic, pages.map(({ id }) => id));
          const question = /\s|\?/.test(requestedTopic);
          const advisorQuestion = requestedTopic.replace(/[\\"$`]/g, '\\$&');
          reportDocsFailure({
            error: 'DOCS_TOPIC_NOT_FOUND',
            message: `No documentation topic named "${requestedTopic}".`
              + (matches.length ? ` Closest topics: ${matches.join(', ')}.` : ''),
            matches,
            hint: question
              ? `For a construction question, run: somewhere advisor "${advisorQuestion}"`
              : matches.length ? `Run: somewhere docs ${commandArg(matches[0])}` : 'Run: somewhere docs --list',
          }, opts.json === true, requestedTopic);
        } catch (e) {
          const publicFailure = e instanceof Error ? e.message : String(e);
          error(
            authenticatedFailure
              ? `${publicFailure} Authenticated docs also failed: ${authenticatedFailure}`
              : publicFailure,
            e,
          );
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
        error(`Could not reach ${DOCS_BASE} — check your connection. (${e instanceof Error ? e.message : String(e)})`, e);
        process.exit(1);
      }
    });
}
