import 'server-only';

import {
  EXTERNAL_AGENT_AUTH_TYPES,
  EXTERNAL_AGENT_LOCALITIES,
  EXTERNAL_AGENT_TRANSPORTS,
  EXTERNAL_AGENT_TYPES,
  type ExternalAgentAuthType,
  type ExternalAgentCapabilities,
  type ExternalAgentDataPolicy,
  type ExternalAgentProviderConfig,
  type ExternalAgentLocality,
  type ExternalAgentRecord,
  type ExternalAgentTransport,
  type ExternalAgentType,
  type PaperclipScoutCapability,
  type PaperclipScoutRisk,
} from './contracts';
import { ExternalAgentError } from './errors';
import { getExternalAgentControlPersistence } from './persistence';
import {
  DEFAULT_EXTERNAL_AGENT_DATA_POLICY,
  validateDataPolicy,
} from './policy';
import {
  validatePaperclipConnection,
  type PaperclipConnection,
} from './paperclip';

export type ExternalAgent = ExternalAgentRecord;

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
  providerConfig?: ExternalAgentProviderConfig;
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
  paperclip: { transport: 'push', locality: 'external' },
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

function requiredUuid(value: unknown, field: string): string {
  const normalized = optionalText(value, field);
  if (
    !normalized
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(normalized)
  ) {
    throw new ExternalAgentError(`${field} must be a UUID`, 'VALIDATION_ERROR', 422);
  }
  return normalized;
}

function requiredText(value: unknown, field: string, maxLength = 255): string {
  const normalized = optionalText(value, field);
  if (!normalized) {
    throw new ExternalAgentError(`${field} is required`, 'VALIDATION_ERROR', 422);
  }
  if (normalized.length > maxLength) {
    throw new ExternalAgentError(
      `${field} exceeds ${maxLength} characters`,
      'VALIDATION_ERROR',
      422,
    );
  }
  return normalized;
}

const PAPERCLIP_SCOUT_RISKS = new Set<PaperclipScoutRisk>([
  'low',
  'messaging',
  'destructive',
  'identity',
  'financial',
  'high',
]);

function validateScoutCapability(value: unknown, index: number): PaperclipScoutCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalAgentError(
      `providerConfig.paperclip.scoutBridge.capabilities[${index}] must be an object`,
      'VALIDATION_ERROR',
      422,
    );
  }
  const capability = value as Partial<PaperclipScoutCapability>;
  const actions = capability.actions;
  const inputFields = capability.inputFields;
  if (
    !Array.isArray(actions)
    || actions.length === 0
    || actions.length > 50
    || actions.some((action) => typeof action !== 'string' || !action.trim())
  ) {
    throw new ExternalAgentError(
      `providerConfig.paperclip.scoutBridge.capabilities[${index}].actions is invalid`,
      'VALIDATION_ERROR',
      422,
    );
  }
  if (
    !Array.isArray(inputFields)
    || inputFields.length > 100
    || inputFields.some((field) =>
      typeof field !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field))
  ) {
    throw new ExternalAgentError(
      `providerConfig.paperclip.scoutBridge.capabilities[${index}].inputFields is invalid`,
      'VALIDATION_ERROR',
      422,
    );
  }
  if (!capability.risk || !PAPERCLIP_SCOUT_RISKS.has(capability.risk)) {
    throw new ExternalAgentError(
      `providerConfig.paperclip.scoutBridge.capabilities[${index}].risk is invalid`,
      'VALIDATION_ERROR',
      422,
    );
  }
  return {
    tool: requiredText(
      capability.tool,
      `providerConfig.paperclip.scoutBridge.capabilities[${index}].tool`,
      120,
    ),
    actions: [...new Set(actions.map((action) => action.trim()))],
    inputFields: [...new Set(inputFields)],
    risk: capability.risk,
  };
}

function validateProviderConfig(
  type: ExternalAgentType,
  value: ExternalAgentProviderConfig | undefined,
): ExternalAgentProviderConfig {
  if (type !== 'paperclip') return {};
  const paperclip = value?.paperclip;
  if (!paperclip || typeof paperclip !== 'object' || Array.isArray(paperclip)) {
    throw new ExternalAgentError(
      'providerConfig.paperclip is required',
      'VALIDATION_ERROR',
      422,
    );
  }
  const requiredAdapterType = optionalText(
    paperclip.requiredAdapterType,
    'providerConfig.paperclip.requiredAdapterType',
  );
  const scoutBridge = paperclip.scoutBridge;
  let normalizedScoutBridge;
  if (scoutBridge !== undefined) {
    if (!scoutBridge || typeof scoutBridge !== 'object' || Array.isArray(scoutBridge)) {
      throw new ExternalAgentError(
        'providerConfig.paperclip.scoutBridge must be an object',
        'VALIDATION_ERROR',
        422,
      );
    }
    if (
      !Array.isArray(scoutBridge.capabilities)
      || scoutBridge.capabilities.length === 0
      || scoutBridge.capabilities.length > 100
    ) {
      throw new ExternalAgentError(
        'providerConfig.paperclip.scoutBridge.capabilities must contain 1-100 entries',
        'VALIDATION_ERROR',
        422,
      );
    }
    const capabilities = scoutBridge.capabilities.map(validateScoutCapability);
    const capabilityKeys = capabilities.flatMap((capability) =>
      capability.actions.map((action) => `${capability.tool}:${action}`));
    if (new Set(capabilityKeys).size !== capabilityKeys.length) {
      throw new ExternalAgentError(
        'providerConfig.paperclip.scoutBridge.capabilities contains duplicate tool actions',
        'VALIDATION_ERROR',
        422,
      );
    }
    const automation = scoutBridge.automation;
    let normalizedAutomation;
    if (automation !== undefined) {
      if (
        !automation
        || typeof automation !== 'object'
        || Array.isArray(automation)
        || typeof automation.enabled !== 'boolean'
        || !Array.isArray(automation.capabilities)
        || automation.capabilities.length > 100
      ) {
        throw new ExternalAgentError(
          'providerConfig.paperclip.scoutBridge.automation is invalid',
          'VALIDATION_ERROR',
          422,
        );
      }
      normalizedAutomation = {
        enabled: automation.enabled,
        capabilities: automation.capabilities.map((entry, index) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new ExternalAgentError(
              `providerConfig.paperclip.scoutBridge.automation.capabilities[${index}] is invalid`,
              'VALIDATION_ERROR',
              422,
            );
          }
          return {
            tool: requiredText(
              entry.tool,
              `providerConfig.paperclip.scoutBridge.automation.capabilities[${index}].tool`,
              120,
            ),
            action: requiredText(
              entry.action,
              `providerConfig.paperclip.scoutBridge.automation.capabilities[${index}].action`,
              120,
            ),
          };
        }),
      };
      const unknownAutomation = normalizedAutomation.capabilities.find((entry) =>
        !capabilities.some((capability) =>
          capability.tool === entry.tool && capability.actions.includes(entry.action)));
      if (unknownAutomation) {
        throw new ExternalAgentError(
          'providerConfig.paperclip.scoutBridge.automation contains an unauthorized tool action',
          'VALIDATION_ERROR',
          422,
        );
      }
    }
    normalizedScoutBridge = {
      destinationAgentId: requiredText(
        scoutBridge.destinationAgentId,
        'providerConfig.paperclip.scoutBridge.destinationAgentId',
      ),
      tenantId: requiredText(
        scoutBridge.tenantId,
        'providerConfig.paperclip.scoutBridge.tenantId',
      ),
      capabilities,
      ...(normalizedAutomation ? { automation: normalizedAutomation } : {}),
    };
  }
  return {
    paperclip: {
      companyId: requiredUuid(
        paperclip.companyId,
        'providerConfig.paperclip.companyId',
      ),
      assigneeAgentId: requiredUuid(
        paperclip.assigneeAgentId,
        'providerConfig.paperclip.assigneeAgentId',
      ),
      ...(paperclip.projectId
        ? {
          projectId: requiredUuid(
            paperclip.projectId,
            'providerConfig.paperclip.projectId',
          ),
        }
        : {}),
      ...(requiredAdapterType ? { requiredAdapterType } : {}),
      ...(normalizedScoutBridge ? { scoutBridge: normalizedScoutBridge } : {}),
    },
  };
}

function validateEndpoint(
  endpoint: string | null,
  transport: ExternalAgentTransport,
  authType: ExternalAgentAuthType,
  agentType: ExternalAgentType,
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
  if (
    agentType === 'copilot-cloud'
    && (
      url.protocol !== 'https:'
      || url.hostname.toLowerCase() !== 'api.github.com'
      || url.port
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash
    )
  ) {
    throw new ExternalAgentError(
      'copilot-cloud endpoint must be the official https://api.github.com API origin',
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
  if (
    agentType === 'paperclip'
    && (
      url.pathname !== '/'
      || url.search
      || url.hash
    )
  ) {
    throw new ExternalAgentError(
      'paperclip endpoint must be an API origin without a path, query, or fragment',
      'VALIDATION_ERROR',
      422,
    );
  }
  const local = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '::1'
    || url.hostname.endsWith('.localhost');
  if (agentType === 'paperclip' && authType === 'none' && !local) {
    throw new ExternalAgentError(
      'unauthenticated Paperclip endpoints must be local',
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
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
  ExternalAgentRecord,
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
  if (input.type === 'paperclip' && authType !== 'none' && authType !== 'bearer') {
    throw new ExternalAgentError(
      'paperclip supports bearer credentials or local-trusted access',
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
  const capabilities: ExternalAgentCapabilities = {
    ...(input.capabilities ?? {}),
  };
  if (
    capabilities.allowedActions !== undefined
    && (
      !Array.isArray(capabilities.allowedActions)
      || capabilities.allowedActions.length > 500
      || capabilities.allowedActions.some((action) =>
        typeof action !== 'string' || !action.trim() || action.length > 256)
    )
  ) {
    throw new ExternalAgentError(
      'capabilities.allowedActions is invalid',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (input.capabilities?.allowedActions) {
    capabilities.allowedActions = [
      ...new Set(input.capabilities.allowedActions.map((action) => action.trim())),
    ];
  }
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
    endpoint: validateEndpoint(
      optionalText(input.endpoint, 'endpoint'),
      transport,
      authType,
      input.type,
    ),
    authType,
    authCredentialRef: credentialRef,
    providerConfig: validateProviderConfig(input.type, input.providerConfig),
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

export async function listExternalAgents(options: { includeDeleted?: boolean } = {}) {
  const rows = await (await getExternalAgentControlPersistence()).registry.list(options);
  return rows.map(publicExternalAgent);
}

export async function getExternalAgent(id: string, includeDeleted = false) {
  return (await getExternalAgentControlPersistence()).registry.get(id, includeDeleted);
}

export async function createExternalAgent(input: ExternalAgentInput) {
  const now = new Date().toISOString();
  const values = validateExternalAgentInput(input);
  await validateProviderConnection(values);
  const id = optionalText(input.id, 'id') ?? crypto.randomUUID();
  return (await getExternalAgentControlPersistence()).registry.create({
    ...values,
    id,
    createdAt: now,
    updatedAt: now,
  });
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
  await validateProviderConnection(values);
  const updated = await (await getExternalAgentControlPersistence()).registry.update(id, {
    ...values,
    updatedAt: new Date().toISOString(),
  });
  if (!updated) throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
  return updated;
}

export async function deleteExternalAgent(id: string) {
  const existing = await getExternalAgent(id);
  if (!existing) throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
  await (await getExternalAgentControlPersistence()).registry.softDelete(
    id,
    new Date().toISOString(),
  );
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

async function validateProviderConnection(
  values: Omit<ExternalAgentRecord, 'id' | 'createdAt' | 'updatedAt'>,
) {
  if (values.type !== 'paperclip') return;
  const config = values.providerConfig.paperclip;
  if (!values.endpoint || !config) {
    throw new ExternalAgentError(
      'Paperclip endpoint and provider configuration are required',
      'VALIDATION_ERROR',
      422,
    );
  }
  const connection: PaperclipConnection = {
    endpoint: values.endpoint,
    credential: resolveAgentCredential(values.authCredentialRef),
    config,
  };
  await validatePaperclipConnection(connection);
}
