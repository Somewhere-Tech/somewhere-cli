// Generated mirror of somewhere.tech/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — build, deploy, verify

The loop, after every change:

1. \`somewhere deploy\` — raw source; do not build first. It prints the live URL.
2. \`somewhere verify\` — the live app at desktop and phone sizes, with
   screenshots and console/network health. \`somewhere verify --flow flow.json\`
   fills and clicks (\`/start.txt\` has a flow); \`somewhere browser\` inspects a page.
3. \`somewhere logs --tail 10\`, then \`somewhere errors\` (claimed project,
   signed in): read the failure before guessing.
4. Email flows: sign up as \`<name>@<subdomain>.test.somewhere.site\`, then
   \`somewhere email test-inbox <addr>\` prints the message and its magic link.

Default build path, in order:
1. Sign-in (\`somewhere init\` writes it): \`api/auth/[...path].ts\` is
   \`export { somewhereAuth as default } from '@somewhere-tech/sdk/server'\`;
   the page calls \`createSomewhereAuth()\` from \`@somewhere-tech/sdk/auth\`.
2. Data: tables in \`db/schema.ts\` — \`owner()\` (own rows), \`shared()\` or
   \`serverOnly()\` — with a \`client\` block; the page reads and writes them
   through \`somewhere:data\` (\`docs({ topic: 'declared-data' })\`).
3. Counts and groups: \`data.<table>.aggregate\` (\`sw.db.aggregate\` server-side).
4. A function only when a business rule needs the server:
   \`sw.endpoint({ auth, body, rateLimit, handler })\`.

\`somewhere typecheck\` generates the types for \`sw\` and your tables. Independent
reads go in one \`Promise.all\`. \`owner()\` tables need no auth guard; a custom
endpoint enforces its own caller policy. \`somewhere docs <topic>\` for a
contract; \`somewhere advisor "<question>"\` for uncertain architecture (MCP:
\`docs({ topic })\`, \`advisor({ question })\`, \`catalog\`). \`somewhere dev\` is
optional local UI work; \`somewhere cron run <id> --wait\` runs a scheduled job
(plain \`cron run\` only queues it).

No account yet? \`npx @somewhere-tech/cli deploy\` publishes a temporary app and
prints its live URL, claim URL, and expiry. On a hosted VM, after consent,
\`somewhere login\` prints a code a human approves in their browser; the machine
stays signed in.`;

export const INIT_AGENTS_MD = `# somewhere.tech project contract\n\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
