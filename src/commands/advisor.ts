import { Command } from 'commander';
import { error, printJson } from '../lib/output.js';
import { callPlatformHelpTool } from '../lib/platform-tools.js';
import { loadConfig } from '../lib/config.js';
import { fetchWithProxy } from '../lib/http.js';
import {
  buildAdvisorContext,
  contextNotice,
  type AdvisorContext,
} from '../lib/advisor-context.js';
export { callPlatformHelpTool };

const ADVISOR_TIMEOUT_MS = 60_000;
const MCP_BASE_URL =
  process.env.SOMEWHERE_MCP_URL?.replace(/\/$/, '') || 'https://mcp.somewhere.tech/mcp';

function publicAdvisorUrl(): string {
  const url = new URL(MCP_BASE_URL);
  url.pathname = '/advisor';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Anonymous callers cannot authorize a linked project. Keep explicitly
 * attached, redacted local context while removing that private identity. */
export function anonymousAdvisorContext(context: AdvisorContext | undefined): AdvisorContext | undefined {
  if (!context) return undefined;
  const { project_ref: _projectRef, ...publicContext } = context;
  return Object.keys(publicContext).length > 0 ? publicContext : undefined;
}

interface PublicAdvisorResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  data?: { answer?: string };
}

export async function callAnonymousAdvisor(
  question: string,
  context?: AdvisorContext,
): Promise<string> {
  const res = await fetchWithProxy(publicAdvisorUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'somewhere-cli',
    },
    body: JSON.stringify({ question, ...(context ? { context } : {}) }),
  }, ADVISOR_TIMEOUT_MS);
  let payload: PublicAdvisorResponse;
  try {
    payload = await res.json() as PublicAdvisorResponse;
  } catch {
    throw new Error(`Advisor returned an invalid response (HTTP ${res.status}).`);
  }
  if (!res.ok || payload.ok !== true) {
    const message = payload.message || 'The advisor could not answer right now.';
    const detail = [payload.error, `HTTP ${res.status}`].filter(Boolean).join(', ');
    throw new Error(`${message}${detail ? ` [${detail}]` : ''}`);
  }
  const answer = payload.data?.answer;
  if (!answer) throw new Error('Advisor returned an empty response.');
  return answer;
}

export function registerAdvisor(program: Command): void {
  program
    .command('advisor <question>')
    .description('Ask the somewhere.tech platform advisor; login adds linked-project context')
    .option('--json', 'Print the advisor response in a JSON envelope')
    .option('--file <path>', 'Attach a trimmed, redacted local file as context')
    .option('--no-context', 'Do not attach the linked project, previous run, or file')
    .action(async (question: string, opts: { json?: boolean; file?: string; context?: boolean }) => {
      try {
        const storedCredential = !!loadConfig()?.token;
        const localContext = opts.context === false ? undefined : buildAdvisorContext(opts.file);
        const context = storedCredential ? localContext : anonymousAdvisorContext(localContext);
        process.stderr.write(`${contextNotice(context)}\n`);
        // A configured credential always stays on the authenticated MCP path.
        // If it is expired or rejected, surface that failure instead of
        // replaying private context through the anonymous endpoint.
        const answer = storedCredential
          ? await callPlatformHelpTool('advisor', {
            question,
            ...(context ? { context } : {}),
          })
          : await callAnonymousAdvisor(question, context);
        if (opts.json) {
          printJson({ question, answer });
        } else {
          process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
