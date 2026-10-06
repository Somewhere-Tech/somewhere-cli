import { BUNDLED_SKILLS_PACK } from './skills-pack.generated.js';
import { SKILLS_DIR, skillNames } from './skills-pack.js';

// Generated mirror of somewhere.tech/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — build, deploy, verify

\`somewhere init --name <slug>\` in an empty folder writes a local React +
TypeScript starter without login. The default includes working sign-in;
extend it using the README file map. Minimal/bare starters omit auth.
\`init --catalog --json\` lists modules for \`--features\`. No account yet?
\`npx @somewhere-tech/cli deploy\` publishes a temporary app and prints its live
URL, claim URL, and expiry. Login is needed for account-owned operations,
the email test inbox and cron. On a hosted VM, after consent, \`somewhere login\` prints a
code a human approves in their browser; the machine stays signed in.
For a reference, use \`somewhere docs <topic> --section <id>\` (MCP: \`docs({ topic })\`, \`catalog\`).

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

With auth enabled, \`api/auth/[...path].ts\` is
\`export { somewhereAuth as default } from '@somewhere-tech/sdk/server'\`; pages
use \`createSomewhereAuth()\` from \`@somewhere-tech/sdk/auth\` (no SDK:
\`docs({ topic: 'auth-client' })\`). \`auth.signUp({ email, password,
displayName? })\` / \`auth.signIn({ email, password })\` return the user or throw
with the message. Gate pages on \`auth.getState().status\` (React:
\`useAuthState()\`) as the auth starter's \`src/App.tsx\` does. Sign-up signs the user
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

Data: declare tables in \`db/schema.ts\`; pages use the generated
\`somewhere:data\` client (\`data.notes.list()\`, \`.create()\`, \`.update(id, …)\`), so
normal data needs no API file. Scope: \`owner()\` per user, \`group()\` per team,
\`appRole()\` for staff; \`client\` names the browser's columns, and
\`publicRead: { where }\` opens rows to visitors. When one write does not fit,
such as a public form filing a row for an owner, keep the client and add one
function for that write; do not make every table \`serverOnly()\`. Store the
owner you look up from the public reference, never one from the body:

\`\`\`ts
const { data: [profile] } = await sw.db.server.from('profiles', { where: { handle }, limit: 1 });
if (!profile) return Response.json({ error: 'unknown handle' }, { status: 404 });
await sw.db.server.insert('entries', { user_id: profile.user_id, title });
\`\`\`

The sender is not the owner. Validation, rate limits and the alert:
\`somewhere docs recipe-signed-in-app\`. \`serverOnly()\` is for tables no browser
reads.
Structured queries: \`sw.db.from\` / \`insert\` / \`update\` / \`remove\` return \`{ data: rows[], count,
changes }\`; \`where: { a: 1, b: { in: ids }, c: { gte: 2 }, d: null }\` (one
operator per column). Raw SQL \`sw.db.query(sql, params)\` runs as written (add \`WHERE
user_id = ?\`; managed projects refuse it). Use \`sw.db.server.query\` for managed
raw access; authorize the caller in your function. Parallel reads: \`Promise.all\`.`;

export const SKILLS_POINTER = `Skills: \`${SKILLS_DIR}/\` — `
  + skillNames(BUNDLED_SKILLS_PACK).map((name) => `\`${name}\``).join(', ')
  + '. Read the skill that matches the task. `somewhere skills status` inspects the installed pack; `somewhere skills update` updates unmodified files.';

export const INIT_AGENTS_MD = `# somewhere.tech project contract\n${SKILLS_POINTER}\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
