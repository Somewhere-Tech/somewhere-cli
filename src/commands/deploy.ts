import { Command } from 'commander';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ora from 'ora';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, success, teal } from '../lib/output.js';

const IGNORE = new Set([
  'node_modules',
  '.git',
  '.somewhere.json',
  '.mcp.json',
  '.env',
  '.DS_Store',
  'dist',
  '.next',
  '.vercel',
]);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tar', '.br',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.m4a',
  '.wasm',
]);

export function registerDeploy(program: Command) {
  program
    .command('deploy [dir]')
    .description('Deploy the current directory to the linked project')
    .option('--project <id>', 'Override project ID')
    .action(async (dir: string | undefined, opts) => {
      const token = getToken();
      const client = new ApiClient(token);
      const targetDir = dir ? join(process.cwd(), dir) : process.cwd();

      let projectId = opts.project;
      if (!projectId) {
        const config = loadProjectConfig(targetDir) ?? loadProjectConfig();
        if (!config) {
          error(
            'No project linked. Run `somewhere init` or pass --project <id>',
          );
          process.exit(1);
        }
        projectId = config.project_id;
      }

      const spinner = ora('Collecting files...').start();

      const files: Record<string, string> = {};
      const binaryFiles: Record<string, string> = {};
      const functions: Record<string, string> = {};
      collectFiles(targetDir, targetDir, files, binaryFiles, functions);

      const totalFiles =
        Object.keys(files).length +
        Object.keys(binaryFiles).length +
        Object.keys(functions).length;
      const textBytes = Object.values(files)
        .concat(Object.values(functions))
        .reduce((sum, c) => sum + c.length, 0);
      const binaryBytes = Object.values(binaryFiles)
        .reduce((sum, b64) => sum + Math.floor((b64.length * 3) / 4), 0);
      const totalBytes = textBytes + binaryBytes;

      spinner.text = `Deploying ${totalFiles} files (${formatBytes(totalBytes)})...`;

      try {
        const body: Record<string, unknown> = {
          project_id: projectId,
          files,
        };
        if (Object.keys(binaryFiles).length > 0) {
          body.binary_files = binaryFiles;
        }
        if (Object.keys(functions).length > 0) {
          body.functions = functions;
        }

        const result = await client.call<{
          files: string[] | number;
          url: string;
          has_functions: boolean;
        }>('POST', '/deploy', body);

        spinner.stop();
        const fileCount =
          typeof result.files === 'number'
            ? result.files
            : (result.files ?? []).length;
        success(`${fileCount} files uploaded (${formatBytes(totalBytes)})`);

        if (result.has_functions) {
          success('Functions deployed');
        }
        success(`Live at ${teal(result.url)}`);
      } catch (err) {
        spinner.fail('Deploy failed');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function collectFiles(
  baseDir: string,
  currentDir: string,
  files: Record<string, string>,
  binaryFiles: Record<string, string>,
  functions: Record<string, string>,
) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;

    const fullPath = join(currentDir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      collectFiles(baseDir, fullPath, files, binaryFiles, functions);
      continue;
    }

    if (!entry.isFile()) continue;

    const stat = statSync(fullPath);
    if (stat.size > MAX_FILE_SIZE) continue;

    const isBinary = BINARY_EXTS.has(extname(entry.name).toLowerCase());

    if (relPath.startsWith('functions/')) {
      const key = relPath.slice('functions/'.length);
      functions[key] = readFileSync(fullPath, 'utf-8');
    } else if (isBinary) {
      binaryFiles[relPath] = readFileSync(fullPath).toString('base64');
    } else {
      files[relPath] = readFileSync(fullPath, 'utf-8');
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
