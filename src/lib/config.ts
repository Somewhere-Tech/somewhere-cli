import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliConfig, ProjectConfig } from '../types.js';

const CONFIG_DIR = join(homedir(), '.somewhere');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const PROJECT_FILE = '.somewhere.json';

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): CliConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as CliConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: CliConfig): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function clearConfig(): void {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

export function getToken(): string {
  const config = loadConfig();
  if (!config?.token) {
    console.error('Not logged in. Run: somewhere login');
    process.exit(1);
  }
  return config.token;
}

export function loadProjectConfig(dir = process.cwd()): ProjectConfig | null {
  const path = join(dir, PROJECT_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ProjectConfig;
  } catch {
    return null;
  }
}

export function saveProjectConfig(dir: string, config: ProjectConfig): void {
  writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(config, null, 2) + '\n');
}

export function saveMcpConfig(dir: string, token: string): void {
  const mcp = {
    mcpServers: {
      somewhere: {
        url: 'https://mcp.somewhere.tech/mcp',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
}
