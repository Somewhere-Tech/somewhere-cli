// Generated mirror of somewhere.tech/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — build, deploy, verify

Signed in: \`somewhere init --name <slug>\` in an empty folder writes a React +
TypeScript starter that already signs users up, in and out. Extend it (restyle
freely) rather than rebuilding sign-in. No account yet?
\`npx @somewhere-tech/cli deploy\` publishes a temporary app and prints its live
URL, claim URL, and expiry; \`init\`, the email test inbox, cron and advisor need
a signed-in account. On a hosted VM, after consent, \`somewhere login\` prints a
code a human approves in their browser; the machine stays signed in.
\`somewhere docs <topic>\` (\`--section <id>\`) prints one contract;
\`somewhere advisor "<question>"\` answers design questions (MCP:
\`docs({ topic })\`, \`advisor({ question })\`, \`catalog\`).

After every change:
1. \`somewhere typecheck\` (types for \`sw\` and your tables), then
   \`somewhere deploy\` — raw source; do not build first. It prints the live
   URL. A page that renders blank is refused; the previous version stays live.
2. \`somewhere verify\` — desktop and phone screenshots, console and network
   health; \`somewhere verify --flow flow.json\` fills and clicks.
3. \`somewhere browser\` inspects a page; \`somewhere logs --tail 10\`, then
   \`somewhere errors\` (claimed project, signed in): read the failure first.
4. Email: sign up as \`<name>@<subdomain>.test.somewhere.site\`, then
   \`somewhere email test-inbox <addr>\` prints the message and its magic link.

Routes: \`index.html\` loads \`src/main.tsx\`; every extensionless path with no file
(\`/signin\`) serves \`index.html\`, so one app routes by \`location.pathname\`. An
unknown \`*.html\` or \`/api/*\` is a 404. \`api/notes/[id].ts\` is \`/api/notes/:id\`;
\`_\`-prefixed names are import-only helpers. Never create paths differing only
in case (\`SignIn.tsx\`, \`signin.tsx\`): a case-insensitive disk keeps only one.

Sign-in: \`api/auth/[...path].ts\` is
\`export { somewhereAuth as default } from '@somewhere-tech/sdk/server'\`; pages
use \`createSomewhereAuth()\` from \`@somewhere-tech/sdk/auth\` (no SDK:
\`docs({ topic: 'auth-client' })\`). \`auth.signUp({ email,
password, displayName? })\` / \`auth.signIn({ email, password })\` return the user
or throw with the message. \`auth.getUser()\` returns the user or \`null\` from
\`GET /api/auth/me\` (200 \`{ user }\` or \`{ user: null }\`): gate pages on it with a
visible loading state, as the starter's \`src/App.tsx\` does. Sign-up signs the
user in with \`email_verified: false\`; unverified users can sign in and pass
\`auth: 'required'\`. \`sw.auth.requireUser(req)\` returns \`{ id, email,
display_name, role, email_verified, banned, metadata, plan, plan_status, type,
created_at, … }\` or throws 401 \`AUTH_REQUIRED\`; \`sw.auth.fromRequest(req)\`
returns it or \`null\`.

Functions: a bare \`export default async function (req, sw)\` returning a
\`Response\` is always valid. \`sw.endpoint({ auth: 'none' | 'optional' |
'required', body: { title: 'string', n: 'number?' }, rateLimit: '30/minute',
handler: async ({ body, user, params }, sw) => value })\` is an optional wrapper
that answers 401/400 itself and sends \`value\` as JSON. Route params:
\`params.id\` in the wrapper, \`sw.params.id\` (also \`req.params.id\`) bare.

Data: tables in \`db/schema.ts\` — \`owner()\` (each user's own rows; no auth
guard), \`shared()\` or \`serverOnly()\` — with a \`client\` block for browser
access via \`somewhere:data\`; a custom endpoint enforces its own caller policy.
\`sw.db.from\` / \`insert\` / \`update\` / \`remove\` return \`{ data: rows[], count,
changes }\`; \`sw.db.aggregate\` counts and groups. Raw \`sw.db.query(sql, params)\`
runs as written (add \`WHERE user_id = ?\`; managed projects refuse it). Put
independent reads in one \`Promise.all\`.`;

export const INIT_AGENTS_MD = `# somewhere.tech project contract\n\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
