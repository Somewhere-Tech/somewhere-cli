// Generated mirror of somewhere.tech/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — use the whole workflow

1. Declare every table in \`db/schema.ts\`. Choose \`owner()\` for per-user rows,
   \`shared()\` for intentional cross-user rows, or \`serverOnly()\` for trusted
   server access.
2. Run the app locally with \`somewhere dev\`.
3. Check TypeScript with \`somewhere typecheck\`.
4. Deploy raw source with \`somewhere deploy\`; do not build first.
5. Verify the live flow with
   \`somewhere verify --url <live> --flow flow.json\`. One call runs the named
   steps, checks page/console/network health, and captures screenshots.
6. For sign-in checks, read the project test inbox with
   \`somewhere email test-inbox <addr>\`.
7. Exercise a scheduled job now with \`somewhere cron run <id>\`.
8. Diagnose with \`somewhere errors\`, which separates deliberate refusals from
   exceptions; use \`somewhere logs\` for the full detail.

### Two habits that keep the app fast and scoped

**Reads issued together travel together.** Start independent reads in one
\`Promise.all\`:

\`\`\`ts
const [account, projects] = await Promise.all([
  sw.db.from('accounts', { where: { id: accountId }, limit: 1 }),
  sw.db.from('projects', { order: ['created_at', 'desc'], limit: 20 }),
]);
\`\`\`

**\`owner()\` tables need no auth guard.** Structured queries already resolve the
request identity and scope rows; do not query auth first just to protect them:

\`\`\`ts
export default async function (_req, sw) {
  const posts = await sw.db.from('posts', {
    order: ['created_at', 'desc'],
  });
  return Response.json({ posts: posts.data });
}
\`\`\`

Ask \`somewhere advisor "<question>"\` first for guidance. Then use
\`somewhere docs <topic>\` for contracts or \`https://somewhere.tech/start.txt\`
for quickstart. Without a shell: MCP \`advisor({ question })\`, then
\`docs({ topic })\`; \`catalog\` finds tools.

No account yet? \`npx @somewhere-tech/cli deploy\` publishes a temporary app and
prints its live URL, claim URL, and expiry. On a hosted VM, after consent,
\`somewhere login\` prints a code for a human to approve in their browser and the
machine stays signed in.`;

export const INIT_AGENTS_MD = `# somewhere.tech project contract\n\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
