import db from '@/db';
import { appSettings } from '@/db/schema';
import {
  getAIRequestContext,
  getAIRouteOutcome,
  getAIRoutingHeaders,
  getProviderInfo,
} from '@/lib/ai/provider-factory';
import {
  getAIRoutingPolicy,
  getResolvedAIConfig,
  invalidateAIConfigCache,
} from '@/lib/ai/config-resolver';
import {
  AIProviderEndpointValidationError,
  AIRoutingPolicyValidationError,
  extractBifrostRoutingMetadata,
  parseBifrostModelId,
  validateProviderEndpoint,
  validateAIRoutingPolicy,
} from '@/lib/ai/sensitivity-policy';
import { ApiErrors } from '@/lib/api-error';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const PROVIDER_SETTINGS_KEY = 'ai_provider_config';
const ROUTING_POLICY_SETTINGS_KEY = 'ai_routing_policy';
const REDACTED_API_KEY = '********';

const providerConfigSchema = z.object({
  provider: z.enum(['openai', 'azure', 'ollama', 'bifrost']).default('openai'),
  model: z.string().trim().min(1, 'Model is required').max(200),
  embeddingModel: z.string().trim().max(200).default(''),
  semanticSearchEnabled: z.boolean().default(false),
  baseUrl: z.union([z.literal(''), z.url()]).default(''),
  apiKey: z.string().max(10_000).optional(),
  routingPolicy: z.unknown().optional(),
}).superRefine((config, context) => {
  if (config.provider === 'bifrost' && !parseBifrostModelId(config.model)) {
    context.addIssue({
      code: 'custom',
      path: ['model'],
      message: 'Bifrost model must include a supported provider prefix, such as azure/gpt-4o-mini',
    });
  }
  if (
    config.provider === 'bifrost'
    && config.embeddingModel
    && !parseBifrostModelId(config.embeddingModel)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['embeddingModel'],
      message: 'Bifrost embedding model must include a supported provider prefix, such as ollama/nomic-embed-text:latest',
    });
  }
});

async function loadSavedProviderConfig() {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, PROVIDER_SETTINGS_KEY))
    .limit(1);
  return row?.value && typeof row.value === 'object'
    ? row.value as {
        provider?: string;
        model?: string;
        embeddingModel?: string;
        semanticSearchEnabled?: boolean;
        baseUrl?: string;
        apiKey?: string;
      }
    : {};
}

function getOperationalStatus() {
  const resolved = getResolvedAIConfig();
  const bifrostRoute = resolved.provider === 'bifrost'
    ? parseBifrostModelId(resolved.model)?.route
    : undefined;
  const routeNames = new Set(
    Object.values(getAIRoutingPolicy().policies)
      .flatMap((policy) => policy.allowedRoutes),
  );

  return {
    providerHealth: [...routeNames].map((route) => ({
      route,
      status: route === resolved.provider
        || (resolved.provider === 'azure' && route === 'azure-private')
        || route === bifrostRoute
        ? (resolved.configured ? 'configured' : 'unavailable')
        : 'unknown',
    })),
    entitlement: {
      status: resolved.provider === 'bifrost' ? 'managed' : 'not-applicable',
      detail: resolved.provider === 'bifrost'
        ? 'Managed by Bifrost; credentials and account identifiers are redacted.'
        : 'No gateway entitlement is used by the active provider.',
    },
    quota: {
      status: resolved.provider === 'bifrost' ? 'unknown' : 'not-reported',
      detail: resolved.provider === 'bifrost'
        ? 'Bifrost has not reported quota state.'
        : 'The active provider does not expose quota through Mission Control.',
    },
  };
}

export async function GET() {
  try {
    const info = getProviderInfo();
    const resolved = getResolvedAIConfig();
    const savedConfig = await loadSavedProviderConfig();

    return Response.json({
      ...info,
      configured: resolved.configured,
      savedConfig: {
        provider: savedConfig.provider,
        model: savedConfig.model,
        embeddingModel: savedConfig.embeddingModel || resolved.embeddingModel,
        semanticSearchEnabled: savedConfig.semanticSearchEnabled ?? resolved.semanticSearchEnabled,
        baseUrl: savedConfig.baseUrl,
        hasApiKey: Boolean(savedConfig.apiKey || resolved.apiKey),
      },
      routingPolicy: getAIRoutingPolicy(),
      ...getOperationalStatus(),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to load AI configuration', error);
  }
}

export async function POST(request: Request) {
  try {
    const parsed = providerConfigSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues.map((issue) => issue.message).join('; ') },
        { status: 400 },
      );
    }

    const current = await loadSavedProviderConfig();
    const submittedApiKey = parsed.data.apiKey?.trim();
    const sameCredentialTarget = current.provider === parsed.data.provider
      && (current.baseUrl || '') === parsed.data.baseUrl;
    const apiKey = submittedApiKey === REDACTED_API_KEY || parsed.data.apiKey === undefined
      ? (sameCredentialTarget ? current.apiKey || '' : '')
      : submittedApiKey || '';
    const routingPolicy = parsed.data.routingPolicy
      ? validateAIRoutingPolicy(parsed.data.routingPolicy)
      : getAIRoutingPolicy();
    const config = {
      provider: parsed.data.provider,
      model: parsed.data.model,
      embeddingModel: parsed.data.embeddingModel,
      semanticSearchEnabled: parsed.data.semanticSearchEnabled,
      baseUrl: parsed.data.baseUrl,
      apiKey,
    };
    validateProviderEndpoint(config.provider, config.baseUrl || undefined, Boolean(config.apiKey));
    const now = new Date().toISOString();

    db.transaction((tx) => {
      tx
        .insert(appSettings)
        .values({ key: PROVIDER_SETTINGS_KEY, value: config, updatedAt: now })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: config, updatedAt: now },
        })
        .run();
      tx
        .insert(appSettings)
        .values({ key: ROUTING_POLICY_SETTINGS_KEY, value: routingPolicy, updatedAt: now })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: routingPolicy, updatedAt: now },
        })
        .run();
    });

    invalidateAIConfigCache();
    return Response.json({
      success: true,
      config: { ...config, apiKey: apiKey ? REDACTED_API_KEY : '' },
      routingPolicy,
    });
  } catch (error) {
    if (error instanceof AIRoutingPolicyValidationError) {
      return Response.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    if (error instanceof AIProviderEndpointValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Failed to save AI config', error);
  }
}

export async function PUT() {
  try {
    const info = getProviderInfo();
    const resolved = getResolvedAIConfig();
    const { provider, model, baseUrl, apiKey } = resolved;

    if (!resolved.configured) {
      return Response.json({
        success: false,
        error: 'No API key or base URL configured',
      });
    }

    const context = getAIRequestContext('provider-health-check');
    const start = Date.now();
    const url = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider === 'azure'
          ? (apiKey ? { 'api-key': apiKey } : {})
          : (provider !== 'ollama' && apiKey ? { Authorization: `Bearer ${apiKey}` } : {})),
        ...getAIRoutingHeaders(context, provider, baseUrl, Boolean(apiKey), model),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with just "ok"' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - start;

    if (response.ok) {
      const payload = await response.json().catch(() => undefined);
      return Response.json({
        success: true,
        latencyMs,
        model: info.model,
        routing: getAIRouteOutcome(context, {
          modelId: model,
          headers: Object.fromEntries(response.headers.entries()),
        }, provider === 'bifrost' ? extractBifrostRoutingMetadata(payload) : undefined),
      });
    }

    const responseBody = await response.text().catch(() => '');
    return Response.json({
      success: false,
      latencyMs,
      error: `HTTP ${response.status}: ${responseBody.slice(0, 200)}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message });
  }
}
