export interface SavedAIProviderConfig {
  provider?: string;
  model?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  semanticSearchEnabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
}

export interface ResolvedAIConfig {
  provider: string;
  model: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingConfigured: boolean;
  semanticSearchEnabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  configured: boolean;
}

export const SENSITIVITY_CLASSES = ['local-only', 'restricted', 'standard'] as const;
export type SensitivityClass = (typeof SENSITIVITY_CLASSES)[number];

export const AI_ROUTE_IDS = ['ollama', 'azure-private', 'bifrost-copilot', 'openai'] as const;
export type AIRouteId = (typeof AI_ROUTE_IDS)[number];

export const AI_FEATURE_IDS = [
  'houston-chat',
  'smart-priority',
  'daily-digest',
  'notification-triage',
  'tag-inference',
  'project-assignment',
  'whats-next',
  'micro-status-suggestion',
  'energy-tag-suggestion',
  'ideation-expansion',
  'custom-agent',
  'goal-development',
  'day-planning',
  'project-phase-suggestion',
  'project-phase-refinement',
  'reset-summary',
  'task-breakdown',
  'document-intake',
  'notification-enrichment',
  'triage-action-extraction',
  'knowledge-base-extraction',
  'stats-observations',
  'semantic-embedding',
  'provider-health-check',
] as const;
export type AIFeatureId = (typeof AI_FEATURE_IDS)[number];

export interface AISensitivityPolicy {
  allowedRoutes: AIRouteId[];
}

export interface AIRoutingPolicyConfig {
  policies: Record<SensitivityClass, AISensitivityPolicy>;
  featureDefaults: Partial<Record<AIFeatureId, SensitivityClass>>;
  sourceDefaults: Record<string, SensitivityClass>;
}

export interface AIRequestContext {
  featureId: AIFeatureId;
  sensitivity: SensitivityClass;
  allowedRoutes: AIRouteId[];
  correlationId: string;
}

export interface AIRouteOutcome {
  provider: string;
  model: string;
  fallbackOccurred: boolean;
  context: AIRequestContext;
}
