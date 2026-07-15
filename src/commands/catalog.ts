import { Command } from 'commander';
import { bold, dim, error, printJson } from '../lib/output.js';
import { callPlatformHelpTool } from './advisor.js';

interface CatalogCategory {
  summary: string;
  aliases: string[];
  tools: string[];
}

interface CatalogResponse {
  categories: Record<string, CatalogCategory>;
  total_tools: number;
  next_step?: string;
}

function parseCatalogResponse(text: string): CatalogResponse {
  const parsed = JSON.parse(text) as Partial<CatalogResponse>;
  if (!parsed.categories || typeof parsed.categories !== 'object' || typeof parsed.total_tools !== 'number') {
    throw new Error('catalog returned an unexpected response.');
  }
  return parsed as CatalogResponse;
}

function printCatalog(catalog: CatalogResponse): void {
  console.log(`Platform tool catalog — ${catalog.total_tools} tools\n`);
  for (const [name, category] of Object.entries(catalog.categories)) {
    console.log(`${bold(name)}  ${category.summary}`);
    console.log(`  ${dim(category.tools.join(', '))}\n`);
  }
  if (catalog.next_step) console.log(dim(catalog.next_step));
}

export function registerCatalog(program: Command): void {
  program
    .command('catalog')
    .description('Browse the live somewhere.tech platform tool catalog')
    .option('--json', 'Print the raw catalog response as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const catalog = parseCatalogResponse(await callPlatformHelpTool('catalog', {}));
        if (opts.json) printJson(catalog);
        else printCatalog(catalog);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
