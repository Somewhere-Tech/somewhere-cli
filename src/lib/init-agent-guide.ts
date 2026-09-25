// Generated mirror of somewhere.tech/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — build, deploy, verify

1. Declare application tables in \`db/schema.ts\`. Choose \`owner()\` (own rows),
   \`shared()\` (cross-user rows), or \`serverOnly()\`, and add a \`client\` block for
   browser access. See \`docs({ topic: 'declared-data' })\`.
2. Add a \`tsconfig.json\` for TypeScript source, then run \`somewhere typecheck\`.
   The CLI generates declaration types from \`db/schema.ts\`; it does not need
   hand-written module stubs. See the complete files in \`/start.txt\`.
3. Deploy raw source with \`somewhere deploy\`; do not build first. The CLI links
   the directory to the project it created.
4. Write a \`flow.json\` that submits data and checks the rendered result. From
   the linked directory run \`somewhere verify --flow flow.json\` to exercise it
   at desktop and phone sizes. \`/start.txt\` includes a working flow.

Use \`somewhere dev\` for optional local UI work after the first deploy. For
sign-in, read \`somewhere email test-inbox <addr>\`. For a scheduled function on a
plan with cron, run \`somewhere cron run <id> --wait\` (plain \`cron run\` only
queues it). On a temporary project, use \`somewhere logs --tail 10\` to diagnose
failures. \`somewhere errors\` requires a claimed project and a signed-in account.

### Two habits that keep the app fast and scoped

**Reads issued together travel together:** independent reads go in one
\`Promise.all\` — one round trip, not one each.

**\`owner()\` tables need no auth guard.** Structured calls scope rows to the
request identity. A custom endpoint still enforces its own caller policy.

Ordinary lookups: \`somewhere docs <topic>\` or
\`https://somewhere.tech/start.txt\`; uncertain architecture or composition:
\`somewhere advisor "<question>"\`. Without a shell: MCP \`docs({ topic })\`,
\`advisor({ question })\`; \`catalog\` finds tools.

No account yet? \`npx @somewhere-tech/cli deploy\` publishes a temporary app and
prints its live URL, claim URL, and expiry. On a hosted VM, after consent,
\`somewhere login\` prints a code a human approves in their browser; the machine
stays signed in.`;

export const INIT_AGENTS_MD = `# somewhere.tech project contract\n\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
