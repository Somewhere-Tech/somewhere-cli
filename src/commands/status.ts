import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, printJson, statusDot, teal, timeAgo } from '../lib/output.js';
import { callPlatformTool } from '../lib/platform-tools.js';
import { isRecord, unwrapPlatformData } from '../lib/platform-command.js';
import { fallbackProjectServingUrl, getProjectServingUrl } from '../lib/project-urls.js';
import { chooseProjectRef, projectRefConflictMessage } from '../lib/project-ref.js';
import { promoteCommands } from '../lib/promote-handoff.js';

export interface PreviewCandidateStatus {
  draft_id: string;
  candidate_release_id: string;
  preview_origin?: string;
  expires_at?: string;
}

export interface DeploymentProvenance {
  promotedFromCandidate: string | null;
  shortContentHash: string | null;
}

/** Additive deploy-status fields are untrusted at this boundary: older
 * platforms omit them and malformed values must never break `status`. */
export function deploymentProvenanceFromStatus(
  deployment: Record<string, unknown>,
): DeploymentProvenance {
  const candidate = typeof deployment.promoted_from_candidate_id === 'string'
    && deployment.promoted_from_candidate_id.trim()
    ? deployment.promoted_from_candidate_id.trim()
    : null;
  const hash = typeof deployment.production_content_hash === 'string'
    ? /^sha256:([a-f0-9]{12,})$/i.exec(deployment.production_content_hash.trim())
    : null;
  return {
    promotedFromCandidate: candidate,
    shortContentHash: hash ? `sha256:${hash[1].slice(0, 12)}` : null,
  };
}

export function previewCandidatesFromDeployment(
  deployment: Record<string, unknown>,
): PreviewCandidateStatus[] {
  const raw = Array.isArray(deployment.preview_candidates)
    ? deployment.preview_candidates
    : isRecord(deployment.draft)
        ? [deployment.draft]
        : [];
  return raw.filter(isRecord).flatMap((candidate) => {
    if (typeof candidate.draft_id !== 'string'
        || typeof candidate.candidate_release_id !== 'string') return [];
    return [{
      draft_id: candidate.draft_id,
      candidate_release_id: candidate.candidate_release_id,
      ...(typeof candidate.preview_origin === 'string' ? { preview_origin: candidate.preview_origin } : {}),
      ...(typeof candidate.expires_at === 'string' ? { expires_at: candidate.expires_at } : {}),
    }];
  });
}

const PLAN_ENTITLEMENT_CODES = new Set([
  'CLOUD_DEV_NOT_ENABLED',
  'FEATURE_NOT_ON_PLAN',
  'PLAN_REQUIRED',
  'UPGRADE_REQUIRED',
]);

export interface PlanEntitlementNote {
  code: string;
  message: string;
}

/** Read a platform tool error as a plan-entitlement fact, or null when it is a
 *  real problem (deploy failed, project missing, auth broken). Tool errors
 *  arrive as `CODE: message`, the shape platform-tools.ts renders. */
export function planEntitlementFromError(err: unknown): PlanEntitlementNote | null {
  const text = err instanceof Error ? err.message : String(err);
  const match = /^([A-Z][A-Z0-9_]{2,}):\s*(.*)$/s.exec(text.trim());
  if (!match) return null;
  if (!PLAN_ENTITLEMENT_CODES.has(match[1])) return null;
  return { code: match[1], message: match[2].trim() || text.trim() };
}

/** One line that states the entitlement as information. The platform's own
 *  wording is kept — it is the thing that knows which plans include it. */
export function planEntitlementLine(note: PlanEntitlementNote): string {
  const subject = note.code === 'CLOUD_DEV_NOT_ENABLED'
    ? 'Preview'
    : 'Deploy status';
  return `${subject}: not included on this plan — ${note.message}`;
}

interface ProductionDeployRecord {
  version?: unknown;
  release_id?: unknown;
  active_release_id?: unknown;
  status?: unknown;
  active?: unknown;
}

/** Build the production-only status from the plan-neutral deploy history API.
 * Preview candidates intentionally do not exist on this surface. */
export function productionDeploymentFromHistory(value: unknown): Record<string, unknown> {
  const response = isRecord(value) ? value : {};
  const rawDeploys = Array.isArray(value)
    ? value
    : Array.isArray(response.deploys)
      ? response.deploys
      : Array.isArray(response.releases)
        ? response.releases
        : [];
  const deploys = rawDeploys.filter(isRecord) as ProductionDeployRecord[];
  const topLevelActiveId = typeof response.active_release_id === 'string'
    ? response.active_release_id
    : null;
  const active = deploys.find((deploy) =>
    topLevelActiveId !== null && deploy.release_id === topLevelActiveId)
    ?? deploys.find((deploy) => deploy.active === true)
    ?? [...deploys]
      .filter((deploy) => deploy.status === 'success' || deploy.status === 'live' || deploy.status === 'active')
      .sort((a, b) =>
        (typeof b.version === 'number' ? b.version : -1)
        - (typeof a.version === 'number' ? a.version : -1))[0]
    ?? null;
  const activeReleaseId = topLevelActiveId
    ?? (typeof active?.active_release_id === 'string'
      ? active.active_release_id
      : typeof active?.release_id === 'string'
        ? active.release_id
        : null);
  const prodVersion = typeof response.prod_version === 'number'
    ? response.prod_version
    : typeof response.production_version === 'number'
      ? response.production_version
      : typeof active?.version === 'number'
        ? active.version
        : 0;

  return {
    published: activeReleaseId !== null || prodVersion > 0,
    prod_version: prodVersion,
    active_release_id: activeReleaseId,
    preview_candidates: [],
  };
}

function printProductionDeployment(deployment: Record<string, unknown>): void {
  const prodVersion = typeof deployment.prod_version === 'number'
    ? deployment.prod_version
    : typeof deployment.dev_version === 'number' && deployment.in_sync === true
      ? deployment.dev_version
      : null;
  if (prodVersion !== null) info(`Production version: ${teal(String(prodVersion))}`);
  if (typeof deployment.active_release_id === 'string') {
    info(`Active release: ${dim(deployment.active_release_id)}`);
  }
  const provenance = deploymentProvenanceFromStatus(deployment);
  if (provenance.promotedFromCandidate) {
    info(`Promoted from candidate ${teal(provenance.promotedFromCandidate)}`);
  }
  if (provenance.shortContentHash) {
    info(`Content hash: ${dim(provenance.shortContentHash)}`);
  }
}

export function registerStatus(program: Command) {
  program
    .command('status [project]')
    .description('Show project and workspace status')
    .option('--project <ref>', 'Project ID, name, slug, or subdomain — the same flag every other command takes. The positional form still works.')
    .option('--json', 'Print the raw status responses as JSON')
    .action(async (projectArg: string | undefined, opts) => {
      const token = getToken();
      const client = new ApiClient(token);

      const chosen = chooseProjectRef(projectArg, opts.project);
      if (chosen.kind === 'conflict') {
        error(projectRefConflictMessage(chosen));
        process.exit(1);
      }
      let projectId = chosen.kind === 'ref' ? chosen.ref : undefined;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass a project ID (positionally or with --project) or run `somewhere init`.');
          process.exit(1);
        }
        projectId = config.project_id;
      }

      let projectStatus: {
        name: string;
        status: string;
        subdomain: string;
        slug?: string;
        updated_at?: string;
      } | null = null;
      let projectError: string | null = null;
      let deploymentStatus: Record<string, unknown> | null = null;
      let deploymentError: string | null = null;
      let deploymentEntitlement: PlanEntitlementNote | null = null;
      let workspaceStatus: {
        status: string;
        terminal_url?: string | null;
      } | null = null;

      try {
        const p = await client.call<{
          name: string;
          status: string;
          subdomain: string;
          slug?: string;
          updated_at?: string;
        }>('GET', `/projects/${encodeURIComponent(projectId)}`);
        projectStatus = p;

        const servingUrl = await getProjectServingUrl(client, projectId).catch(() =>
          fallbackProjectServingUrl(p),
        );

        if (!opts.json) {
          console.log(`\n  Project: ${teal(p.name)} (${statusDot(p.status)})`);
          if (servingUrl) info(`URL: ${servingUrl}`);
          if (p.updated_at) {
            info(`Last deploy: ${timeAgo(p.updated_at)}`);
          }

        }
      } catch (err) {
        projectError = err instanceof Error ? err.message : String(err);
        if (!opts.json) error(`Project: ${projectError}`);
        process.exitCode = 1; // a failed status must not report success to a script
      }

      try {
        const deployment = unwrapPlatformData(await callPlatformTool(
          'deploy_status',
          { project_id: projectId },
          { allTools: true },
        ));
        if (!isRecord(deployment)) throw new Error('deploy_status returned an unexpected response.');
        deploymentStatus = deployment;
        if (!opts.json) {
          printProductionDeployment(deployment);
          if (deployment.dev_ahead === true) {
            info(`Preview: ${deployment.files_changed ?? 'some'} file(s) ahead of production`);
          } else if (deployment.in_sync === true) {
            info('Deploy state: preview and production are in sync');
          }
          const previewCandidates = previewCandidatesFromDeployment(deployment);
          for (const [index, candidate] of previewCandidates.entries()) {
            info(`Preview candidate${previewCandidates.length > 1 ? ` ${index + 1}` : ''}: ${teal(candidate.draft_id)}`);
            info(`Candidate release: ${dim(candidate.candidate_release_id)}`);
            if (candidate.preview_origin) info(`Preview host: ${candidate.preview_origin}`);
            // Runnable in the shell reading it — a non-interactive caller gets
            // the `--yes` form, since bare promote refuses without a terminal.
            for (const line of promoteCommands({
              previewSessionId: candidate.draft_id,
              previewId: candidate.candidate_release_id,
              projectRef: projectId,
              interactive: process.stdin.isTTY === true,
            })) {
              info(`Promote: ${dim(line)}`);
            }
            if (candidate.expires_at) info(`Preview expires: ${candidate.expires_at}`);
          }
        }
      } catch (err) {
        // A plan entitlement is an answer, not a failure. A healthy project on
        // a plan without cloud dev must still exit 0 (tsk_f250e561); only a
        // real problem — deploy failed, project unreachable, auth broken —
        // exits non-zero.
        deploymentEntitlement = planEntitlementFromError(err);
        if (deploymentEntitlement) {
          try {
            const history = await client.call<unknown>(
              'GET',
              `/projects/${encodeURIComponent(projectId)}/deploys`,
            );
            deploymentStatus = productionDeploymentFromHistory(history);
            if (!opts.json) printProductionDeployment(deploymentStatus);
          } catch (historyErr) {
            deploymentError = historyErr instanceof Error ? historyErr.message : String(historyErr);
            if (!opts.json) error(`Production status: ${deploymentError}`);
            process.exitCode = 1;
          }
          if (!opts.json) {
            info(planEntitlementLine(deploymentEntitlement));
            info(dim('— your deployed app and `somewhere deploy` are unaffected'));
          }
        } else {
          deploymentError = err instanceof Error ? err.message : String(err);
          if (!opts.json) error(`Deploy status: ${deploymentError}`);
          process.exitCode = 1;
        }
      }

      try {
        const ws = await client.call<{
          status: string;
          terminal_url?: string | null;
        }>('GET', '/hosted/status');
        workspaceStatus = ws;

        if (!opts.json) {
          console.log('');
          // The hosted code workspace is OPTIONAL and separate from the deployed
          // app — a non-'ready' status here (e.g. "waking") NEVER means the live
          // site is down (audit #8 / tsk_30633bb3). Label it as the dev workspace
          // and say so, so "waking" doesn't read as an outage.
          const wsStatus = ws.status === 'ready' ? 'running' : `${ws.status} (starting)`;
          info(`Dev workspace: ${wsStatus} ${dim('— optional code workspace; your deployed app serves regardless')}`);
          if (ws.terminal_url) {
            info(`Terminal: ${dim(ws.terminal_url)}`);
          }
        }
      } catch {
        // No workspace or not configured — just skip
      }

      if (opts.json) {
        printJson({
          project: projectStatus,
          deployment: deploymentStatus,
          workspace: workspaceStatus,
          project_error: projectError,
          deployment_error: deploymentError,
          // A plan fact, reported separately from `deployment_error` so a
          // script never reads "not on your plan" as a broken project.
          deployment_entitlement: deploymentEntitlement === null
            ? null
            : {
                code: deploymentEntitlement.code,
                message: deploymentEntitlement.message,
                deploy_affected: false,
              },

        });
      } else {
        console.log('');
      }
    });
}
