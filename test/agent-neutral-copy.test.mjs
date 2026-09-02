/**
 * The CLI's own instructions to the developer name the PLATFORM, not a vendor.
 *
 * `somewhere init` used to close with "Run claude to keep building", which
 * reads as a partnership requirement on a platform any coding agent drives —
 * and does not say what to run here (pfb_aaff8e9d14fb).
 *
 * The rule is about the CLI TELLING someone to run a vendor's tool. Naming a
 * vendor's config file is a different thing entirely: `somewhere mcp install`
 * genuinely writes `~/.claude.json`, and saying so is the truth.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const srcDir = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// "Run <vendor>", "run `claude`", "then run codex" — an instruction to launch
// somebody else's tool as the next step.
const VENDOR_NEXT_STEP = /\brun\s+`?(?:claude|codex|cursor|copilot|windsurf|aider|gemini)\b/i;

test('no command tells the developer to run a specific vendor tool', () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    const body = readFileSync(file, 'utf8');
    for (const line of body.split('\n')) {
      // `somewhere mcp install claude-code` is a subcommand of OURS, not an
      // instruction to run somebody else's binary.
      if (/mcp install/.test(line)) continue;
      if (VENDOR_NEXT_STEP.test(line)) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `vendor-specific next step:\n${offenders.join('\n')}`);
});

test('init closes by naming the platform commands and any agent', () => {
  const init = readFileSync(join(srcDir, 'commands', 'init.ts'), 'utf8');
  const closings = init
    .split('\n')
    .filter((l) => /Any coding agent can drive this CLI/.test(l));
  // Both closings — project created with existing source preserved, and
  // project linked — say it.
  assert.equal(closings.length, 2, init);
  for (const line of closings) {
    assert.match(line, /somewhere dev/);
    assert.match(line, /somewhere deploy/);
  }
});
