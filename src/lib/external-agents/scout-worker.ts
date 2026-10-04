import 'server-only';

import { randomBytes } from 'node:crypto';
import { ExternalAgentError } from './errors';
import {
  createExternalAgent,
  getExternalAgent,
  publicExternalAgent,
  resolveExternalAgentCredential,
  updateExternalAgent,
} from './registry';
import type { AgentDataClassification } from './contracts';
import { DEFAULT_EXTERNAL_AGENT_FIELDS } from './policy';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

const WORKER_PREFIX = 'scout-pull-worker-';

export function scoutWorkerId(connectorId: string) {
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(connectorId)) {
    throw new ExternalAgentError('connectorId is invalid', 'VALIDATION_ERROR', 422);
  }
  return `${WORKER_PREFIX}${connectorId}`;
}

async function requireScoutConnector(connectorId: string) {
  const connector = await (
    await getConnectorManagementPersistence()
  ).getConnector(connectorId);
  if (!connector || connector.deletedAt || connector.type !== 'scout') {
    throw new ExternalAgentError('Scout connector not found', 'NOT_FOUND', 404);
  }
  return connector;
}

export async function getScoutWorker(connectorId: string) {
  await requireScoutConnector(connectorId);
  const worker = await getExternalAgent(scoutWorkerId(connectorId), true);
  return worker && !worker.deletedAt ? publicExternalAgent(worker) : null;
}

export async function provisionScoutWorker(
  connectorId: string,
  origin: string,
) {
  const connector = await requireScoutConnector(connectorId);
  const id = scoutWorkerId(connectorId);
  const credential = randomBytes(32).toString('base64url');
  const existing = await getExternalAgent(id, true);
  const allowedClassifications: AgentDataClassification[] = [
    'standard',
    'restricted',
  ];
  const input = {
    name: `${connector.name} work pickup`,
    type: 'pull-queue' as const,
    description: 'Scout scheduled automation that claims delegated Mission Control work.',
    authType: 'bearer' as const,
    credential,
    capabilities: {
      canProposeTasks: true,
      canProposePhases: true,
      canPerformM365Actions: true,
    },
    dataPolicy: {
      allowedClassifications,
      fieldAllowlist: [
        ...DEFAULT_EXTERNAL_AGENT_FIELDS,
        'project.description',
        'tasks.description',
        'phases.name',
        'phases.description',
        'phases.taskIds',
        'phases.sortOrder',
      ],
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    },
    enabled: true,
  };
  const worker = existing && !existing.deletedAt
    ? await updateExternalAgent(id, input)
    : await createExternalAgent({ id, ...input });
  const endpoint = `${origin.replace(/\/$/, '')}/api/external-agents/${encodeURIComponent(id)}/mcp`;

  return {
    worker: publicExternalAgent(worker),
    endpoint,
    setupPrompt: buildScoutSetupPrompt({ endpoint, credential, workerName: worker.name }),
  };
}

export async function revealScoutWorkerSetup(
  connectorId: string,
  origin: string,
) {
  await requireScoutConnector(connectorId);
  const worker = await getExternalAgent(scoutWorkerId(connectorId));
  if (!worker || worker.deletedAt || !worker.enabled) {
    throw new ExternalAgentError(
      'Scout work pickup is not enabled',
      'NOT_FOUND',
      404,
    );
  }
  const credential = await resolveExternalAgentCredential(worker);
  if (!credential) {
    throw new ExternalAgentError(
      'Scout worker credential is unavailable',
      'CREDENTIAL_UNAVAILABLE',
      409,
    );
  }
  const endpoint = `${origin.replace(/\/$/, '')}/api/external-agents/${encodeURIComponent(worker.id)}/mcp`;
  return {
    worker: publicExternalAgent(worker),
    endpoint,
    setupPrompt: buildScoutSetupPrompt({
      endpoint,
      credential,
      workerName: worker.name,
    }),
  };
}

export async function disableScoutWorker(connectorId: string) {
  await requireScoutConnector(connectorId);
  const id = scoutWorkerId(connectorId);
  const worker = await getExternalAgent(id);
  if (!worker) return null;
  return publicExternalAgent(await updateExternalAgent(id, { enabled: false }));
}

function buildScoutSetupPrompt(input: {
  endpoint: string;
  credential: string;
  workerName: string;
}) {
  return `Set up a recurring automation named "${input.workerName}" that checks Mission Control for delegated work every 15 minutes.

Connect this dedicated MCP server:
- Transport: Streamable HTTP
- URL: ${input.endpoint}
- Authorization: Bearer ${input.credential}

For every scheduled run:
1. Call mc_agent_claim_work once.
2. If it reports that no work is available, end successfully without sending a notification.
3. If work is claimed, follow only the disclosed instruction and allowedActions in the claim. Do not broaden the task or disclose its content elsewhere.
4. Call mc_agent_update_progress before starting and periodically during long work so the lease remains active.
5. Call mc_agent_complete_work with a concise summary and any structured task or phase proposals when the work succeeds.
6. Call mc_agent_fail_work with a clear, sanitized error if the work cannot be completed.
7. Never reuse a claimToken for another dispatch, and never retry an expired claim without claiming the work again.

Keep this MCP credential private. Do not include it in automation output, logs, task content, email, Teams messages, or generated summaries. Confirm when the automation and MCP connection are configured, then run one empty-queue connection test.`;
}
