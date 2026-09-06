// Generated mirror of somewhere.tech/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — use the whole workflow

1. Declare every table in \`db/schema.ts\`. Choose \`owner()\` for per-user rows,
   \`shared()\` for intentional cross-user rows, or \`serverOnly()\` for trusted
   server access.
2. Check TypeScript with \`somewhere typecheck\`.
3. Deploy raw source with \`somewhere deploy\`; do not build first. That deploy
   is your backend.
4. Optional: \`somewhere dev\` for frontend hot reload against it.
5. Verify the live flow with
   \`somewhere verify --url <live> --flow flow.json\`. One call runs the named
   steps, checks page/console/network health, and captures screenshots.
6. For sign-in checks, read the test inbox: \`somewhere email test-inbox <addr>\`.
7. Exercise a scheduled job now with \`somewhere cron run <id>\`.
8. Diagnose with \`somewhere errors\` (refusals vs exceptions); \`somewhere logs\`
   has the full detail.

### Two habits that keep the app fast and scoped

**Reads issued together travel together:** independent reads go in one
\`Promise.all\` — one round trip, not one each.

**\`owner()\` tables need no auth guard.** Structured queries already resolve the
request identity and scope rows; do not query auth first just to protect them.
Scope: project isolation and row ownership on the structured API. Raw SQL and
your own endpoints enforce their own caller policy; the platform cannot tell if
a custom admin endpoint checks its caller:

\`\`\`ts
export default async function (_req, sw) {
  const posts = await sw.db.from('posts', {
    order: ['created_at', 'desc'],
  });
  return Response.json({ posts: posts.data });
}
\`\`\`

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
