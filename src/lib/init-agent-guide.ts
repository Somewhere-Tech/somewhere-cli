import { BUNDLED_SKILLS_PACK } from './skills-pack.generated.js';
import { SKILLS_DIR, skillNames } from './skills-pack.js';

// Generated mirror of somewhere.tech/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — build, deploy, verify

Signed in: \`somewhere init --name <slug>\` in an empty folder writes a React +
TypeScript starter that already signs users up, in and out; extend it
rather than rebuilding sign-in (its README maps pages, routes, views and
styles; \`init --catalog --json\` lists modules for \`--features\`). No account yet?
\`npx @somewhere-tech/cli deploy\` publishes a temporary app and prints its live
URL, claim URL, and expiry; \`init\`, the email test inbox, cron and advisor need
a signed-in account. On a hosted VM, after consent, \`somewhere login\` prints a
code a human approves in their browser; the machine stays signed in.
\`somewhere docs <topic>\` (\`--section <id>\`) prints one contract;
\`somewhere advisor "<question>"\` answers design choices (MCP:
\`docs({ topic })\`, \`advisor({ question })\`, \`catalog\`).

After every change:
1. \`somewhere typecheck\`, then \`somewhere deploy\` (do not build first). Deploy
   runs the platform compile, schema and secret checks and refuses a blank page
   before going live; \`somewhere deploy-check\` runs them without publishing
   (diagnosis, review, \`--run /api/x\`).
2. \`somewhere verify\` — desktop and phone screenshots, console and network
   health; \`somewhere verify --flow flow.json\` fills and clicks. Several users:
   \`actors\` + \`journey\` (\`somewhere docs browser\`).
3. \`somewhere browser\` inspects a page; \`somewhere logs --tail 10\`, then
   \`somewhere errors\`: read the failure first.
4. Email: sign up as \`<name>@<subdomain>.test.somewhere.site\`, then
   \`somewhere email test-inbox <addr>\` prints the message and its magic link.

Routes: \`index.html\` loads \`src/main.tsx\`; every extensionless path with no file
(\`/signin\`) serves \`index.html\`, so one app routes by \`location.pathname\`.
\`api/notes/[id].ts\` is \`/api/notes/:id\`; \`_\`-prefixed names are import-only
helpers. Avoid names differing only in letter case (\`SignIn.tsx\`, \`signin.tsx\`).

Sign-in: \`api/auth/[...path].ts\` is
\`export { somewhereAuth as default } from '@somewhere-tech/sdk/server'\`; pages
use \`createSomewhereAuth()\` from \`@somewhere-tech/sdk/auth\` (no SDK:
\`docs({ topic: 'auth-client' })\`). \`auth.signUp({ email, password,
displayName? })\` / \`auth.signIn({ email, password })\` return the user or throw
with the message. Gate pages on \`auth.getState().status\` (React:
\`useAuthState()\`) as the starter's \`src/App.tsx\` does. Sign-up signs the user
in with \`email_verified: false\`; unverified users can sign in and pass
\`auth: 'required'\`. \`sw.auth.requireUser(req)\` returns \`{ id, email,
role, email_verified, … }\` or throws 401 \`AUTH_REQUIRED\`;
\`sw.auth.fromRequest(req)\` returns it or \`null\`.

Functions: a bare \`export default async function (req, sw)\` returning a
\`Response\` is always valid. The optional wrapper \`sw.endpoint({ auth: 'none' |
'optional' | 'required', body, rateLimit, handler: async ({ body, user, params
}, sw) => value })\` answers 401/400 itself and sends \`value\` as JSON. Params:
\`params.id\` there, \`sw.params.id\` bare. \`somewhere typecheck\` types bare
handlers as \`(req: Request, sw: SomewhereRuntimeContext)\`.

Data: tables in \`db/schema.ts\` — \`owner()\` (each user's own rows; no auth
guard), \`shared()\` or \`serverOnly()\` — with a \`client\` block for browser
access via \`somewhere:data\`; a custom endpoint enforces its own caller policy.
\`sw.db.from\` / \`insert\` / \`update\` / \`remove\` return \`{ data: rows[], count,
changes }\`; \`where: { a: 1, b: { in: ids }, c: { gte: 2 }, d: null }\` (one
operator per column). Raw \`sw.db.query(sql, params)\` runs as written (add \`WHERE
user_id = ?\`; managed projects refuse it). Independent reads: one \`Promise.all\`.`;

export const SKILLS_POINTER = `Skills: \`${SKILLS_DIR}/\` — `
  + skillNames(BUNDLED_SKILLS_PACK).map((name) => `\`${name}\``).join(', ')
  + '. Read the skill that matches the task. `somewhere skills status` inspects the installed pack; `somewhere skills update` updates unmodified files.';

export const INIT_AGENTS_MD = `# somewhere.tech project contract\n${SKILLS_POINTER}\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
