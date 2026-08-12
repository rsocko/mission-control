import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import db from '@/db';
import {
  EXTERNAL_AGENT_AUTH_TYPES,
  EXTERNAL_AGENT_LOCALITIES,
  EXTERNAL_AGENT_TRANSPORTS,
  EXTERNAL_AGENT_TYPES,
  externalAgents,
  inboundWebhooks,
  type ExternalAgentAuthType,
  type ExternalAgentCapabilities,
  type ExternalAgentDataPolicy,
  type ExternalAgentLocality,
  type ExternalAgentTransport,
  type ExternalAgentType,
} from '@/db/schema';
import { ExternalAgentError } from './errors';
import {
  DEFAULT_EXTERNAL_AGENT_DATA_POLICY,
  validateDataPolicy,
} from './policy';

export type ExternalAgent = typeof externalAgents.$inferSelect;

export interface ExternalAgentInput {
  id?: string;
  name: string;
  type: ExternalAgentType;
  transport?: ExternalAgentTransport;
  executionLocality?: ExternalAgentLocality;
  description?: string | null;
  endpoint?: string | null;
  authType?: ExternalAgentAuthType;
  authCredentialRef?: string | null;
  capabilities?: ExternalAgentCapabilities;
  inputFormat?: string;
  outputFormat?: string;
  inboundWebhookId?: string | null;
  dataPolicy?: ExternalAgentDataPolicy;
  enabled?: boolean;
}

const TYPE_DEFAULTS: Record<
  ExternalAgentType,
  { transport: ExternalAgentTransport; locality: ExternalAgentLocality }
> = {
  'copilot-cloud': { transport: 'push', locality: 'github-hosted' },
  'copilot-sdk-workspace': { transport: 'pull', locality: 'mission-control-host' },
  'webhook-roundtrip': { transport: 'push', locality: 'external' },
  mcp: { transport: 'mcp', locality: 'external' },
  'pull-queue': { transport: 'pull', locality: 'external' },
  manual: { transport: 'manual', locality: 'external' },
  inference: { transport: 'push', locality: 'inference' },
};

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new ExternalAgentError(`${field} must be a string`, 'VALIDATION_ERROR', 422);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized;
}

function validateEndpoint(
  endpoint: string | null,
  transport: ExternalAgentTransport,
  authType: ExternalAgentAuthType,
) {
  if (transport === 'pull') return null;
  if (transport === 'manual' && !endpoint) return null;
  if (!endpoint) {
    throw new ExternalAgentError(
      `${transport} agents require an endpoint`,
      'VALIDATION_ERROR',
      422,
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ExternalAgentError('endpoint must be a valid URL', 'VALIDATION_ERROR', 422);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ExternalAgentError('endpoint must use HTTP or HTTPS', 'VALIDATION_ERROR', 422);
  }
  if (url.username || url.password) {
    throw new ExternalAgentError(
      'endpoint must not contain embedded credentials',
      'VALIDATION_ERROR',
      422,
    );
  }
  const local = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '::1'
    || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && (!local || authType !== 'none')) {
    throw new ExternalAgentError(
      'credentialed or non-local endpoints must use HTTPS',
      'VALIDATION_ERROR',
      422,
    );
  }
  return url.toString();
}

export function validateExternalAgentInput(input: ExternalAgentInput): Omit<
  typeof externalAgents.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
> {
  const name = optionalText(input.name, 'name');
  if (!name) throw new ExternalAgentError('name is required', 'VALIDATION_ERROR', 422);
  if (!includes(EXTERNAL_AGENT_TYPES, input.type)) {
    throw new ExternalAgentError('type is invalid', 'VALIDATION_ERROR', 422);
  }
  const defaults = TYPE_DEFAULTS[input.type];
  const transport = input.transport ?? defaults.transport;
  const executionLocality = input.executionLocality ?? defaults.locality;
  if (!includes(EXTERNAL_AGENT_TRANSPORTS, transport)) {
    throw new ExternalAgentError('transport is invalid', 'VALIDATION_ERROR', 422);
  }
  if (!includes(EXTERNAL_AGENT_LOCALITIES, executionLocality)) {
    throw new ExternalAgentError('executionLocality is invalid', 'VALIDATION_ERROR', 422);
  }
  if (transport !== defaults.transport || executionLocality !== defaults.locality) {
    throw new ExternalAgentError(
      `${input.type} requires ${defaults.transport} transport and ${defaults.locality} locality`,
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
  const authType = input.authType ?? 'none';
  if (!includes(EXTERNAL_AGENT_AUTH_TYPES, authType)) {
    throw new ExternalAgentError('authType is invalid', 'VALIDATION_ERROR', 422);
  }
  const credentialRef = optionalText(input.authCredentialRef, 'authCredentialRef');
  if (authType !== 'none' && !credentialRef) {
    throw new ExternalAgentError(
      'authCredentialRef is required for the selected authType',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (input.type === 'copilot-cloud' && authType !== 'github-user') {
    throw new ExternalAgentError(
      'copilot-cloud requires a GitHub user credential; installation credentials are unsupported',
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
  if (transport === 'pull' && authType === 'none') {
    throw new ExternalAgentError(
      'pull agents require scoped credentials',
      'VALIDATION_ERROR',
      422,
    );
  }
  const capabilities = input.capabilities ?? {};
  if (
    executionLocality === 'inference'
    && (
      capabilities.canAnalyzeCode
      || capabilities.canWriteCode
      || capabilities.canRunCommands
      || capabilities.canPush
      || capabilities.canCreatePullRequest
    )
  ) {
    throw new ExternalAgentError(
      'Inference agents cannot claim repository or command execution capabilities',
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
  return {
    name,
    type: input.type,
    transport,
    executionLocality,
    description: optionalText(input.description, 'description'),
    endpoint: validateEndpoint(optionalText(input.endpoint, 'endpoint'), transport, authType),
    authType,
    authCredentialRef: credentialRef,
    capabilities,
    inputFormat: optionalText(input.inputFormat, 'inputFormat') ?? 'mc-tasks',
    outputFormat: optionalText(input.outputFormat, 'outputFormat') ?? 'mc-tasks',
    inboundWebhookId: optionalText(input.inboundWebhookId, 'inboundWebhookId'),
    dataPolicy: validateDataPolicy(input.dataPolicy ?? DEFAULT_EXTERNAL_AGENT_DATA_POLICY),
    enabled: input.enabled ?? true,
    deletedAt: null,
  };
}

export function publicExternalAgent(agent: ExternalAgent) {
  const { authCredentialRef: _credentialRef, ...safe } = agent;
  void _credentialRef;
  return {
    ...safe,
    hasCredentialReference: Boolean(agent.authCredentialRef),
  };
}

async function validateInboundWebhookReference(
  inboundWebhookId: string | null | undefined,
) {
  if (!inboundWebhookId) return;
  const [webhook] = await db.select({
    enabled: inboundWebhooks.enabled,
    secret: inboundWebhooks.secret,
  }).from(inboundWebhooks).where(eq(inboundWebhooks.id, inboundWebhookId)).limit(1);
  if (!webhook) {
    throw new ExternalAgentError('Inbound webhook not found', 'VALIDATION_ERROR', 422);
  }
  if (!webhook.enabled || !webhook.secret) {
    throw new ExternalAgentError(
      'Agent result webhooks must be enabled and HMAC-protected',
      'VALIDATION_ERROR',
      422,
    );
  }
}

export async function listExternalAgents(options: { includeDeleted?: boolean } = {}) {
  const rows = await db.select().from(externalAgents)
    .where(options.includeDeleted ? undefined : isNull(externalAgents.deletedAt));
  return rows.map(publicExternalAgent);
}

export async function getExternalAgent(id: string, includeDeleted = false) {
  const [agent] = await db.select().from(externalAgents).where(
    includeDeleted
      ? eq(externalAgents.id, id)
      : and(eq(externalAgents.id, id), isNull(externalAgents.deletedAt)),
  ).limit(1);
  return agent ?? null;
}

export async function createExternalAgent(input: ExternalAgentInput) {
  const now = new Date().toISOString();
  const values = validateExternalAgentInput(input);
  await validateInboundWebhookReference(values.inboundWebhookId);
  const id = optionalText(input.id, 'id') ?? crypto.randomUUID();
  await db.insert(externalAgents).values({ ...values, id, createdAt: now, updatedAt: now });
  return (await getExternalAgent(id))!;
}

export async function updateExternalAgent(id: string, patch: Partial<ExternalAgentInput>) {
  const existing = await getExternalAgent(id);
  if (!existing) throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
  const values = validateExternalAgentInput({
    ...existing,
    ...patch,
    id,
    dataPolicy: patch.dataPolicy ?? existing.dataPolicy,
    capabilities: patch.capabilities ?? existing.capabilities,
  });
  await validateInboundWebhookReference(values.inboundWebhookId);
  await db.update(externalAgents)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(externalAgents.id, id));
  return (await getExternalAgent(id))!;
}

export async function deleteExternalAgent(id: string) {
  const existing = await getExternalAgent(id);
  if (!existing) throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
  const now = new Date().toISOString();
  await db.update(externalAgents)
    .set({ enabled: false, deletedAt: now, updatedAt: now })
    .where(eq(externalAgents.id, id));
}

export function resolveAgentCredential(reference: string | null): string | null {
  if (!reference) return null;
  let credentials: unknown;
  try {
    credentials = JSON.parse(process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON ?? '{}');
  } catch {
    throw new ExternalAgentError(
      'External-agent credential store is invalid',
      'CREDENTIAL_CONFIGURATION_ERROR',
      500,
    );
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new ExternalAgentError(
      'External-agent credential store is invalid',
      'CREDENTIAL_CONFIGURATION_ERROR',
      500,
    );
  }
  const value = (credentials as Record<string, unknown>)[reference];
  if (typeof value !== 'string' || !value) {
    throw new ExternalAgentError(
      'External-agent credential is unavailable',
      'CREDENTIAL_UNAVAILABLE',
      503,
    );
  }
  return value;
}
