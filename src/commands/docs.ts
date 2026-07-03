import { Command } from 'commander';
import { dim, error } from '../lib/output.js';

// Platform docs from the CLI — works with ZERO credentials (tsk_497b7eeb /
// tsk_2ae9dce9 funnel work). The docs are public text URLs on the apex, so an
// anonymous agent that just discovered `--temporary` can learn everything it
// can run without logging in: `somewhere docs start`. Deliberately a plain
// fetch-and-print (no auth, no spinner, raw text to stdout) — the consumer is
// usually a coding agent piping this into context.
const DOCS_BASE = 'https://somewhere.tech';

const TOPICS: Record<string, { path: string; blurb: string }> = {
  start: {
    path: '/start.txt',
    blurb: 'Anonymous quickstart — deploy with no account (--temporary), app shape, what works, how to keep it',
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

export function registerDocs(program: Command) {
  program
    .command('docs [topic]')
    .description(
      'Print platform docs as plain text — no login needed. Topics: ' +
        Object.keys(TOPICS).join(', ') +
        '. New here with no account? `somewhere docs start`.',
    )
    .action(async (topic: string | undefined) => {
      if (!topic) {
        console.log('Platform docs — no login needed. Usage: somewhere docs <topic>\n');
        for (const [name, t] of Object.entries(TOPICS)) {
          console.log(`  ${name.padEnd(10)} ${t.blurb}`);
        }
        console.log(`\n${dim('No account yet? Start with: somewhere docs start')}`);
        return;
      }
      const key = TOPICS[topic] ? topic : ALIASES[topic.toLowerCase()];
      const entry = key ? TOPICS[key] : undefined;
      if (!entry) {
        error(`Unknown topic "${topic}". Topics: ${Object.keys(TOPICS).join(', ')}`);
        process.exit(1);
      }
      try {
        const res = await fetch(DOCS_BASE + entry.path);
        if (!res.ok) {
          error(`Could not fetch ${DOCS_BASE}${entry.path} (HTTP ${res.status}). Try again shortly, or open it in a browser.`);
          process.exit(1);
        }
        process.stdout.write(await res.text());
      } catch (e) {
        error(`Could not reach ${DOCS_BASE} — check your connection. (${e instanceof Error ? e.message : String(e)})`);
        process.exit(1);
      }
    });
}
