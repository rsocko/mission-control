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
import {
  SCOUT_WORKER_ACTIONS,
  SCOUT_WORKER_SOURCE_TYPES,
  type AgentDataClassification,
  type ScoutWorkerAction,
  type ScoutWorkerCapabilities,
  type ScoutWorkerProviderConfig,
  type ScoutWorkerSourceType,
} from './contracts';
import { DEFAULT_EXTERNAL_AGENT_FIELDS, hashSecret } from './policy';
import { safeEqual } from '@/lib/api/trusted-request';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

const WORKER_PREFIX = 'scout-pull-worker-';
const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export const SCOUT_WORKER_PROTOCOL_VERSION = '2';
export const SCOUT_WORKER_SKILL_VERSION = '1.0.0';

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

function requireScoutConfig(
  worker: NonNullable<Awaited<ReturnType<typeof getExternalAgent>>>,
) {
  const config = worker.providerConfig.scout;
  if (!config) {
    throw new ExternalAgentError(
      'Scout worker onboarding is not configured',
      'INVALID_STATE',
      409,
    );
  }
  return config;
}

function assertToken(
  provided: string,
  expectedHash: string | undefined,
  expiresAt: string | undefined,
  label: string,
) {
  if (
    !provided
    || !expectedHash
    || !safeEqual(hashSecret(provided), expectedHash)
  ) {
    throw new ExternalAgentError(`Invalid ${label}`, 'UNAUTHORIZED', 401);
  }
  if (!expiresAt || expiresAt <= new Date().toISOString()) {
    throw new ExternalAgentError(`${label} expired`, 'CREDENTIAL_EXPIRED', 410);
  }
}

function normalizeCapabilities(value: unknown): ScoutWorkerCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalAgentError('capabilities are required', 'VALIDATION_ERROR', 422);
  }
  const input = value as Partial<ScoutWorkerCapabilities>;
  const sourceTypes = Array.isArray(input.sourceTypes)
    ? [...new Set(input.sourceTypes)]
    : [];
  const actions = Array.isArray(input.actions) ? [...new Set(input.actions)] : [];
  const triggerTypes = Array.isArray(input.triggerTypes)
    ? [...new Set(input.triggerTypes)]
    : [];
  if (
    sourceTypes.length === 0
    || sourceTypes.some((item) =>
      !SCOUT_WORKER_SOURCE_TYPES.includes(item as ScoutWorkerSourceType))
  ) {
    throw new ExternalAgentError(
      'capabilities.sourceTypes contains an unsupported source',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (
    actions.length === 0
    || actions.some((item) => !SCOUT_WORKER_ACTIONS.includes(item as ScoutWorkerAction))
  ) {
    throw new ExternalAgentError(
      'capabilities.actions contains an unsupported action',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (
    triggerTypes.length === 0
    || triggerTypes.some((item) => item !== 'schedule' && item !== 'condition')
  ) {
    throw new ExternalAgentError(
      'capabilities.triggerTypes must contain schedule or condition',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (input.protectedCredentialStorage !== true) {
    throw new ExternalAgentError(
      'Scout must confirm protected credential storage before onboarding',
      'PROTECTED_STORAGE_REQUIRED',
      422,
    );
  }
  let callbackUrl: string | undefined;
  if (input.callbackUrl) {
    let parsed: URL;
    try {
      parsed = new URL(input.callbackUrl);
    } catch {
      throw new ExternalAgentError(
        'capabilities.callbackUrl must be a valid HTTPS URL',
        'VALIDATION_ERROR',
        422,
      );
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.hash
    ) {
      throw new ExternalAgentError(
        'capabilities.callbackUrl must be a credential-free HTTPS URL',
        'VALIDATION_ERROR',
        422,
      );
    }
    callbackUrl = parsed.toString();
  }
  return {
    sourceTypes: sourceTypes as ScoutWorkerSourceType[],
    actions: actions as ScoutWorkerAction[],
    triggerTypes: triggerTypes as Array<'schedule' | 'condition'>,
    protectedCredentialStorage: true,
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

function normalizeClient(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalAgentError('client is required', 'VALIDATION_ERROR', 422);
  }
  const input = value as { name?: unknown; version?: unknown };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const version = typeof input.version === 'string' ? input.version.trim() : '';
  if (!name || !version || name.length > 100 || version.length > 100) {
    throw new ExternalAgentError('client name and version are invalid', 'VALIDATION_ERROR', 422);
  }
  return { name, version };
}

function endpointFor(origin: string, workerId: string) {
  return `${origin.replace(/\/$/, '')}/api/external-agents/${encodeURIComponent(workerId)}/mcp`;
}

function onboardingUrl(origin: string) {
  return `${origin.replace(/\/$/, '')}/api/scout/worker/onboarding`;
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
  const registrationToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const existing = await getExternalAgent(id, true);
  const allowedClassifications: AgentDataClassification[] = [
    'standard',
    'restricted',
  ];
  const scout: ScoutWorkerProviderConfig = {
    connectorId,
    protocolVersion: SCOUT_WORKER_PROTOCOL_VERSION,
    skillVersion: SCOUT_WORKER_SKILL_VERSION,
    onboarding: {
      status: 'pending_registration',
      registrationTokenHash: hashSecret(registrationToken),
      registrationExpiresAt: new Date(now.getTime() + REGISTRATION_TTL_MS).toISOString(),
    },
    connectivity: {
      scoutToMissionControl: 'untested',
      missionControlToScout: 'unsupported',
      detail: 'Microsoft Scout does not document a generic inbound HTTP wake endpoint.',
    },
  };
  const input = {
    name: `${connector.name} work pickup`,
    type: 'pull-queue' as const,
    description: 'Scout automation that claims delegated Mission Control work.',
    authType: 'bearer' as const,
    credential,
    providerConfig: { scout },
    capabilities: {},
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
    enabled: false,
  };
  const worker = existing && !existing.deletedAt
    ? await updateExternalAgent(id, input)
    : await createExternalAgent({ id, ...input });

  return {
    worker: publicExternalAgent(worker),
    setupPrompt: buildScoutOnboardingPrompt({
      onboardingEndpoint: onboardingUrl(origin),
      registrationToken,
      workerId: id,
      workerName: worker.name,
    }),
  };
}

export async function registerScoutWorker(input: {
  workerId: string;
  registrationToken: string;
  capabilities: unknown;
  client: unknown;
}) {
  const worker = await getExternalAgent(input.workerId, true);
  if (!worker || worker.deletedAt || worker.type !== 'pull-queue') {
    throw new ExternalAgentError('Scout worker invitation not found', 'NOT_FOUND', 404);
  }
  const config = requireScoutConfig(worker);
  if (config.onboarding.status !== 'pending_registration') {
    throw new ExternalAgentError(
      'Scout worker invitation was already used',
      'CREDENTIAL_CONSUMED',
      409,
    );
  }
  assertToken(
    input.registrationToken,
    config.onboarding.registrationTokenHash,
    config.onboarding.registrationExpiresAt,
    'registration token',
  );
  const capabilities = normalizeCapabilities(input.capabilities);
  const client = normalizeClient(input.client);
  const claimToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const nextConfig: ScoutWorkerProviderConfig = {
    ...config,
    onboarding: {
      status: 'pending_approval',
      claimTokenHash: hashSecret(claimToken),
      claimExpiresAt: new Date(now.getTime() + CLAIM_TTL_MS).toISOString(),
      requestedAt: now.toISOString(),
    },
    connectivity: {
      scoutToMissionControl: 'verified',
      missionControlToScout: capabilities.callbackUrl ? 'untested' : 'unsupported',
      testedAt: now.toISOString(),
      detail: capabilities.callbackUrl
        ? 'A callback URL was declared but no supported Scout wake protocol is available to test.'
        : 'No generic inbound Scout wake endpoint was declared.',
    },
    client,
  };
  await updateExternalAgent(worker.id, {
    providerConfig: { ...worker.providerConfig, scout: nextConfig },
    capabilities: {
      scout: capabilities,
      canProposeTasks: true,
      canProposePhases: true,
      canPerformM365Actions: capabilities.actions.some((action) =>
        action !== 'read_m365'),
    },
    enabled: false,
  });
  return {
    workerId: worker.id,
    status: 'pending_approval' as const,
    claimToken,
    protocolVersion: SCOUT_WORKER_PROTOCOL_VERSION,
    skillVersion: SCOUT_WORKER_SKILL_VERSION,
    message: 'Registration received. Retain the claim token privately until approval.',
  };
}

export async function approveScoutWorker(connectorId: string) {
  await requireScoutConnector(connectorId);
  const worker = await getExternalAgent(scoutWorkerId(connectorId), true);
  if (!worker || worker.deletedAt) {
    throw new ExternalAgentError('Scout worker not found', 'NOT_FOUND', 404);
  }
  const config = requireScoutConfig(worker);
  if (config.onboarding.status !== 'pending_approval') {
    throw new ExternalAgentError(
      'Scout worker is not awaiting approval',
      'INVALID_TRANSITION',
      409,
    );
  }
  return publicExternalAgent(await updateExternalAgent(worker.id, {
    providerConfig: {
      ...worker.providerConfig,
      scout: {
        ...config,
        onboarding: {
          ...config.onboarding,
          status: 'approved',
          approvedAt: new Date().toISOString(),
        },
      },
    },
  }));
}

export async function rejectScoutWorker(connectorId: string) {
  await requireScoutConnector(connectorId);
  const worker = await getExternalAgent(scoutWorkerId(connectorId), true);
  if (!worker || worker.deletedAt) {
    throw new ExternalAgentError('Scout worker not found', 'NOT_FOUND', 404);
  }
  const config = requireScoutConfig(worker);
  if (config.onboarding.status !== 'pending_approval') {
    throw new ExternalAgentError(
      'Scout worker is not awaiting approval',
      'INVALID_TRANSITION',
      409,
    );
  }
  return publicExternalAgent(await updateExternalAgent(worker.id, {
    enabled: false,
    providerConfig: {
      ...worker.providerConfig,
      scout: {
        ...config,
        onboarding: {
          status: 'rejected',
          rejectedAt: new Date().toISOString(),
        },
      },
    },
  }));
}

export async function getScoutClaimStatus(workerId: string, claimToken: string) {
  const worker = await getExternalAgent(workerId, true);
  if (!worker || worker.deletedAt) {
    throw new ExternalAgentError('Scout worker not found', 'NOT_FOUND', 404);
  }
  const config = requireScoutConfig(worker);
  assertToken(
    claimToken,
    config.onboarding.claimTokenHash,
    config.onboarding.claimExpiresAt,
    'claim token',
  );
  if (config.onboarding.status === 'rejected') {
    await updateExternalAgent(worker.id, {
      providerConfig: {
        ...worker.providerConfig,
        scout: {
          ...config,
          onboarding: {
            status: 'rejected',
            ...(config.onboarding.rejectedAt
              ? { rejectedAt: config.onboarding.rejectedAt }
              : {}),
          },
        },
      },
    }, { expectedScoutOnboardingStatus: 'rejected' });
  }
  return { workerId, status: config.onboarding.status };
}

export async function claimScoutWorkerCredential(
  workerId: string,
  claimToken: string,
  origin: string,
) {
  const worker = await getExternalAgent(workerId, true);
  if (!worker || worker.deletedAt) {
    throw new ExternalAgentError('Scout worker not found', 'NOT_FOUND', 404);
  }
  const config = requireScoutConfig(worker);
  if (config.onboarding.status !== 'approved') {
    throw new ExternalAgentError(
      config.onboarding.status === 'claimed'
        ? 'Worker credential was already claimed'
        : 'Scout worker is not approved',
      config.onboarding.status === 'claimed'
        ? 'CREDENTIAL_CONSUMED'
        : 'APPROVAL_REQUIRED',
      409,
    );
  }
  assertToken(
    claimToken,
    config.onboarding.claimTokenHash,
    config.onboarding.claimExpiresAt,
    'claim token',
  );
  const credential = await resolveExternalAgentCredential(worker);
  if (!credential) {
    throw new ExternalAgentError(
      'Scout worker credential is unavailable',
      'CREDENTIAL_UNAVAILABLE',
      503,
    );
  }
  const claimedAt = new Date().toISOString();
  await updateExternalAgent(worker.id, {
    enabled: true,
    providerConfig: {
      ...worker.providerConfig,
      scout: {
        ...config,
        onboarding: {
          status: 'claimed',
          requestedAt: config.onboarding.requestedAt,
          approvedAt: config.onboarding.approvedAt,
          claimedAt,
        },
      },
    },
  }, { expectedScoutOnboardingStatus: 'approved' });
  return {
    workerId,
    status: 'claimed' as const,
    mcp: {
      transport: 'streamable-http',
      url: endpointFor(origin, workerId),
      authorization: {
        scheme: 'Bearer',
        token: credential,
        sensitive: true,
        storageRequirement: 'Store only in Scout protected MCP connection credentials.',
      },
    },
    protocolVersion: SCOUT_WORKER_PROTOCOL_VERSION,
    skillVersion: SCOUT_WORKER_SKILL_VERSION,
  };
}

export async function getScoutWorkerIdentity(workerId: string) {
  const worker = await getExternalAgent(workerId);
  if (!worker || worker.type !== 'pull-queue') {
    throw new ExternalAgentError('Scout worker not found', 'NOT_FOUND', 404);
  }
  const config = requireScoutConfig(worker);
  if (config.onboarding.status !== 'claimed') {
    throw new ExternalAgentError('Scout worker is not active', 'INVALID_STATE', 409);
  }
  const now = new Date().toISOString();
  const nextConfig = {
    ...config,
    lastSeenAt: now,
    connectivity: {
      ...config.connectivity,
      scoutToMissionControl: 'verified' as const,
      testedAt: now,
    },
  };
  const updated = await updateExternalAgent(worker.id, {
    providerConfig: { ...worker.providerConfig, scout: nextConfig },
  });
  return {
    id: updated.id,
    name: updated.name,
    connectorId: nextConfig.connectorId,
    protocolVersion: nextConfig.protocolVersion,
    skillVersion: nextConfig.skillVersion,
    capabilities: updated.capabilities.scout,
    dataPolicy: updated.dataPolicy,
    onboardingStatus: nextConfig.onboarding.status,
    lastSeenAt: now,
  };
}

export async function getScoutWorkerHealth(workerId: string) {
  const identity = await getScoutWorkerIdentity(workerId);
  const worker = await getExternalAgent(workerId);
  const config = requireScoutConfig(worker!);
  return {
    status: worker?.enabled ? 'ready' : 'disabled',
    identity,
    connectivity: config.connectivity,
    activation: {
      mode: 'pull',
      guaranteedTrigger: 'schedule',
      optionalTrigger: 'Scout-defined condition',
      missionControlWakeSupported: false,
    },
  };
}

export async function disableScoutWorker(connectorId: string) {
  await requireScoutConnector(connectorId);
  const id = scoutWorkerId(connectorId);
  const worker = await getExternalAgent(id);
  if (!worker) return null;
  return publicExternalAgent(await updateExternalAgent(id, { enabled: false }));
}

function buildScoutOnboardingPrompt(input: {
  onboardingEndpoint: string;
  registrationToken: string;
  workerId: string;
  workerName: string;
}) {
  return `Onboard this Scout runtime as "${input.workerName}" in Mission Control.

Onboarding endpoint: ${input.onboardingEndpoint}
Worker ID: ${input.workerId}
Registration token: ${input.registrationToken}

1. Read the versioned Scout worker skill from ${input.onboardingEndpoint}?document=skill.
2. Confirm that Scout can store an MCP bearer credential in a protected connection field. Do not continue if the only available storage is prompt text, automation output, a chat transcript, or logs.
3. POST action "register" to the onboarding endpoint with this worker ID, registration token, Scout client name/version, and the source, action, trigger, protected-storage, and optional callback capabilities described by the skill.
4. Store the returned one-time claim token privately and wait for a Mission Control operator to approve the registration.
5. Poll action "status" with the claim token at a reasonable interval. After approval, POST action "claim" exactly once.
6. Store the returned bearer token only in Scout's protected MCP connection credential field. Mark it sensitive and never interpolate it into prompts, automation definitions, output, logs, email, Teams messages, or summaries.
7. Configure the recurring pickup automation and run the identity, health, and empty-queue tests described by the skill.

The registration token is temporary and is not the durable MCP credential.`;
}

export function buildScoutWorkerSkill() {
  return `---
name: mission-control-scout-worker
description: Claim and execute explicitly delegated Mission Control work from Microsoft Scout.
version: ${SCOUT_WORKER_SKILL_VERSION}
protocol: ${SCOUT_WORKER_PROTOCOL_VERSION}
---

# Mission Control Scout Worker

Use the dedicated Mission Control MCP connection only after approved onboarding.

## Registration capabilities

Declare:
- sourceTypes: email, teams, meeting, planner, or cross-source
- actions: read_m365, create_draft, send_message, update_planner, or update_calendar
- triggerTypes: schedule and/or condition
- protectedCredentialStorage: true only when the MCP bearer token is stored in a protected connection field
- callbackUrl only if Scout exposes a credential-free HTTPS callback compatible with a documented future Mission Control wake protocol

Never claim capabilities that are unavailable in the current Scout tenant or permission policy.

## Activation

Mission Control cannot directly wake Scout through MCP. Configure a recurring Scout automation every 15 minutes. A Scout-native condition trigger may run the same automation sooner, but scheduled polling remains the recovery path.

## Every run

1. Call mc_agent_identity and stop if the identity, connector, protocol, or policy is unexpected.
2. Call mc_agent_health when validating setup or diagnosing connectivity.
3. Call mc_agent_claim_work once. Pass a dispatchId only when Scout received an authenticated, scoped trigger context from a supported trigger.
4. Exit successfully and silently when no work is available.
5. Follow only the claimed instruction and allowedActions.
6. Call mc_agent_update_progress before work and periodically while working.
7. For human input or approval, call mc_agent_request_input. Stop work and discard the claim token after it succeeds. A later claim will contain the durable resume context.
8. Call mc_agent_complete_work on success or mc_agent_fail_work with a sanitized error on failure.

Never reuse a claim token, retry an expired claim, broaden the disclosed scope, or expose credentials.`;
}
