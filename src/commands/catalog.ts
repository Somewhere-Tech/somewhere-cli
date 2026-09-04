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

interface CatalogToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

interface LoadedCatalogResponse {
  tools: CatalogToolDefinition[];
}

interface CatalogSearchMatch {
  kind?: string;
  tool?: string;
  name?: string;
  group?: string;
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

function parseLoadedCatalogResponse(text: string): LoadedCatalogResponse {
  const parsed = JSON.parse(text) as Partial<LoadedCatalogResponse>;
  if (!Array.isArray(parsed.tools)) {
    throw new Error('CATALOG_SCHEMA_NOT_AVAILABLE: Catalog input schemas are not available on this platform version yet.');
  }
  const tools = parsed.tools.map((tool, index) => {
    if (!tool
        || typeof tool !== 'object'
        || typeof tool.name !== 'string'
        || typeof tool.description !== 'string'
        || !tool.inputSchema
        || typeof tool.inputSchema !== 'object'
        || Array.isArray(tool.inputSchema)) {
      throw new Error(`CATALOG_SCHEMA_NOT_AVAILABLE: Catalog tool ${index} does not include a usable input schema on this platform version yet.`);
    }
    return tool as CatalogToolDefinition;
  });
  return { ...parsed, tools } as LoadedCatalogResponse;
}

function parseSearchMatches(text: string): CatalogSearchMatch[] {
  const parsed = JSON.parse(text) as { matches?: unknown };
  if (!Array.isArray(parsed.matches)) throw new Error('catalog search returned an unexpected response.');
  return parsed.matches.filter((match): match is CatalogSearchMatch => !!match && typeof match === 'object');
}

async function loadCatalogTool(query: string): Promise<CatalogToolDefinition> {
  const name = query.trim().toLowerCase();
  const matches = parseSearchMatches(await callPlatformHelpTool('catalog', { search: name }));
  const exact = matches.find((match) => match.kind !== 'runtime_capability' && match.tool === name);
  if (!exact || typeof exact.group !== 'string') {
    const suggestions = matches
      .map((match) => typeof match.tool === 'string' ? match.tool : match.name)
      .filter((name): name is string => typeof name === 'string')
      .slice(0, 5);
    throw new Error(`UNKNOWN_TOOL: Tool "${query}" was not found.${suggestions.length ? ` Matches: ${suggestions.join(', ')}.` : ''}`);
  }
  const loaded = parseLoadedCatalogResponse(await callPlatformHelpTool('catalog', { load: exact.group }));
  const tool = loaded.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`CATALOG_SCHEMA_NOT_AVAILABLE: The input schema for "${query}" is not available on this platform version yet.`);
  return tool;
}

function printCatalogTool(tool: CatalogToolDefinition): void {
  console.log(bold(tool.name));
  console.log(tool.description);
  console.log('\nInput schema:');
  console.log(JSON.stringify(tool.inputSchema, null, 2));
}

export function registerCatalog(program: Command): void {
  program
    .command('catalog [tool]')
    .description('Browse the live somewhere.tech platform tool catalog')
    .option('--json', 'Print the catalog and complete input schemas as JSON')
    .action(async (tool: string | undefined, opts: { json?: boolean }) => {
      try {
        if (tool) {
          const definition = await loadCatalogTool(tool);
          if (opts.json) printJson(definition);
          else printCatalogTool(definition);
          return;
        }
        if (opts.json) {
          const [catalogText, loadedText] = await Promise.all([
            callPlatformHelpTool('catalog', {}),
            callPlatformHelpTool('catalog', { load: 'all' }),
          ]);
          const catalog = parseCatalogResponse(catalogText);
          const loaded = parseLoadedCatalogResponse(loadedText);
          printJson({ ...catalog, definitions: loaded.tools });
          return;
        }
        printCatalog(parseCatalogResponse(await callPlatformHelpTool('catalog', {})));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
