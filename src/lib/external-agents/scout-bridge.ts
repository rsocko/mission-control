import 'server-only';

import {
  createHash,
  createHmac,
} from 'node:crypto';
import type {
  AgentDataClassification,
  AgentDispatchDetail,
  AgentDispatchRecord,
  PaperclipScoutBrokerRequest,
  PaperclipScoutCapability,
} from './contracts';
import { ExternalAgentError } from './errors';
import { safeEqual } from '@/lib/api/trusted-request';
import {
  hashCanonical,
  redactForPersistence,
} from './policy';
import {
  getExternalAgent,
  resolveAgentCredential,
  type ExternalAgent,
} from './registry';
import {
  confirmDispatch,
  createDispatchPreview,
  getDispatch,
  type DispatchResultInput,
} from './service';

const AUTH_WINDOW_MS = 5 * 60_000;
const HIGH_RISK_PATTERN =
  /(send|message|mail|delete|remove|destroy|identity|permission|role|financial|payment|transfer|purchase|approve|sign)/i;

export interface PaperclipScoutRequestInput {
  paperclipAgentId: string;
  requestId: string;
  companyId: string;
  agentId: string;
  destinationAgentId: string;
  tenantId: string;
  tool: string;
  action: string;
  dataClassification?: AgentDataClassification;
  input: Record<string, unknown>;
  timeoutMs?: number;
}

function requiredText(value: unknown, field: string, maxLength = 255) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExternalAgentError(`${field} is required`, 'VALIDATION_ERROR', 422);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ExternalAgentError(
      `${field} exceeds ${maxLength} characters`,
      'VALIDATION_ERROR',
      422,
    );
  }
  return normalized;
}

function bridgeCredentialReference(agentId: string) {
  return `paperclip-scout:${agentId}`;
}

function bodyDigest(body: string) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export async function requirePaperclipScoutAuthentication(
  request: Request,
  paperclipAgentId: string,
  rawBody = '',
) {
  const agent = await getExternalAgent(requiredText(
    paperclipAgentId,
    'paperclipAgentId',
  ));
  if (!agent || agent.type !== 'paperclip' || !agent.enabled || agent.deletedAt) {
    throw new ExternalAgentError('Paperclip agent not found', 'NOT_FOUND', 404);
  }
  const timestamp = request.headers.get('x-mc-paperclip-timestamp');
  const signature = request.headers.get('x-mc-paperclip-signature');
  const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (
    !timestamp
    || !Number.isFinite(timestampMs)
    || Math.abs(Date.now() - timestampMs) > AUTH_WINDOW_MS
  ) {
    throw new ExternalAgentError(
      'Paperclip request timestamp is missing or expired',
      'REPLAY_REJECTED',
      401,
    );
  }
  if (!signature?.startsWith('sha256=')) {
    throw new ExternalAgentError('Paperclip request signature is missing', 'UNAUTHORIZED', 401);
  }
  const url = new URL(request.url);
  const signed = [
    timestamp,
    agent.id,
    request.method.toUpperCase(),
    url.pathname,
    bodyDigest(rawBody),
  ].join('\n');
  const expected = createHmac(
    'sha256',
    resolveAgentCredential(bridgeCredentialReference(agent.id))!,
  ).update(signed, 'utf8').digest('hex');
  if (!safeEqual(signature.slice('sha256='.length), expected)) {
    throw new ExternalAgentError('Invalid Paperclip request signature', 'UNAUTHORIZED', 401);
  }
  return agent;
}

function capabilityKey(tool: string, action: string) {
  return `${tool}:${action}`;
}

function configuredCapability(
  source: ExternalAgent,
  tool: string,
  action: string,
): PaperclipScoutCapability {
  const capability = source.providerConfig.paperclip?.scoutBridge?.capabilities.find(
    (entry) => entry.tool === tool && entry.actions.includes(action),
  );
  if (!capability) {
    throw new ExternalAgentError(
      'Paperclip agent is not authorized for the requested Scout action',
      'CAPABILITY_MISMATCH',
      403,
    );
  }
  return capability;
}

function isHighRisk(capability: PaperclipScoutCapability, tool: string, action: string) {
  return capability.risk !== 'low'
    || HIGH_RISK_PATTERN.test(tool)
    || HIGH_RISK_PATTERN.test(action);
}

function minimizeInput(
  value: unknown,
  capability: PaperclipScoutCapability,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalAgentError('input must be an object', 'VALIDATION_ERROR', 422);
  }
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).filter((key) => !capability.inputFields.includes(key));
  if (unexpected.length > 0) {
    throw new ExternalAgentError(
      `Input fields are not allowed for this capability: ${unexpected.join(', ')}`,
      'DISCLOSURE_BLOCKED',
      403,
    );
  }
  return redactForPersistence(
    Object.fromEntries(capability.inputFields
      .filter((field) => input[field] !== undefined)
      .map((field) => [field, input[field]])),
    { maxBytes: 128 * 1024 },
  ) as Record<string, unknown>;
}

function assertDestination(destination: ExternalAgent | null, expectedId: string) {
  if (!destination || !destination.enabled || destination.deletedAt) {
    throw new ExternalAgentError('Scout destination not found', 'NOT_FOUND', 404);
  }
  if (
    destination.id !== expectedId
    || destination.type !== 'pull-queue'
    || destination.transport !== 'pull'
    || destination.inputFormat !== 'scout-capability-request-v1'
  ) {
    throw new ExternalAgentError(
      'Configured destination is not a Scout pull-queue boundary',
      'EXECUTION_BOUNDARY_MISMATCH',
      409,
    );
  }
  if (!destination.dataPolicy.fieldAllowlist.includes('brokerRequest')) {
    throw new ExternalAgentError(
      'Scout destination does not allow the minimized broker request field',
      'DISCLOSURE_BLOCKED',
      409,
    );
  }
}

export async function requestPaperclipScoutDispatch(
  source: ExternalAgent,
  input: PaperclipScoutRequestInput,
) {
  const sourceConfig = source.providerConfig.paperclip;
  const bridge = sourceConfig?.scoutBridge;
  if (!sourceConfig || !bridge) {
    throw new ExternalAgentError(
      'Paperclip Scout bridge is not configured',
      'CAPABILITY_MISMATCH',
      403,
    );
  }
  if (requiredText(input.paperclipAgentId, 'paperclipAgentId') !== source.id) {
    throw new ExternalAgentError(
      'Paperclip source identity differs from the authenticated identity',
      'PROVIDER_SCOPE_MISMATCH',
      403,
    );
  }
  const companyId = requiredText(input.companyId, 'companyId');
  const requesterAgentId = requiredText(input.agentId, 'agentId');
  if (
    companyId !== sourceConfig.companyId
    || requesterAgentId !== sourceConfig.assigneeAgentId
  ) {
    throw new ExternalAgentError(
      'Paperclip company or agent is outside the configured source identity',
      'PROVIDER_SCOPE_MISMATCH',
      403,
    );
  }
  if (
    requiredText(input.destinationAgentId, 'destinationAgentId') !== bridge.destinationAgentId
    || requiredText(input.tenantId, 'tenantId') !== bridge.tenantId
  ) {
    throw new ExternalAgentError(
      'Scout destination or tenant differs from the configured policy',
      'PROVIDER_SCOPE_MISMATCH',
      403,
    );
  }
  const tool = requiredText(input.tool, 'tool', 120);
  const action = requiredText(input.action, 'action', 120);
  const capability = configuredCapability(source, tool, action);
  const classification = input.dataClassification ?? 'standard';
  if (classification !== 'standard') {
    throw new ExternalAgentError(
      'The Paperclip Scout bridge denies restricted and local-only requests',
      'DISCLOSURE_BLOCKED',
      403,
    );
  }
  const destination = await getExternalAgent(bridge.destinationAgentId);
  assertDestination(destination, bridge.destinationAgentId);
  const allowedAction = capabilityKey(tool, action);
  if (!destination!.capabilities.allowedActions?.includes(allowedAction)) {
    throw new ExternalAgentError(
      'Scout destination does not authorize the requested tool action',
      'CAPABILITY_MISMATCH',
      403,
    );
  }
  const requestId = requiredText(input.requestId, 'requestId', 255);
  const brokerRequest: PaperclipScoutBrokerRequest = {
    version: 1,
    requestId,
    source: {
      externalAgentId: source.id,
      companyId,
      agentId: requesterAgentId,
    },
    destination: {
      externalAgentId: destination!.id,
      tenantId: bridge.tenantId,
    },
    capability: {
      tool,
      action,
      risk: capability.risk,
    },
    input: minimizeInput(input.input, capability),
  };
  const preview = await createDispatchPreview({
    agentId: destination!.id,
    instruction: `Paperclip requested Scout capability ${allowedAction}`,
    dataClassification: classification,
    allowedActions: [allowedAction],
    idempotencyKey: `paperclip-scout:${hashCanonical({
      sourceId: source.id,
      requestId,
    })}`,
    timeoutMs: input.timeoutMs,
    brokerRequest,
  });
  const automation = bridge.automation;
  const mayAutomate = automation?.enabled === true
    && !isHighRisk(capability, tool, action)
    && automation.capabilities.some((entry) =>
      entry.tool === tool && entry.action === action);
  const dispatch = mayAutomate
    ? (await confirmDispatch(preview.id, preview.previewHash)).dispatch
    : preview;
  return paperclipScoutState(dispatch);
}

function parseBrokerRequest(value: unknown): PaperclipScoutBrokerRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PaperclipScoutBrokerRequest>;
  return candidate.version === 1 ? candidate as PaperclipScoutBrokerRequest : null;
}

export async function validateScoutBridgeClaim(
  destination: ExternalAgent,
  claim: { dispatchId: string; payload: Record<string, unknown> },
) {
  const request = parseBrokerRequest(claim.payload.brokerRequest);
  if (!request) return;
  if (request.destination.externalAgentId !== destination.id) {
    throw new ExternalAgentError('Scout claim destination changed', 'PROVIDER_SCOPE_MISMATCH', 409);
  }
  const source = await getExternalAgent(request.source.externalAgentId);
  if (!source || source.type !== 'paperclip' || !source.enabled || source.deletedAt) {
    throw new ExternalAgentError('Paperclip source identity is no longer valid', 'AGENT_DISABLED', 409);
  }
  const bridge = source.providerConfig.paperclip?.scoutBridge;
  const capability = configuredCapability(
    source,
    request.capability.tool,
    request.capability.action,
  );
  if (
    request.source.companyId !== source.providerConfig.paperclip?.companyId
    || request.source.agentId !== source.providerConfig.paperclip?.assigneeAgentId
    || bridge?.destinationAgentId !== destination.id
    || bridge.tenantId !== request.destination.tenantId
    || capability.risk !== request.capability.risk
    || !destination.capabilities.allowedActions?.includes(
      capabilityKey(request.capability.tool, request.capability.action),
    )
  ) {
    throw new ExternalAgentError(
      'Scout claim no longer satisfies tenant, identity, tool, and action policy',
      'PROVIDER_SCOPE_MISMATCH',
      409,
    );
  }
}

export function validateScoutBridgeResult(
  dispatch: AgentDispatchDetail,
  input: DispatchResultInput,
) {
  const request = parseBrokerRequest(dispatch.payloadPreview.brokerRequest);
  if (!request) return;
  if ((input.status ?? 'completed') === 'completed') {
    const receiptId = input.providerDetail?.sourceReceiptId;
    if (typeof receiptId !== 'string' || !receiptId.trim()) {
      throw new ExternalAgentError(
        'Completed Scout results require providerDetail.sourceReceiptId',
        'VALIDATION_ERROR',
        422,
      );
    }
  }
}

export function paperclipScoutState(dispatch: AgentDispatchRecord | AgentDispatchDetail) {
  const state = dispatch.resultStatus === 'rejected'
    ? 'rejected'
    : dispatch.status === 'needs_confirmation' || dispatch.status === 'waiting_for_user'
      ? 'waiting-for-user'
      : dispatch.status === 'claimed' || dispatch.status === 'in_progress'
        ? 'queued'
      : dispatch.status === 'dead_letter'
        ? 'failed'
        : dispatch.status;
  return {
    requestId: parseBrokerRequest(dispatch.payloadPreview.brokerRequest)?.requestId ?? null,
    dispatchId: dispatch.id,
    state,
    previewHash: dispatch.previewHash,
    dataClassification: dispatch.dataClassification,
    disclosedFields: dispatch.disclosedFields,
    allowedActions: dispatch.allowedActions,
    result: dispatch.result,
    resultStatus: dispatch.resultStatus,
    errorMessage: dispatch.errorMessage,
    updatedAt: dispatch.updatedAt,
  };
}

export async function getPaperclipScoutDispatch(
  source: ExternalAgent,
  dispatchId: string,
) {
  const dispatch = await getDispatch(requiredText(dispatchId, 'dispatchId'));
  const request = dispatch
    ? parseBrokerRequest(dispatch.payloadPreview.brokerRequest)
    : null;
  if (!dispatch || request?.source.externalAgentId !== source.id) {
    throw new ExternalAgentError('Scout dispatch not found', 'NOT_FOUND', 404);
  }
  return paperclipScoutState(dispatch);
}
