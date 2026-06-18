import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts derives ~/.claude.json and ~/.somewhere from homedir() at module
// load, so point HOME at a throwaway dir BEFORE importing it.
const HOME = mkdtempSync(join(tmpdir(), 'sw-mcp-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME; // windows homedir()

const { saveGlobalMcpConfig, saveMcpConfig, hasGlobalMcpConfig } = await import('../dist/lib/config.js');

const CLAUDE_PATH = join(HOME, '.claude.json');

// Regression: installClaudeCode / login used to bake a frozen Bearer token
// into ~/.claude.json; it never self-healed after a key rotation
// (tsk_104fe2d0). The fix writes the stdio bridge, which re-reads the live
// config at every launch.
test('saveGlobalMcpConfig writes the stdio bridge, never a baked token', () => {
  saveGlobalMcpConfig();
  const cfg = JSON.parse(readFileSync(CLAUDE_PATH, 'utf-8'));
  assert.deepEqual(cfg.mcpServers.somewhere, { command: 'somewhere', args: ['mcp'] });
  // The footgun shape must be gone entirely.
  assert.equal(cfg.mcpServers.somewhere.type, undefined);
  assert.equal(cfg.mcpServers.somewhere.url, undefined);
  assert.equal(cfg.mcpServers.somewhere.headers, undefined);
});

test('saveGlobalMcpConfig preserves other keys + other mcpServers entries', () => {
  writeFileSync(
    CLAUDE_PATH,
    JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }, null, 2),
  );
  saveGlobalMcpConfig();
  const cfg = JSON.parse(readFileSync(CLAUDE_PATH, 'utf-8'));
  assert.equal(cfg.numStartups, 3);
  assert.deepEqual(cfg.mcpServers.other, { command: 'x' });
  assert.deepEqual(cfg.mcpServers.somewhere, { command: 'somewhere', args: ['mcp'] });
  assert.ok(hasGlobalMcpConfig());
});

test('saveMcpConfig (project .mcp.json) writes the stdio bridge, never a baked token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-mcp-proj-'));
  saveMcpConfig(dir);
  const path = join(dir, '.mcp.json');
  assert.ok(existsSync(path));
  const cfg = JSON.parse(readFileSync(path, 'utf-8'));
  assert.deepEqual(cfg.mcpServers.somewhere, { command: 'somewhere', args: ['mcp'] });
  assert.equal(cfg.mcpServers.somewhere.headers, undefined);
});
