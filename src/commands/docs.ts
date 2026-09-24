import { fetchWithProxy as fetch } from '../lib/http.js';
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
  notice?: string;
}

function parseSections(value: unknown, bodyLength: number): PublicDocsSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value.filter((entry): entry is PublicDocsSection => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.id === 'string' && typeof candidate.heading === 'string'
      && Number.isInteger(candidate.start) && Number.isInteger(candidate.end)
      && (candidate.start as number) >= 0 && (candidate.start as number) < (candidate.end as number)
      && (candidate.end as number) <= bodyLength;
  });
  return sections.map(({ id, heading, start, end }) => ({ id, heading, start, end }));
}

/** Public-manifest rendering of the docs views. Older manifests carry only
 *  `body`, so every view falls back to the complete page rather than to less. */
export function renderPublicDocsView(page: PublicDocsPage, view: DocsView): RenderedDocs {
  const full = renderPublicPage(page);
  if (view.kind === 'full') return { content: full, view: 'full', complete: true };
  if (view.kind === 'default') {
    return page.summary
      ? { content: withNewline(page.summary), view: 'summary', complete: page.summary_complete === true }
      : { content: full, view: 'full', complete: true };
  }
  if (!page.sections) {
    return {
      content: full,
      view: 'full',
      complete: true,
      notice: `This docs version has no section index; printed all of "${page.id}".`,
    };
  }
  const wanted = view.id.trim().toLowerCase();
  const match = page.sections.find((section) =>
    section.id.toLowerCase() === wanted || headingText(section).toLowerCase() === wanted);
  if (!match) {
    const index = page.sections.map((section) => `  ${section.id} · ${headingText(section)}`).join('\n');
    return {
      content: `No section "${view.id}" in ${page.id}. Sections:\n${index}\n`,
      view: 'section',
      complete: false,
    };
  }
  return { content: withNewline(page.body.slice(match.start, match.end)), view: 'section', complete: false };
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

async function fetchPublicManifest(): Promise<PublicDocsPage[]> {
  const res = await fetch(DOCS_BASE + PUBLIC_MANIFEST_PATH, {
    headers: { 'User-Agent': 'somewhere-cli' },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch ${DOCS_BASE}${PUBLIC_MANIFEST_PATH} (HTTP ${res.status}).`);
  }
  try {
    return parsePublicDocsManifest(await res.json());
  } catch (cause) {
    throw new Error(`Could not read ${DOCS_BASE}${PUBLIC_MANIFEST_PATH}: ${cause instanceof Error ? cause.message : String(cause)}`);
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
    .command('docs [topic]')
    .description(
      'Read platform docs. No login needed — every topic is public. Quick topics: ' +
        Object.keys(TOPICS).join(', ') +
        '. Example manual topic: `somewhere docs sw.db`.',
    )
    .option('--list', 'List available topics instead of streaming documentation')
    .option('--full', 'Print the complete topic instead of its summary')
    .option('--section <id>', 'Print one section of a topic (ids are listed in the summary)')
    .option('--json', 'Print the selected document in a JSON envelope')
    .action(async (
      topic: string | undefined,
      opts: { list?: boolean; full?: boolean; section?: string; json?: boolean },
    ) => {
      if (opts.full && opts.section !== undefined) {
        error('Pass --full or --section <id>, not both.');
        process.exitCode = 1;
        return;
      }
      const view: DocsView = opts.section !== undefined
        ? { kind: 'section', id: opts.section }
        : opts.full ? { kind: 'full' } : { kind: 'default' };
      if (opts.list) {
        try {
          const pages = await fetchPublicManifest();
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
          console.log('Platform docs — no login needed. Usage: somewhere docs <topic>\n');
          console.log('Public topics:');
          const width = Math.max(...pages.map(({ id }) => id.length));
          for (const { id, title } of pages) {
            console.log(`  ${id.padEnd(width)}  ${title}`);
          }
          console.log('\nQuick links:');
          for (const { name, description } of quickLinks) {
            console.log(`  ${name.padEnd(10)} ${description}`);
          }
          console.log(`\n${dim('No account yet? Start with: somewhere docs start')}`);
        } catch (e) {
          error(e instanceof Error ? e.message : String(e));
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
        error(`"${requestedTopic}" is a whole-file quick link without sections. Run: somewhere docs --list`);
        process.exitCode = 1;
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
            if (opts.json) printJson({ topic: requestedTopic, ...parseDocsStatusLine(content), content });
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
            if (rendered.notice) console.error(dim(rendered.notice));
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
          const known = pages.map(({ id }) => id);
          error(
            `No documentation topic named "${requestedTopic}".`
            + (known.length ? ` Topics: ${known.join(', ')}.` : '')
            + ' Or run: somewhere docs --list',
          );
          process.exitCode = 1;
        } catch (e) {
          const publicFailure = e instanceof Error ? e.message : String(e);
          error(
            authenticatedFailure
              ? `${publicFailure} Authenticated docs also failed: ${authenticatedFailure}`
              : publicFailure,
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
        error(`Could not reach ${DOCS_BASE} — check your connection. (${e instanceof Error ? e.message : String(e)})`);
        process.exit(1);
      }
    });
}
