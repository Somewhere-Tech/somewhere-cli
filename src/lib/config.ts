import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliConfig, ProjectConfig, ProjectDeployState } from '../types.js';
import { error } from './output.js';

const CONFIG_DIR = join(homedir(), '.somewhere');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const CLAUDE_CONFIG_PATH = join(homedir(), '.claude.json');
const PROJECT_FILE = '.somewhere.json';

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // mkdir/write modes are creation-only. Tighten an existing directory before
  // placing credentials inside it so another local user cannot traverse it.
  chmodSync(CONFIG_DIR, 0o700);
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
  const tempPath = join(CONFIG_DIR, `.config-${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    // Replacing the inode avoids exposing new credentials through an already-
    // open descriptor to a loose old file and never follows config.json links.
    fd = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(fd, JSON.stringify(config, null, 2) + '\n');
    fchmodSync(fd, 0o600);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, CONFIG_PATH);
    chmodSync(CONFIG_PATH, 0o600);
    chmodSync(CONFIG_DIR, 0o700);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function clearConfig(): void {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

/** Swap in a freshly-refreshed access key + rotated refresh token, preserving
 *  the rest of the stored config (user, etc.). Used by the API client's
 *  refresh-on-401 path (tsk_3642f3c4). No-op if there's no config to update. */
export function updateTokens(token: string, refreshToken: string): void {
  const config = loadConfig();
  if (!config) return;
  saveConfig({ ...config, token, refresh_token: refreshToken });
}

export function getToken(): string {
  const config = loadConfig();
  // A temporary (--temporary, tsk_35674c33) credential carries its own
  // expiry independent of the normal login flow. Check it BEFORE the
  // generic "no token" case below so an expired temp session gets
  // temp-aware copy (re-mint vs. real login) instead of the bare
  // "Not logged in" message, which would send a dev to `somewhere login`
  // when they never signed up in the first place.
  if (config?.temporary && config.temp_expires_at && new Date(config.temp_expires_at).getTime() <= Date.now()) {
    error(
      'Temporary session expired. Run somewhere deploy --temporary for a new one, or somewhere login to keep your work.',
    );
    process.exit(1);
  }
  if (!config?.token) {
    error('Not logged in. Run: somewhere login');
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

export interface ProjectConfigEntry {
  dir: string;
  config: ProjectConfig;
}

export function loadProjectConfigEntry(dir = process.cwd()): ProjectConfigEntry | null {
  const config = loadProjectConfig(dir);
  return config ? { dir, config } : null;
}

export function readProjectDeployState(
  config: ProjectConfig | null,
  projectId: string,
): ProjectDeployState | null {
  const state = config?.last_deploy;
  if (!state) return null;
  if (state.project_id !== projectId) return null;
  if (!Number.isInteger(state.last_deployed_version) || state.last_deployed_version < 1) return null;
  if (typeof state.at !== 'string' || state.at.length === 0) return null;
  return state;
}

export function projectConfigMatchesRef(config: ProjectConfig, ref: string): boolean {
  return ref === config.project_id;
}

export function saveProjectDeployState(
  dir: string,
  projectId: string,
  version: number,
  at = new Date().toISOString(),
): ProjectConfig | null {
  if (!Number.isInteger(version) || version < 1) return null;
  const config = loadProjectConfig(dir);
  if (!config || config.project_id !== projectId) return null;
  const next: ProjectConfig = {
    ...config,
    last_deploy: {
      project_id: projectId,
      last_deployed_version: version,
      at,
    },
  };
  saveProjectConfig(dir, next);
  return next;
}

/** The self-healing MCP entry every host gets: the stdio bridge reads
 *  ~/.somewhere/config.json at every launch, so a re-login (which rotates the
 *  CLI key) never leaves a stale baked token behind. The OLD shape baked a
 *  `Bearer smt_...` into the config file at install time and never re-read it,
 *  so the next `somewhere login` silently 401'd MCP until the user hand-edited
 *  the file. Never reintroduce the http+headers shape (tsk_104fe2d0). */
const SOMEWHERE_STDIO_ENTRY = { command: 'somewhere', args: ['mcp'] } as const;

/** Project-local `.mcp.json` (read by Claude Code in the project dir). Uses the
 *  stdio bridge, not a baked token — see SOMEWHERE_STDIO_ENTRY. */
export function saveMcpConfig(dir: string): void {
  const path = join(dir, '.mcp.json');
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed — preserve nothing, write fresh
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.somewhere = { ...SOMEWHERE_STDIO_ENTRY };
  config.mcpServers = servers;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

/** Global Claude Code config (~/.claude.json). Uses the stdio bridge, not a
 *  baked token — see SOMEWHERE_STDIO_ENTRY. */
export function saveGlobalMcpConfig(): void {
  let config: Record<string, unknown> = {};
  if (existsSync(CLAUDE_CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed — preserve nothing, write fresh
    }
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.somewhere = { ...SOMEWHERE_STDIO_ENTRY };
  config.mcpServers = servers;

  writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function hasGlobalMcpConfig(): boolean {
  if (!existsSync(CLAUDE_CONFIG_PATH)) return false;
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return !!servers?.somewhere;
  } catch {
    return false;
  }
}

const CURSOR_DIR = join(homedir(), '.cursor');
export const CURSOR_MCP_PATH = join(CURSOR_DIR, 'mcp.json');

/** Cursor gets the stdio bridge (`somewhere mcp`) rather than an embedded
 *  bearer token: the bridge reads ~/.somewhere/config.json at runtime, so a
 *  re-login never leaves a stale token behind in Cursor's config. */
export function saveCursorMcpConfig(): void {
  let config: Record<string, unknown> = {};
  if (existsSync(CURSOR_MCP_PATH)) {
    try {
      config = JSON.parse(readFileSync(CURSOR_MCP_PATH, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed — preserve nothing, write fresh
    }
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.somewhere = { command: 'somewhere', args: ['mcp'] };
  config.mcpServers = servers;

  if (!existsSync(CURSOR_DIR)) mkdirSync(CURSOR_DIR, { recursive: true });
  writeFileSync(CURSOR_MCP_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function hasCursorMcpConfig(): boolean {
  if (!existsSync(CURSOR_MCP_PATH)) return false;
  try {
    const config = JSON.parse(readFileSync(CURSOR_MCP_PATH, 'utf-8')) as Record<string, unknown>;
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return !!servers?.somewhere;
  } catch {
    return false;
  }
}
