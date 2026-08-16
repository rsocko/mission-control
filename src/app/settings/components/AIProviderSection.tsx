'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Loader2, RefreshCw, AlertTriangle, Save, Brain, Activity,
  CheckCircle2, XCircle,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  staggerContainer, fadeSlideUp,
} from '@/lib/motion';
import { settingsLogger } from '@/lib/client-logger';
import { AIRunHistorySection } from './AIRunHistorySection';

// --- AI Provider Section ---------------------------------------------------

type AIProviderValue = 'openai' | 'azure' | 'ollama' | 'bifrost';
type SensitivityClass = 'local-only' | 'restricted' | 'standard';
type AIRouteId = 'ollama' | 'azure-private' | 'bifrost-copilot' | 'openai';

interface RoutingPolicy {
  policies: Record<SensitivityClass, { allowedRoutes: AIRouteId[] }>;
  featureDefaults: Record<string, SensitivityClass>;
  sourceDefaults: Record<string, SensitivityClass>;
}

interface AIModelOption {
  value: string;
  label: string;
  provider: AIProviderValue;
  size?: number;
}

const AI_PROVIDERS: Array<{ value: AIProviderValue; label: string; desc: string }> = [
  { value: 'openai', label: 'OpenAI', desc: 'GPT-4o, GPT-4o-mini, etc.' },
  { value: 'azure', label: 'Azure OpenAI', desc: 'Azure-hosted OpenAI models' },
  { value: 'ollama', label: 'Ollama (Local)', desc: 'Self-hosted models via Ollama' },
  { value: 'bifrost', label: 'Bifrost Gateway', desc: 'Policy-aware Copilot and provider routing' },
];

const STATIC_AI_MODELS: Record<AIProviderValue, AIModelOption[]> = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai' },
    { value: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'openai' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo', provider: 'openai' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', provider: 'openai' },
  ],
  azure: [
    { value: 'gpt-4o', label: 'GPT-4o deployment', provider: 'azure' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini deployment', provider: 'azure' },
    { value: 'gpt-4.1', label: 'GPT-4.1 deployment', provider: 'azure' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini deployment', provider: 'azure' },
  ],
  ollama: [
    { value: 'llama3.1', label: 'llama3.1', provider: 'ollama' },
    { value: 'mistral', label: 'mistral', provider: 'ollama' },
    { value: 'codellama', label: 'codellama', provider: 'ollama' },
  ],
  bifrost: [
    { value: 'azure/gpt-4o-mini', label: 'Azure GPT-4o Mini', provider: 'bifrost' },
    { value: 'azure/gpt-4o', label: 'Azure GPT-4o', provider: 'bifrost' },
  ],
};

const DEFAULT_EMBEDDING_MODELS: Record<AIProviderValue, string> = {
  openai: 'text-embedding-3-small',
  azure: 'text-embedding-3-small',
  ollama: 'nomic-embed-text',
  bifrost: 'ollama/nomic-embed-text:latest',
};

const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  policies: {
    'local-only': { allowedRoutes: ['ollama'] },
    restricted: { allowedRoutes: ['ollama', 'azure-private'] },
    standard: { allowedRoutes: ['bifrost-copilot', 'ollama', 'azure-private', 'openai'] },
  },
  featureDefaults: {},
  sourceDefaults: {},
};

const ROUTE_OPTIONS: Array<{ value: AIRouteId; label: string }> = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'azure-private', label: 'Private Azure AI' },
  { value: 'bifrost-copilot', label: 'GitHub Copilot via Bifrost' },
  { value: 'openai', label: 'OpenAI' },
];

const CLASS_ROUTE_OPTIONS: Record<SensitivityClass, AIRouteId[]> = {
  'local-only': ['ollama'],
  restricted: ['ollama', 'azure-private'],
  standard: ROUTE_OPTIONS.map((route) => route.value),
};

function formatModelSize(size?: number) {
  if (!size || size <= 0) return null;

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function buildModelOption(provider: AIProviderValue, name: string, size?: number): AIModelOption {
  const sizeLabel = formatModelSize(size);

  return {
    value: name,
    label: sizeLabel ? `${name} · ${sizeLabel}` : name,
    provider,
    size,
  };
}

function AIProviderSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; latencyMs?: number; error?: string; model?: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [provider, setProvider] = useState<AIProviderValue>('openai');
  const [model, setModel] = useState('gpt-4o-mini');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState(DEFAULT_EMBEDDING_MODELS.openai);
  const [semanticSearchEnabled, setSemanticSearchEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [activeProvider, setActiveProvider] = useState('openai');
  const [activeModel, setActiveModel] = useState('gpt-4o-mini');
  const [activeBaseUrl, setActiveBaseUrl] = useState('');
  const [availableModels, setAvailableModels] = useState<AIModelOption[]>(STATIC_AI_MODELS.openai);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [routingPolicy, setRoutingPolicy] = useState<RoutingPolicy>(DEFAULT_ROUTING_POLICY);
  const [providerHealth, setProviderHealth] = useState<Array<{ route: string; status: string }>>([]);
  const [entitlement, setEntitlement] = useState<{ status: string; detail: string } | null>(null);
  const [quota, setQuota] = useState<{ status: string; detail: string } | null>(null);

  const refreshModels = useCallback(async (nextProvider: AIProviderValue, nextBaseUrl: string, silent = false) => {
    if (!silent) {
      setModelsLoading(true);
    }
    setModelsError(null);

    try {
      const params = new URLSearchParams({ provider: nextProvider });
      if ((nextProvider === 'ollama' || nextProvider === 'bifrost') && nextBaseUrl.trim()) {
        params.set('baseUrl', nextBaseUrl.trim());
      }

      const response = await fetch(`/api/ai/models?${params.toString()}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load models');
      }

      const models = Array.isArray(data.models)
        ? data.models
          .map((entry: { name?: string; size?: number }): AIModelOption | null => (
            entry.name ? buildModelOption(nextProvider, entry.name, entry.size) : null
          ))
          .filter((entry: AIModelOption | null): entry is AIModelOption => entry !== null)
        : [];

      setAvailableModels(models.length ? models : STATIC_AI_MODELS[nextProvider]);
    } catch (error) {
      setAvailableModels(STATIC_AI_MODELS[nextProvider]);
      setModelsError(error instanceof Error ? error.message : 'Failed to load models');
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const loadProviderStatus = useCallback(async () => {
    const response = await fetch('/api/ai/provider');
    const data = await response.json();

    setActiveProvider(data.provider || 'openai');
    setActiveModel(data.model || 'gpt-4o-mini');
    setActiveBaseUrl(data.baseUrl && data.baseUrl !== 'default' ? data.baseUrl : '');
    setConfigured(Boolean(data.configured));

    const savedConfig = data.savedConfig || {};
    const nextProvider = (savedConfig.provider || data.provider || 'openai') as AIProviderValue;
    const nextModel = savedConfig.model || data.model || 'gpt-4o-mini';
    const nextBaseUrl = savedConfig.baseUrl || (data.baseUrl === 'default' ? '' : data.baseUrl || '');
    const nextApiKey = savedConfig.hasApiKey ? '********' : '';

    setProvider(nextProvider);
    setModel(nextModel);
    setBaseUrl(nextBaseUrl);
    setApiKey(nextApiKey);
    setEmbeddingModel(savedConfig.embeddingModel || DEFAULT_EMBEDDING_MODELS[nextProvider]);
    setSemanticSearchEnabled(Boolean(savedConfig.semanticSearchEnabled));
    setRoutingPolicy(data.routingPolicy || DEFAULT_ROUTING_POLICY);
    setProviderHealth(Array.isArray(data.providerHealth) ? data.providerHealth : []);
    setEntitlement(data.entitlement || null);
    setQuota(data.quota || null);
    await refreshModels(nextProvider, nextBaseUrl, true);
  }, [refreshModels]);

  useEffect(() => {
    queueMicrotask(() => {
      loadProviderStatus()
        .catch((err) => { settingsLogger.error('Failed to load AI provider status', { err }); })
        .finally(() => setLoading(false));
    });
  }, [loadProviderStatus]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/ai/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model,
          embeddingModel,
          semanticSearchEnabled,
          baseUrl,
          apiKey,
          routingPolicy,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save AI configuration');
      }
      await loadProviderStatus();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save AI configuration';
      setSaveError(message);
      settingsLogger.error('Failed to save AI provider configuration', { error: message });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ai/provider', { method: 'PUT' });
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ success: false, error: 'Request failed' });
    }
    setTesting(false);
    setTimeout(() => setTestResult(null), 10000);
  }

  const providerModels = availableModels.length ? availableModels : STATIC_AI_MODELS[provider];
  const filteredModels = providerModels.some(option => option.value === model)
    ? providerModels
    : [buildModelOption(provider, model), ...providerModels];
  const selectedModelMeta = filteredModels.find(option => option.value === model);

  function togglePolicyRoute(sensitivity: SensitivityClass, route: AIRouteId) {
    setRoutingPolicy((current) => {
      const routes = current.policies[sensitivity].allowedRoutes;
      const allowedRoutes = routes.includes(route)
        ? routes.filter((candidate) => candidate !== route)
        : [...routes, route];
      return {
        ...current,
        policies: {
          ...current.policies,
          [sensitivity]: { allowedRoutes },
        },
      };
    });
  }

  function movePolicyRoute(sensitivity: SensitivityClass, routeIndex: number, direction: -1 | 1) {
    setRoutingPolicy((current) => {
      const allowedRoutes = [...current.policies[sensitivity].allowedRoutes];
      const targetIndex = routeIndex + direction;
      if (targetIndex < 0 || targetIndex >= allowedRoutes.length) return current;
      [allowedRoutes[routeIndex], allowedRoutes[targetIndex]] = [
        allowedRoutes[targetIndex],
        allowedRoutes[routeIndex],
      ];
      return {
        ...current,
        policies: {
          ...current.policies,
          [sensitivity]: { allowedRoutes },
        },
      };
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--text-muted)] py-12">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">Loading AI configuration...</span>
      </div>
    );
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-[var(--text-primary)]">AI Provider</h2>
        <p className="text-sm text-[var(--text-tertiary)] mt-1">
          Configure the AI model used for smart priority, daily digest, task triage, and other AI features.
        </p>
      </div>

      {/* Status Banner */}
      <motion.div variants={fadeSlideUp}
        className={`rounded-xl border p-4 flex items-center gap-3 ${
          configured
            ? 'bg-emerald-900/10 border-emerald-800/30'
            : 'bg-amber-900/10 border-amber-800/30'
        }`}
      >
        {configured ? (
          <>
            <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-emerald-300">AI Connected</p>
              <p className="text-xs text-[var(--text-muted)]">
                Active: <span className="font-mono text-[var(--text-secondary)]">{activeProvider}/{activeModel}</span>
                {activeBaseUrl && <span> via <span className="font-mono">{activeBaseUrl}</span></span>}
              </p>
            </div>
          </>
        ) : (
          <>
            <AlertTriangle size={18} className="text-amber-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-300">AI Not Configured</p>
              <p className="text-xs text-[var(--text-muted)]">Set an API key or base URL to enable AI features.</p>
            </div>
          </>
        )}
      </motion.div>

      <motion.div variants={fadeSlideUp} className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
          <p className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">Provider health</p>
          <div className="mt-2 space-y-1">
            {providerHealth.map((health) => (
              <div key={health.route} className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono text-[var(--text-secondary)]">{health.route}</span>
                <span className="capitalize text-[var(--text-muted)]">{health.status}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
          <p className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">Entitlement</p>
          <p className="mt-2 text-sm capitalize text-[var(--text-secondary)]">{entitlement?.status || 'unknown'}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{entitlement?.detail}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
          <p className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">Quota</p>
          <p className="mt-2 text-sm capitalize text-[var(--text-secondary)]">{quota?.status || 'unknown'}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{quota?.detail}</p>
        </div>
      </motion.div>

      {/* Config Form */}
      <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 space-y-5">
        {/* Provider Selection */}
        <div>
          <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 block">Provider</label>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {AI_PROVIDERS.map(p => (
              <button
                key={p.value}
                onClick={() => {
                  setProvider(p.value);
                  let nextBaseUrl = baseUrl;
                  if (p.value !== provider) {
                    setApiKey('');
                    setModel(STATIC_AI_MODELS[p.value][0].value);
                    setEmbeddingModel(DEFAULT_EMBEDDING_MODELS[p.value]);
                    nextBaseUrl = '';
                    setBaseUrl(nextBaseUrl);
                  }
                  void refreshModels(p.value, nextBaseUrl, true);
                }}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  provider === p.value
                    ? 'border-blue-500/50 bg-blue-900/20 ring-1 ring-blue-500/30'
                    : 'border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <p className={`text-sm font-medium ${provider === p.value ? 'text-blue-300' : 'text-[var(--text-secondary)]'}`}>
                  {p.label}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{p.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Model */}
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase block">Model</label>
            {(provider === 'ollama' || provider === 'bifrost') && (
              <button
                onClick={() => refreshModels(provider, baseUrl)}
                disabled={modelsLoading}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
              >
                <RefreshCw size={12} className={modelsLoading ? 'animate-spin' : ''} />
                {modelsLoading ? 'Refreshing...' : 'Refresh Models'}
              </button>
            )}
          </div>
          <Select value={model} onValueChange={(v) => setModel(v)}>
            <SelectTrigger className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {filteredModels.map(m => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {modelsError && (
            <p className="mt-1 text-xs text-amber-400">{modelsError}</p>
          )}
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {provider === 'bifrost'
              ? 'Bifrost model IDs must include the provider prefix, such as azure/gpt-4o-mini.'
              : 'Or type a custom model ID in the input below'}
          </p>
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="Custom model name..."
            className="mt-1.5 w-full px-3 py-1.5 bg-[var(--surface-0)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-secondary)] focus:outline-none font-mono"
          />
          {selectedModelMeta?.size && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Selected model size: {formatModelSize(selectedModelMeta.size)}
            </p>
          )}
        </div>

        {/* Base URL */}
        <div>
          <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
            Base URL {provider === 'ollama' && <span className="text-[var(--text-muted)] font-normal normal-case">(default: http://localhost:11434/v1)</span>}
          </label>
          <input
            type="url"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder={
              provider === 'ollama'
                ? 'http://localhost:11434/v1'
                : provider === 'bifrost'
                  ? 'https://bifrost.example.com/v1'
                  : 'Leave blank for default OpenAI endpoint'
            }
            className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none font-mono"
          />
        </div>

        {/* API Key */}
        {provider !== 'ollama' && (
          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={provider === 'bifrost' ? 'Bifrost virtual key (optional)' : 'sk-...'}
              className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none font-mono"
            />
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Stored locally in SQLite and used at runtime. Leave blank only when the endpoint is intentionally unauthenticated.
            </p>
          </div>
        )}

        <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-4">
          <label className="flex cursor-pointer items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-[var(--text-secondary)]">
                Semantic search enrichment
              </span>
              <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                Add meaning-based matches after keyword results. Off by default; queries are not stored.
              </span>
            </span>
            <input
              type="checkbox"
              checked={semanticSearchEnabled}
              onChange={(event) => setSemanticSearchEnabled(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 rounded border-[var(--border-strong)]"
            />
          </label>

          {semanticSearchEnabled && (
            <div>
              <label
                htmlFor="ai-embedding-model"
                className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]"
              >
                Embedding model
              </label>
              <input
                id="ai-embedding-model"
                type="text"
                value={embeddingModel}
                onChange={(event) => setEmbeddingModel(event.target.value)}
                required
                maxLength={200}
                placeholder={DEFAULT_EMBEDDING_MODELS[provider]}
                className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none font-mono"
              />
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                {provider === 'bifrost'
                  ? 'Use a provider-qualified Bifrost ID, such as ollama/nomic-embed-text:latest.'
                  : 'Separate from the completion model. Existing entity embeddings remain stored when this is off.'}
              </p>
            </div>
          )}
        </div>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Sensitivity routing policies</h3>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Mission Control permits only enabled routes. The configured order is forwarded to gateways that support policy-aware fallback.
          </p>
        </div>
        {(['local-only', 'restricted', 'standard'] as SensitivityClass[]).map((sensitivity) => {
          const selectedRoutes = routingPolicy.policies[sensitivity].allowedRoutes;
          return (
            <div key={sensitivity} className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium capitalize text-[var(--text-secondary)]">
                    {sensitivity.replace('-', ' ')}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {sensitivity === 'local-only'
                      ? 'Data never leaves the local Ollama route.'
                      : sensitivity === 'restricted'
                        ? 'Only local or approved private Azure routes.'
                        : 'All approved routes may be used.'}
                  </p>
                </div>
                {selectedRoutes.length === 0 && (
                  <span className="text-xs font-medium text-red-400">At least one route is required</span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-3">
                {ROUTE_OPTIONS
                  .filter((route) => CLASS_ROUTE_OPTIONS[sensitivity].includes(route.value))
                  .map((route) => (
                    <label key={route.value} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                      <input
                        type="checkbox"
                        checked={selectedRoutes.includes(route.value)}
                        onChange={() => togglePolicyRoute(sensitivity, route.value)}
                        className="h-4 w-4 rounded border-[var(--border-strong)]"
                      />
                      {route.label}
                    </label>
                  ))}
              </div>
              {selectedRoutes.length > 0 && (
                <ol className="mt-3 space-y-1" aria-label={`${sensitivity} fallback order`}>
                  {selectedRoutes.map((route, index) => (
                    <li key={route} className="flex items-center gap-2 rounded-md bg-[var(--surface-1)] px-2 py-1.5 text-xs">
                      <span className="w-5 text-[var(--text-muted)]">{index + 1}.</span>
                      <span className="flex-1 font-mono text-[var(--text-secondary)]">{route}</span>
                      <button
                        type="button"
                        onClick={() => movePolicyRoute(sensitivity, index, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${route} earlier`}
                        className="rounded px-2 py-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] disabled:opacity-30"
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        onClick={() => movePolicyRoute(sensitivity, index, 1)}
                        disabled={index === selectedRoutes.length - 1}
                        aria-label={`Move ${route} later`}
                        className="rounded px-2 py-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] disabled:opacity-30"
                      >
                        Down
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </motion.div>

      {/* Actions */}
      <motion.div variants={fadeSlideUp} className="flex items-center gap-3">
        <motion.button
          onClick={handleSave}
          disabled={saving}
          whileTap={{ scale: 0.97 }}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-sm flex items-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving...' : 'Save Configuration'}
        </motion.button>

        <motion.button
          onClick={handleTest}
          disabled={testing}
          whileTap={{ scale: 0.97 }}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)] flex items-center gap-2 disabled:opacity-50"
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
          {testing ? 'Testing...' : 'Test Connection'}
        </motion.button>

        {saved && (
          <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="text-sm text-emerald-400 flex items-center gap-1">
            <CheckCircle2 size={14} /> Configuration saved
          </motion.span>
        )}
      </motion.div>

      {saveError && (
        <div role="alert" className="rounded-lg border border-red-800/30 bg-red-900/10 p-3 text-sm text-red-300">
          {saveError}
        </div>
      )}

      {/* Test Result */}
      <AnimatePresence>
        {testResult && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`rounded-xl border p-4 ${
              testResult.success
                ? 'bg-emerald-900/10 border-emerald-800/30'
                : 'bg-red-900/10 border-red-800/30'
            }`}
          >
            <div className="flex items-center gap-2">
              {testResult.success ? (
                <CheckCircle2 size={16} className="text-emerald-400" />
              ) : (
                <XCircle size={16} className="text-red-400" />
              )}
              <span className={`text-sm font-medium ${testResult.success ? 'text-emerald-300' : 'text-red-300'}`}>
                {testResult.success ? 'Connection Successful' : 'Connection Failed'}
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1 ml-6">
              {testResult.success
                ? `Model "${testResult.model}" responded in ${testResult.latencyMs}ms`
                : testResult.error}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <AIRunHistorySection />

      {/* Info note */}
      <motion.div variants={fadeSlideUp} className="text-xs text-[var(--text-muted)] bg-[var(--surface-0)] border border-[var(--border-subtle)] rounded-lg p-3 flex items-start gap-2">
        <Brain size={12} className="shrink-0 mt-0.5 text-[var(--text-tertiary)]" />
        <div>
          <p>AI is used for: Smart Priority scoring, Daily Digest generation, Notification Triage, Tag Inference, and the &quot;What&apos;s Next?&quot; assistant.</p>
          <p className="mt-1">Saved settings in SQLite now take precedence at runtime. Environment variables remain the fallback when a saved value is blank.</p>
        </div>
      </motion.div>
    </motion.div>
  );
}

export { AIProviderSection };
