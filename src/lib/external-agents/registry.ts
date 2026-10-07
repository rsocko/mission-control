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
} from './contracts';
import { ExternalAgentError } from './errors';
import { getExternalAgentControlPersistence } from './persistence';
import {
  DEFAULT_EXTERNAL_AGENT_DATA_POLICY,
  normalizeExternalAgentDataPolicy,
  validateDataPolicy,
} from './policy';
import {
  discoverPaperclip,
  validatePaperclipConnection,
  type PaperclipConnection,
} from './paperclip';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

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
  credential?: string | null;
  providerConfig?: ExternalAgentProviderConfig;
  capabilities?: ExternalAgentCapabilities;
  inputFormat?: string;
  outputFormat?: string;
  inboundWebhookId?: string | null;
  dataPolicy?: Partial<ExternalAgentDataPolicy>;
  enabled?: boolean;
}

export interface PaperclipDiscoveryInput {
  endpoint?: string;
  credential?: string | null;
  authCredentialRef?: string | null;
  connectorId?: string | null;
  destinationId?: string | null;
  companyId?: string | null;
}

const MANAGED_GITHUB_CREDENTIAL = 'mission-control:github-user';
const MANAGED_AGENT_CREDENTIAL = 'mission-control:external-agent';
const PAPERCLIP_CONNECTOR_CREDENTIAL_PREFIX = 'paperclip-connector:';
export const MAX_ALWAYS_INSTRUCTIONS_LENGTH = 16_000;

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

function validateProviderConfig(
  type: ExternalAgentType,
  value: ExternalAgentProviderConfig | undefined,
): ExternalAgentProviderConfig {
  const alwaysInstructions = optionalText(
    value?.alwaysInstructions,
    'providerConfig.alwaysInstructions',
  );
  if (
    alwaysInstructions
    && alwaysInstructions.length > MAX_ALWAYS_INSTRUCTIONS_LENGTH
  ) {
    throw new ExternalAgentError(
      `providerConfig.alwaysInstructions exceeds ${MAX_ALWAYS_INSTRUCTIONS_LENGTH} characters`,
      'VALIDATION_ERROR',
      422,
    );
  }
  const common = alwaysInstructions ? { alwaysInstructions } : {};
  if (type === 'pull-queue' && value?.scout) {
    const scout = value.scout;
    if (
      !scout.connectorId
      || !scout.protocolVersion
      || !scout.skillVersion
      || !scout.onboarding
      || !scout.connectivity
    ) {
      throw new ExternalAgentError(
        'providerConfig.scout is incomplete',
        'VALIDATION_ERROR',
        422,
      );
    }
    return { ...common, scout };
  }
  if (type !== 'paperclip') return common;
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
  return {
    ...common,
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
    dataPolicy: normalizeExternalAgentDataPolicy(
      input.type,
      validateDataPolicy({
        ...DEFAULT_EXTERNAL_AGENT_DATA_POLICY,
        ...input.dataPolicy,
      }),
    ),
    enabled: input.enabled ?? true,
    deletedAt: null,
  };
}

export function publicExternalAgent(agent: ExternalAgent) {
  const { authCredentialRef: _credentialRef, ...safe } = agent;
  const scout = agent.providerConfig.scout;
  let publicScout: typeof scout = undefined;
  if (scout) {
    const {
      registrationTokenHash: _registrationTokenHash,
      claimTokenHash: _claimTokenHash,
      ...publicOnboarding
    } = scout.onboarding;
    void _registrationTokenHash;
    void _claimTokenHash;
    publicScout = { ...scout, onboarding: publicOnboarding };
  }
  void _credentialRef;
  return {
    ...safe,
    providerConfig: publicScout
      ? {
        ...agent.providerConfig,
        scout: publicScout,
      }
      : agent.providerConfig,
    hasCredentialReference: Boolean(agent.authCredentialRef),
    credentialSource: isPaperclipConnectorCredentialReference(agent.authCredentialRef)
      ? 'paperclip-connector'
      : (
        agent.authCredentialRef === MANAGED_GITHUB_CREDENTIAL
        || agent.authCredentialRef === MANAGED_AGENT_CREDENTIAL
      )
        ? 'mission-control'
        : 'deployment-secret',
    paperclipConnectorId: paperclipConnectorId(agent.authCredentialRef),
  };
}

async function upgradePersistedDataPolicy(
  agent: ExternalAgent | null,
): Promise<ExternalAgent | null> {
  if (!agent || agent.deletedAt) return agent;
  const dataPolicy = normalizeExternalAgentDataPolicy(agent.type, agent.dataPolicy);
  if (dataPolicy === agent.dataPolicy) return agent;
  return (await getExternalAgentControlPersistence()).registry.update(agent.id, {
    ...agent,
    dataPolicy,
    updatedAt: new Date().toISOString(),
  });
}

export async function listExternalAgents(options: { includeDeleted?: boolean } = {}) {
  const persistence = await getExternalAgentControlPersistence();
  const rows = await persistence.registry.list(options);
  const upgraded = await Promise.all(rows.map(upgradePersistedDataPolicy));
  return upgraded.filter((agent): agent is ExternalAgent => Boolean(agent)).map(publicExternalAgent);
}

export async function getExternalAgent(id: string, includeDeleted = false) {
  return upgradePersistedDataPolicy(
    await (await getExternalAgentControlPersistence()).registry.get(id, includeDeleted),
  );
}

export async function createExternalAgent(input: ExternalAgentInput) {
  const now = new Date().toISOString();
  const id = optionalText(input.id, 'id') ?? crypto.randomUUID();
  const credential = managedCredential(input, input.type);
  const values = validateExternalAgentInput({
    ...input,
    ...(credential ? { authCredentialRef: managedCredentialReference(input.type) } : {}),
  });
  await validateProviderConnection(values, credential);
  return (await getExternalAgentControlPersistence()).registry.create({
    ...values,
    id,
    createdAt: now,
    updatedAt: now,
  }, credential);
}

export async function updateExternalAgent(
  id: string,
  patch: Partial<ExternalAgentInput>,
  options: { expectedScoutOnboardingStatus?: string } = {},
) {
  const existing = await getExternalAgent(id);
  if (!existing) throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
  const credential = managedCredential(patch, patch.type ?? existing.type);
  const type = patch.type ?? existing.type;
  const values = validateExternalAgentInput({
    ...existing,
    ...patch,
    ...(credential ? { authCredentialRef: managedCredentialReference(type) } : {}),
    id,
    dataPolicy: patch.dataPolicy
      ? { ...existing.dataPolicy, ...patch.dataPolicy }
      : existing.dataPolicy,
    capabilities: patch.capabilities ?? existing.capabilities,
  });
  const connectionChanged = (
    'type' in patch
    || 'endpoint' in patch
    || 'authType' in patch
    || 'authCredentialRef' in patch
    || 'credential' in patch
    || 'providerConfig' in patch
  );
  const retainedManagedCredential = !credential
    && isManagedCredentialReference(existing.authCredentialRef)
    ? await (await getExternalAgentControlPersistence()).registry.getCredential(existing.id)
    : null;
  if (values.enabled || connectionChanged) {
    await validateProviderConnection(values, credential ?? retainedManagedCredential);
  }
  const credentialUpdate = credential
    ?? (
      isManagedCredentialReference(existing.authCredentialRef)
      && !isManagedCredentialReference(values.authCredentialRef)
        ? null
        : undefined
    );
  const updated = await (await getExternalAgentControlPersistence()).registry.update(id, {
    ...values,
    updatedAt: new Date().toISOString(),
  }, credentialUpdate, options.expectedScoutOnboardingStatus);
  if (!updated) {
    if (options.expectedScoutOnboardingStatus) {
      throw new ExternalAgentError(
        'Scout onboarding state changed concurrently',
        'INVALID_TRANSITION',
        409,
      );
    }
    throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
  }
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

export async function resolveExternalAgentCredential(
  agent: ExternalAgent,
): Promise<string | null> {
  if (isManagedCredentialReference(agent.authCredentialRef)) {
    return (await getExternalAgentControlPersistence()).registry.getCredential(agent.id);
  }
  if (isPaperclipConnectorCredentialReference(agent.authCredentialRef)) {
    return resolvePaperclipConnectorCredential(
      agent.authCredentialRef,
      agent.endpoint,
    );
  }
  return resolveAgentCredential(agent.authCredentialRef);
}

export async function discoverPaperclipSetup(input: PaperclipDiscoveryInput) {
  const destinationId = optionalText(input.destinationId, 'destinationId');
  const existing = destinationId ? await getExternalAgent(destinationId) : null;
  if (destinationId && (!existing || existing.type !== 'paperclip')) {
    throw new ExternalAgentError('Paperclip destination not found', 'NOT_FOUND', 404);
  }
  const endpointInput = optionalText(input.endpoint, 'endpoint') ?? existing?.endpoint;
  const directCredential = optionalText(input.credential, 'credential');
  const connectorId = optionalText(input.connectorId, 'connectorId');
  const credentialRef = connectorId
    ? `${PAPERCLIP_CONNECTOR_CREDENTIAL_PREFIX}${connectorId}`
    : optionalText(input.authCredentialRef, 'authCredentialRef');
  let credential = directCredential;
  if (!credential && credentialRef) {
    credential = isPaperclipConnectorCredentialReference(credentialRef)
      ? await resolvePaperclipConnectorCredential(credentialRef, endpointInput)
      : resolveAgentCredential(credentialRef);
  }
  if (!credential && existing) {
    if (endpointInput !== existing.endpoint) {
      throw new ExternalAgentError(
        'Enter the credential again after changing the Paperclip URL',
        'CREDENTIAL_UNAVAILABLE',
        422,
      );
    }
    credential = await resolveExternalAgentCredential(existing);
  }
  const endpoint = validateEndpoint(
    endpointInput ?? null,
    'push',
    credential ? 'bearer' : 'none',
    'paperclip',
  );
  if (!endpoint) {
    throw new ExternalAgentError('Paperclip endpoint is required', 'VALIDATION_ERROR', 422);
  }
  return discoverPaperclip(
    { endpoint, credential },
    optionalText(input.companyId, 'companyId') ?? undefined,
  );
}

export async function resolveGitHubAgentCredential(agent: ExternalAgent): Promise<string> {
  if (agent.type !== 'copilot-cloud') {
    throw new ExternalAgentError(
      'Managed GitHub credentials are only available to GitHub Copilot Cloud destinations',
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
  if (agent.authCredentialRef === MANAGED_GITHUB_CREDENTIAL) {
    const credential = await (
      await getExternalAgentControlPersistence()
    ).registry.getCredential(agent.id);
    if (!credential) {
      throw new ExternalAgentError(
        'GitHub Copilot Cloud token is unavailable. Add it again in AI & Agents settings.',
        'CREDENTIAL_UNAVAILABLE',
        503,
      );
    }
    return credential;
  }
  const credential = resolveAgentCredential(agent.authCredentialRef);
  if (!credential) {
    throw new ExternalAgentError(
      'GitHub user credential is unavailable',
      'CREDENTIAL_UNAVAILABLE',
      503,
    );
  }
  return credential;
}

function managedCredential(
  input: Partial<ExternalAgentInput>,
  type: ExternalAgentType,
): string | null {
  const credential = optionalText(input.credential, 'credential');
  if (
    credential
    && type !== 'copilot-cloud'
    && type !== 'paperclip'
    && type !== 'pull-queue'
  ) {
    throw new ExternalAgentError(
      'Direct credentials are only supported for GitHub Copilot Cloud, Paperclip, and pull-queue destinations',
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
  return credential;
}

function managedCredentialReference(type: ExternalAgentType) {
  return type === 'copilot-cloud'
    ? MANAGED_GITHUB_CREDENTIAL
    : MANAGED_AGENT_CREDENTIAL;
}

function isManagedCredentialReference(reference: string | null) {
  return reference === MANAGED_GITHUB_CREDENTIAL
    || reference === MANAGED_AGENT_CREDENTIAL;
}

function paperclipConnectorId(reference: string | null): string | null {
  if (!reference?.startsWith(PAPERCLIP_CONNECTOR_CREDENTIAL_PREFIX)) return null;
  return reference.slice(PAPERCLIP_CONNECTOR_CREDENTIAL_PREFIX.length) || null;
}

function isPaperclipConnectorCredentialReference(
  reference: string | null,
): reference is string {
  return paperclipConnectorId(reference) !== null;
}

async function resolvePaperclipConnectorCredential(
  reference: string,
  expectedEndpoint?: string | null,
): Promise<string> {
  const connectorId = paperclipConnectorId(reference);
  if (!connectorId) {
    throw new ExternalAgentError(
      'Paperclip connector credential reference is invalid',
      'CREDENTIAL_UNAVAILABLE',
      422,
    );
  }
  const connector = await (
    await getConnectorManagementPersistence()
  ).getConnector(connectorId);
  if (
    !connector
    || connector.deletedAt
    || connector.type !== 'paperclip'
    || !connector.enabled
  ) {
    throw new ExternalAgentError(
      'The selected Paperclip connector is unavailable',
      'CREDENTIAL_UNAVAILABLE',
      503,
    );
  }
  const connectorOrigin = typeof connector.settings.apiOrigin === 'string'
    ? connector.settings.apiOrigin
    : null;
  if (
    expectedEndpoint
    && connectorOrigin
    && new URL(expectedEndpoint).origin !== new URL(connectorOrigin).origin
  ) {
    throw new ExternalAgentError(
      'The selected Paperclip connector belongs to a different Paperclip server',
      'CREDENTIAL_UNAVAILABLE',
      422,
    );
  }
  const apiToken = connector.credentials.apiToken;
  if (typeof apiToken !== 'string' || !apiToken.trim()) {
    throw new ExternalAgentError(
      'The selected Paperclip connector credential is unavailable',
      'CREDENTIAL_UNAVAILABLE',
      503,
    );
  }
  return apiToken;
}

async function validateProviderConnection(
  values: Omit<ExternalAgentRecord, 'id' | 'createdAt' | 'updatedAt'>,
  managedCredentialValue: string | null = null,
) {
  if (values.type === 'copilot-cloud' && managedCredentialValue) {
    let response: Response;
    try {
      response = await fetch(new URL('/user', values.endpoint ?? 'https://api.github.com'), {
        headers: {
          Authorization: `Bearer ${managedCredentialValue}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      });
    } catch {
      throw new ExternalAgentError(
        'GitHub could not be reached to validate this token',
        'PROVIDER_UNAVAILABLE',
        503,
      );
    }
    if (!response.ok) {
      throw new ExternalAgentError(
        response.status === 401
          ? 'GitHub rejected this personal access token'
          : `GitHub token validation failed (${response.status})`,
        response.status === 401 ? 'CREDENTIAL_INVALID' : 'PROVIDER_UNAVAILABLE',
        response.status === 401 ? 401 : 502,
      );
    }
    return;
  }
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
    credential: managedCredentialValue ?? (
      isPaperclipConnectorCredentialReference(values.authCredentialRef)
        ? await resolvePaperclipConnectorCredential(values.authCredentialRef, values.endpoint)
        : resolveAgentCredential(values.authCredentialRef)
    ),
    config,
  };
  await validatePaperclipConnection(connection);
}
