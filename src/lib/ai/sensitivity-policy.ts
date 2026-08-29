import type {
  AIFeatureId,
  AIRequestContext,
  AIRouteId,
  AIRouteOutcome,
  AIRoutingPolicyConfig,
  SensitivityClass,
} from './types';
import { AI_FEATURE_IDS, AI_ROUTE_IDS, SENSITIVITY_CLASSES } from './types';

const SENSITIVITY_RANK: Record<SensitivityClass, number> = {
  standard: 0,
  restricted: 1,
  'local-only': 2,
};

export const AI_FEATURE_DEFAULTS: Record<AIFeatureId, SensitivityClass> = {
  'houston-chat': 'restricted',
  'smart-priority': 'standard',
  'daily-digest': 'restricted',
  'notification-triage': 'restricted',
  'tag-inference': 'standard',
  'project-assignment': 'standard',
  'whats-next': 'standard',
  'micro-status-suggestion': 'standard',
  'energy-tag-suggestion': 'standard',
  'ideation-expansion': 'standard',
  'custom-agent': 'restricted',
  'goal-development': 'standard',
  'day-planning': 'restricted',
  'project-phase-suggestion': 'standard',
  'project-phase-refinement': 'standard',
  'reset-summary': 'restricted',
  'task-breakdown': 'standard',
  'document-intake': 'restricted',
  'notification-enrichment': 'restricted',
  'triage-action-extraction': 'restricted',
  'knowledge-base-extraction': 'restricted',
  'stats-observations': 'standard',
  'semantic-embedding': 'restricted',
  'provider-health-check': 'standard',
};

export const DEFAULT_AI_ROUTING_POLICY: AIRoutingPolicyConfig = {
  policies: {
    'local-only': { allowedRoutes: ['ollama'] },
    restricted: { allowedRoutes: ['ollama', 'azure-private'] },
    standard: { allowedRoutes: ['bifrost-copilot', 'ollama', 'azure-private', 'openai'] },
  },
  featureDefaults: {},
  sourceDefaults: {
    'document-intelligence': 'restricted',
    finance: 'restricted',
    'finance-manager': 'restricted',
    'monarch-money': 'restricted',
    'outlook-calendar': 'restricted',
    'outlook-email': 'restricted',
    rymessage: 'restricted',
    'custom-rest': 'restricted',
    'home-assistant': 'restricted',
    scout: 'restricted',
    'microsoft-todo': 'standard',
    'github-issues': 'standard',
  },
};

const CLASS_ALLOWED_ROUTES: Record<SensitivityClass, ReadonlySet<AIRouteId>> = {
  'local-only': new Set(['ollama']),
  restricted: new Set(['ollama', 'azure-private']),
  standard: new Set(AI_ROUTE_IDS),
};

export class AIRoutingPolicyValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid AI routing policy: ${issues.join('; ')}`);
    this.name = 'AIRoutingPolicyValidationError';
  }
}

export class AISensitivityOverrideError extends Error {
  constructor(base: SensitivityClass, override: SensitivityClass) {
    super(`Sensitivity override cannot relax ${base} to ${override}`);
    this.name = 'AISensitivityOverrideError';
  }
}

export class AIRoutingDeniedError extends Error {
  constructor(provider: string, context: AIRequestContext) {
    super(
      `Provider "${provider}" is not allowed for ${context.sensitivity} requests (${context.featureId})`,
    );
    this.name = 'AIRoutingDeniedError';
  }
}

export class AIProviderEndpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIProviderEndpointValidationError';
  }
}

export function validateAIRoutingPolicy(value: unknown): AIRoutingPolicyConfig {
  const issues: string[] = [];
  if (!value || typeof value !== 'object') {
    throw new AIRoutingPolicyValidationError(['policy must be an object']);
  }

  const input = value as Partial<AIRoutingPolicyConfig>;
  const policies = {} as AIRoutingPolicyConfig['policies'];

  for (const sensitivity of SENSITIVITY_CLASSES) {
    const routes = input.policies?.[sensitivity]?.allowedRoutes;
    if (!Array.isArray(routes) || routes.length === 0) {
      issues.push(`${sensitivity} must include at least one route`);
      continue;
    }

    const uniqueRoutes = [...new Set(routes)];
    if (uniqueRoutes.length !== routes.length) {
      issues.push(`${sensitivity} contains duplicate routes`);
    }
    for (const route of uniqueRoutes) {
      if (!AI_ROUTE_IDS.includes(route)) {
        issues.push(`${sensitivity} contains unknown route "${String(route)}"`);
      } else if (!CLASS_ALLOWED_ROUTES[sensitivity].has(route)) {
        issues.push(`${route} is not permitted for ${sensitivity}`);
      }
    }
    policies[sensitivity] = { allowedRoutes: uniqueRoutes };
  }

  const featureDefaults: AIRoutingPolicyConfig['featureDefaults'] = {};
  for (const [featureId, sensitivity] of Object.entries(input.featureDefaults ?? {})) {
    if (!AI_FEATURE_IDS.includes(featureId as AIFeatureId)) {
      issues.push(`unknown feature "${featureId}"`);
    } else if (!SENSITIVITY_CLASSES.includes(sensitivity as SensitivityClass)) {
      issues.push(`invalid sensitivity for feature "${featureId}"`);
    } else if (
      SENSITIVITY_RANK[sensitivity as SensitivityClass]
      < SENSITIVITY_RANK[AI_FEATURE_DEFAULTS[featureId as AIFeatureId]]
    ) {
      issues.push(`feature "${featureId}" cannot be less restrictive than its built-in default`);
    } else {
      featureDefaults[featureId as AIFeatureId] = sensitivity as SensitivityClass;
    }
  }

  const sourceDefaults: Record<string, SensitivityClass> = {};
  for (const [source, sensitivity] of Object.entries(input.sourceDefaults ?? {})) {
    const normalizedSource = source.trim().toLowerCase();
    if (!normalizedSource) {
      issues.push('source names cannot be empty');
    } else if (!SENSITIVITY_CLASSES.includes(sensitivity as SensitivityClass)) {
      issues.push(`invalid sensitivity for source "${source}"`);
    } else {
      const builtIn = DEFAULT_AI_ROUTING_POLICY.sourceDefaults[normalizedSource] ?? 'restricted';
      if (
        builtIn
        && SENSITIVITY_RANK[sensitivity as SensitivityClass] < SENSITIVITY_RANK[builtIn]
      ) {
        issues.push(`source "${source}" cannot be less restrictive than its built-in default`);
      } else {
        sourceDefaults[normalizedSource] = sensitivity as SensitivityClass;
      }
    }
  }

  if (issues.length > 0) {
    throw new AIRoutingPolicyValidationError(issues);
  }

  return { policies, featureDefaults, sourceDefaults };
}

export function resolveSensitivity(
  featureId: AIFeatureId,
  policy: AIRoutingPolicyConfig,
  options: { sources?: string[]; override?: SensitivityClass } = {},
): SensitivityClass {
  const featureDefault = policy.featureDefaults[featureId] ?? AI_FEATURE_DEFAULTS[featureId];
  const sourceClasses = (options.sources ?? [])
    .map((source) => policy.sourceDefaults[source.trim().toLowerCase()] ?? 'restricted');
  const base = [featureDefault, ...sourceClasses]
    .reduce<SensitivityClass>(
      (mostRestrictive, candidate) =>
        SENSITIVITY_RANK[candidate] > SENSITIVITY_RANK[mostRestrictive] ? candidate : mostRestrictive,
      'standard',
    );

  if (!options.override) {
    return base;
  }
  if (SENSITIVITY_RANK[options.override] < SENSITIVITY_RANK[base]) {
    throw new AISensitivityOverrideError(base, options.override);
  }
  return options.override;
}

export function createAIRequestContext(
  featureId: AIFeatureId,
  policy: AIRoutingPolicyConfig,
  options: {
    sources?: string[];
    override?: SensitivityClass;
    correlationId: string;
  },
): AIRequestContext {
  const sensitivity = resolveSensitivity(featureId, policy, options);
  return {
    featureId,
    sensitivity,
    allowedRoutes: [...policy.policies[sensitivity].allowedRoutes],
    correlationId: options.correlationId,
  };
}

export function routeIdForProvider(provider: string): AIRouteId | null {
  switch (provider) {
    case 'ollama':
      return 'ollama';
    case 'azure':
    case 'azure-openai':
      return 'azure-private';
    case 'openai':
      return 'openai';
    case 'copilot':
    case 'github-copilot':
      return 'bifrost-copilot';
    default:
      return null;
  }
}

export function parseBifrostModelId(model: string) {
  const separatorIndex = model.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    return null;
  }

  const provider = model.slice(0, separatorIndex).trim().toLowerCase();
  const providerModel = model.slice(separatorIndex + 1).trim();
  const route = routeIdForProvider(provider);
  return route && providerModel ? { provider, model: providerModel, route } : null;
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost'
    || normalized === '::1'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || !normalized.includes('.')
  ) {
    return true;
  }

  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function parseProviderUrl(provider: string, baseUrl?: string) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AIProviderEndpointValidationError(`${provider} endpoint must use HTTP or HTTPS`);
    }
    if (url.username || url.password) {
      throw new AIProviderEndpointValidationError(
        `${provider} endpoint must not contain embedded credentials`,
      );
    }
    return url;
  } catch (error) {
    if (error instanceof AIProviderEndpointValidationError) throw error;
    throw new AIProviderEndpointValidationError(`${provider} endpoint is not a valid URL`);
  }
}

function configuredHosts(variable: string | undefined) {
  return (variable ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

export function validateProviderEndpoint(
  provider: string,
  baseUrl?: string,
  hasCredentials = false,
) {
  if (!baseUrl && (provider === 'azure' || provider === 'bifrost')) {
    throw new AIProviderEndpointValidationError(`${provider} requires an explicit endpoint`);
  }
  const url = parseProviderUrl(provider, baseUrl);
  if (!url) return;
  if (hasCredentials && provider !== 'ollama' && url.protocol !== 'https:') {
    throw new AIProviderEndpointValidationError(
      `${provider} endpoint must use HTTPS when credentials are configured`,
    );
  }

  if (provider === 'ollama') {
    if (!isLocalHostname(url.hostname)) {
      throw new AIProviderEndpointValidationError('Ollama endpoint must resolve to a local or private host');
    }
    return;
  }

  if (provider === 'azure') {
    const approvedHosts = [
      ...configuredHosts(process.env.AZURE_OPENAI_ENDPOINT),
      ...configuredHosts(process.env.AI_APPROVED_AZURE_HOSTS),
    ];
    const hostname = url.hostname.toLowerCase();
    const isAzureHost = approvedHosts.includes(hostname);
    if (url.protocol !== 'https:' || !isAzureHost) {
      throw new AIProviderEndpointValidationError(
        'Azure endpoint must use HTTPS and an approved Azure AI hostname',
      );
    }
    return;
  }

  if (provider === 'bifrost') {
    const approvedHosts = [
      ...configuredHosts(process.env.BIFROST_BASE_URL),
      ...configuredHosts(process.env.AI_APPROVED_BIFROST_HOSTS),
    ];
    if (!approvedHosts.includes(url.hostname.toLowerCase())) {
      throw new AIProviderEndpointValidationError(
        'Bifrost endpoint must use an explicitly approved hostname',
      );
    }
  }

  if (provider === 'openai') {
    const approvedHosts = [
      'api.openai.com',
      ...configuredHosts(process.env.AI_APPROVED_OPENAI_HOSTS),
    ];
    if (!approvedHosts.includes(url.hostname.toLowerCase())) {
      throw new AIProviderEndpointValidationError(
        'OpenAI endpoint must use the official API or an explicitly approved hostname',
      );
    }
  }

  if ((provider === 'openai' || provider === 'bifrost') && url.protocol !== 'https:') {
    throw new AIProviderEndpointValidationError(
      `${provider} endpoint must use HTTPS`,
    );
  }
}

export function assertAIProviderCanReceive(
  context: AIRequestContext,
  provider: string,
  route: AIRouteId | null,
) {
  if (provider === 'bifrost' && context.sensitivity === 'local-only') {
    throw new AIRoutingDeniedError(provider, context);
  }
  if (!route || !context.allowedRoutes.includes(route)) {
    throw new AIRoutingDeniedError(provider, context);
  }
}

export function routeIdForConfiguredProvider(
  provider: string,
  baseUrl?: string,
  hasCredentials = false,
  model?: string,
): AIRouteId | null {
  validateProviderEndpoint(provider, baseUrl, hasCredentials);
  if (provider === 'bifrost') {
    return model ? parseBifrostModelId(model)?.route ?? null : null;
  }
  return routeIdForProvider(provider);
}

export interface BifrostRoutingMetadata {
  provider?: string;
  model?: string;
  fallbackOccurred?: boolean;
}

export function extractBifrostRoutingMetadata(payload: unknown): BifrostRoutingMetadata | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  const extraFields = (payload as { extra_fields?: unknown }).extra_fields;
  if (!extraFields || typeof extraFields !== 'object') return undefined;

  const routingInfo = (extraFields as { routing_info?: unknown }).routing_info;
  const routing = routingInfo && typeof routingInfo === 'object'
    ? routingInfo as Record<string, unknown>
    : {};
  const provider = typeof routing.provider === 'string'
    ? routing.provider
    : typeof (extraFields as Record<string, unknown>).provider === 'string'
      ? (extraFields as Record<string, string>).provider
      : undefined;
  const model = typeof routing.model === 'string'
    ? routing.model
    : typeof (extraFields as Record<string, unknown>).resolved_model_used === 'string'
      ? (extraFields as Record<string, string>).resolved_model_used
      : undefined;
  const fallbackOccurred = typeof routing.fallback_index === 'number'
    ? routing.fallback_index > 0
    : undefined;

  return provider || model || fallbackOccurred !== undefined
    ? { provider, model, fallbackOccurred }
    : undefined;
}

export function resolveAIRouteOutcome(
  context: AIRequestContext,
  configuredProvider: string,
  configuredModel: string,
  headers?: Record<string, string>,
  metadata?: BifrostRoutingMetadata,
): AIRouteOutcome {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const configuredBifrostRoute = configuredProvider === 'bifrost'
    ? parseBifrostModelId(configuredModel)
    : null;
  const provider = configuredProvider === 'bifrost'
    ? metadata?.provider
      || normalizedHeaders['x-bifrost-provider']
      || configuredBifrostRoute?.provider
      || configuredProvider
    : configuredProvider;
  const model = configuredProvider === 'bifrost'
    ? metadata?.model
      || normalizedHeaders['x-bifrost-model']
      || configuredBifrostRoute?.model
      || configuredModel
    : configuredModel;
  const actualRoute = routeIdForProvider(provider);

  if (configuredProvider === 'bifrost' && (
    !actualRoute
    || provider === 'bifrost'
  )) {
    throw new AIRoutingDeniedError(provider, context);
  }
  if (!actualRoute || !context.allowedRoutes.includes(actualRoute)) {
    throw new AIRoutingDeniedError(provider, context);
  }

  const fallbackHeader = normalizedHeaders['x-bifrost-fallback'];
  const fallbackOccurred = metadata?.fallbackOccurred ?? fallbackHeader === 'true';

  return { provider, model, fallbackOccurred, context };
}
