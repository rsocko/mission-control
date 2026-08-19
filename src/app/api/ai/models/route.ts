import {
  AIProviderEndpointValidationError,
  validateProviderEndpoint,
} from '@/lib/ai/sensitivity-policy';
import { getResolvedAIConfig } from '@/lib/ai/config-resolver';

const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
];

const BIFROST_MODELS = [
  'azure/gpt-4o-mini',
  'azure/gpt-4o',
];

function getOllamaTagsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/$/, '');
  const ollamaBase = normalized.endsWith('/v1')
    ? normalized.slice(0, -3)
    : normalized;

  return `${ollamaBase}/api/tags`;
}

function getBifrostModelsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/models`;
}

function getBifrostAuthorization(baseUrl: string): Record<string, string> {
  const resolved = getResolvedAIConfig();
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const resolvedCredential = resolved.provider === 'bifrost'
    && resolved.baseUrl?.replace(/\/+$/, '') === normalizedBaseUrl
    ? resolved.apiKey
    : undefined;
  const environmentCredential = process.env.BIFROST_BASE_URL?.replace(/\/+$/, '') === normalizedBaseUrl
    ? process.env.BIFROST_API_KEY
    : undefined;
  const apiKey = resolvedCredential || environmentCredential;
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get('provider') || 'openai';
  const baseUrl = searchParams.get('baseUrl') || 'http://localhost:11434/v1';

  if (provider === 'ollama') {
    try {
      validateProviderEndpoint(provider, baseUrl);
      const response = await fetch(getOllamaTagsUrl(baseUrl), {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const message = await response.text().catch(() => '');
        return Response.json(
          { error: `Failed to load Ollama models: HTTP ${response.status} ${message.slice(0, 120)}` },
          { status: 502 },
        );
      }

      const payload = await response.json() as {
        models?: Array<{ name?: string; size?: number }>;
      };

      const models = (payload.models || [])
        .map((model) => ({
          name: model.name || '',
          size: model.size,
        }))
        .filter((model) => model.name);

      return Response.json({ models });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Failed to load Ollama models: ${message}` }, { status: 502 });
    }
  }

  if (provider === 'bifrost') {
    const resolved = getResolvedAIConfig();
    const bifrostBaseUrl = searchParams.get('baseUrl')
      || (resolved.provider === 'bifrost' ? resolved.baseUrl : undefined)
      || process.env.BIFROST_BASE_URL;
    if (!bifrostBaseUrl) {
      return Response.json({
        models: BIFROST_MODELS.map((name) => ({ name })),
      });
    }

    try {
      validateProviderEndpoint(provider, bifrostBaseUrl, Boolean(getBifrostAuthorization(bifrostBaseUrl).Authorization));
      const response = await fetch(getBifrostModelsUrl(bifrostBaseUrl), {
        cache: 'no-store',
        headers: getBifrostAuthorization(bifrostBaseUrl),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        const message = await response.text().catch(() => '');
        return Response.json(
          { error: `Failed to load Bifrost models: HTTP ${response.status} ${message.slice(0, 120)}` },
          { status: 502 },
        );
      }

      const payload = await response.json() as {
        data?: Array<{ id?: string }>;
      };
      const models = (payload.data || [])
        .map((entry) => ({ name: entry.id || '' }))
        .filter((entry) => entry.name);
      return Response.json({
        models: models.length ? models : BIFROST_MODELS.map((name) => ({ name })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof AIProviderEndpointValidationError ? 400 : 502;
      return Response.json({ error: `Failed to load Bifrost models: ${message}` }, { status });
    }
  }

  if (provider === 'azure') {
    return Response.json({ models: OPENAI_MODELS.map((name) => ({ name })) });
  }

  return Response.json({
    models: OPENAI_MODELS.map((name) => ({ name })),
  });
}
