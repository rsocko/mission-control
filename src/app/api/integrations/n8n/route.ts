import { getN8nConfig, N8N_CONFIG_ID, parseN8NSettings } from '@/lib/integrations/n8n';
import { ApiErrors } from '@/lib/api-error';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

async function fetchN8NWorkflows(baseUrl: string, apiKey: string) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/workflows`, {
    headers: {
      'X-N8N-API-KEY': apiKey,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const detail = typeof parsed === 'string'
      ? parsed.slice(0, 200)
      : JSON.stringify(parsed).slice(0, 200);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  const workflows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown[] } | null)?.data)
      ? (parsed as { data: unknown[] }).data
      : [];

  return workflows.length;
}

export async function GET() {
  const config = await getN8nConfig();
  const settings = parseN8NSettings(config?.settings);

  return Response.json({
    baseUrl: config?.baseUrl || '',
    enabled: config?.enabled ?? false,
    workflowCount: settings.workflowCount ?? 0,
    connected: settings.connected ?? false,
    lastCheckedAt: settings.lastCheckedAt ?? null,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const enabled = body.enabled !== false;
    const webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : undefined;

    const existing = await getN8nConfig();
    const existingSettings = parseN8NSettings(existing?.settings);
    const now = new Date().toISOString();
    const settings = webhookSecret !== undefined
      ? { ...existingSettings, webhookSecret }
      : existingSettings;

    const repositories = await getWorkerPersistenceRepositories();
    await repositories.webhookIntegrations.integrations.save({
      id: N8N_CONFIG_ID,
      type: 'n8n',
      name: 'n8n',
      baseUrl,
      apiKey,
      enabled,
      settings,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    return Response.json({
      success: true,
      config: {
        baseUrl,
        enabled,
      },
    });
  } catch (error) {
    return ApiErrors.internal('Failed to save n8n config', error);
  }
}

export async function PUT() {
  const config = await getN8nConfig();

  if (!config?.baseUrl || !config.apiKey) {
    return Response.json({
      success: false,
      workflowCount: 0,
      error: 'Base URL and API key are required',
    }, { status: 400 });
  }

  const now = new Date().toISOString();
  const settings = parseN8NSettings(config.settings);
  const repositories = await getWorkerPersistenceRepositories();

  try {
    const workflowCount = await fetchN8NWorkflows(config.baseUrl, config.apiKey);

    await repositories.webhookIntegrations.integrations.updateSettings({
      id: N8N_CONFIG_ID,
      settings: {
        ...settings,
        connected: true,
        workflowCount,
        lastCheckedAt: now,
        lastError: null,
      },
      updatedAt: now,
    });

    return Response.json({
      success: true,
      workflowCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await repositories.webhookIntegrations.integrations.updateSettings({
      id: N8N_CONFIG_ID,
      settings: {
        ...settings,
        connected: false,
        workflowCount: 0,
        lastCheckedAt: now,
        lastError: message,
      },
      updatedAt: now,
    });

    return Response.json({
      success: false,
      workflowCount: 0,
      error: message,
    });
  }
}
