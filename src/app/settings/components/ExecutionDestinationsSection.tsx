'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CloudCog,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Toggle } from '@/components/settings/SettingsPrimitives';
import { settingsLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';
import type {
  AgentDataClassification,
  ExternalAgentCapabilities,
  ExternalAgentDataPolicy,
  ExternalAgentProviderConfig,
  ExternalAgentType,
} from '@/lib/external-agents/contracts';

type DestinationType = Extract<ExternalAgentType, 'copilot-cloud' | 'paperclip'>;
type Capability = keyof ExternalAgentCapabilities;

interface ExecutionDestination {
  id: string;
  name: string;
  type: DestinationType;
  description: string | null;
  endpoint: string | null;
  authType: 'none' | 'bearer' | 'github-user';
  providerConfig: ExternalAgentProviderConfig;
  capabilities: ExternalAgentCapabilities;
  dataPolicy: ExternalAgentDataPolicy;
  enabled: boolean;
  executionLocality: 'github-hosted' | 'external';
  hasCredentialReference: boolean;
  credentialSource: 'mission-control' | 'deployment-secret';
  updatedAt: string;
}

interface DestinationForm {
  id: string | null;
  type: DestinationType;
  name: string;
  description: string;
  endpoint: string;
  credential: string;
  credentialRef: string;
  credentialSource: 'mission-control' | 'deployment-secret';
  companyId: string;
  projectId: string;
  assigneeAgentId: string;
  requiredAdapterType: string;
  alwaysInstructions: string;
  capabilities: ExternalAgentCapabilities;
  allowedClassifications: AgentDataClassification[];
  enabled: boolean;
}

const CAPABILITY_OPTIONS: Array<{
  key: Capability;
  label: string;
  description: string;
  types: DestinationType[];
}> = [
  {
    key: 'canAnalyzeCode',
    label: 'Analyze code',
    description: 'Read repository context and explain changes.',
    types: ['copilot-cloud', 'paperclip'],
  },
  {
    key: 'canWriteCode',
    label: 'Write code',
    description: 'Modify files in the selected repository.',
    types: ['copilot-cloud', 'paperclip'],
  },
  {
    key: 'canRunCommands',
    label: 'Run commands',
    description: 'Run tests, builds, and approved tools.',
    types: ['copilot-cloud', 'paperclip'],
  },
  {
    key: 'canPush',
    label: 'Push branches',
    description: 'Publish a provider-created branch.',
    types: ['copilot-cloud', 'paperclip'],
  },
  {
    key: 'canCreatePullRequest',
    label: 'Create pull requests',
    description: 'Open a pull request for completed work.',
    types: ['copilot-cloud', 'paperclip'],
  },
  {
    key: 'canProposeTasks',
    label: 'Propose tasks',
    description: 'Return task proposals for review.',
    types: ['paperclip'],
  },
  {
    key: 'canProposePhases',
    label: 'Propose phases',
    description: 'Return project phase proposals for review.',
    types: ['paperclip'],
  },
];

const DEFAULT_CAPABILITIES: Record<DestinationType, ExternalAgentCapabilities> = {
  'copilot-cloud': {
    canAnalyzeCode: true,
    canWriteCode: true,
    canRunCommands: true,
    canPush: true,
    canCreatePullRequest: true,
  },
  paperclip: {
    canAnalyzeCode: true,
    canWriteCode: true,
    canRunCommands: true,
  },
};

function emptyForm(type: DestinationType): DestinationForm {
  return {
    id: null,
    type,
    name: type === 'copilot-cloud' ? 'GitHub Copilot Cloud' : 'Paperclip',
    description: '',
    endpoint: type === 'copilot-cloud' ? 'https://api.github.com' : '',
    credential: '',
    credentialRef: '',
    credentialSource: 'mission-control',
    companyId: '',
    projectId: '',
    assigneeAgentId: '',
    requiredAdapterType: '',
    alwaysInstructions: '',
    capabilities: DEFAULT_CAPABILITIES[type],
    allowedClassifications: ['standard'],
    enabled: true,
  };
}

function editForm(destination: ExecutionDestination): DestinationForm {
  const paperclip = destination.providerConfig.paperclip;
  return {
    id: destination.id,
    type: destination.type,
    name: destination.name,
    description: destination.description ?? '',
    endpoint: destination.endpoint ?? '',
    credential: '',
    credentialRef: '',
    credentialSource: destination.credentialSource ?? 'deployment-secret',
    companyId: paperclip?.companyId ?? '',
    projectId: paperclip?.projectId ?? '',
    assigneeAgentId: paperclip?.assigneeAgentId ?? '',
    requiredAdapterType: paperclip?.requiredAdapterType ?? '',
    alwaysInstructions: destination.providerConfig.alwaysInstructions ?? '',
    capabilities: destination.capabilities,
    allowedClassifications: destination.dataPolicy.allowedClassifications,
    enabled: destination.enabled,
  };
}

function responseError(body: unknown, status: number) {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return `Request failed (${status})`;
}

function destinationLabel(type: DestinationType) {
  return type === 'copilot-cloud' ? 'GitHub Copilot Cloud' : 'Paperclip route';
}

function DestinationIcon({ type, size = 18 }: { type: DestinationType; size?: number }) {
  return type === 'copilot-cloud' ? <CloudCog size={size} /> : <Bot size={size} />;
}

export function ExecutionDestinationsSection() {
  const [destinations, setDestinations] = useState<ExecutionDestination[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<DestinationForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExecutionDestination | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showCredential, setShowCredential] = useState(false);

  const loadDestinations = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch('/api/external-agents');
      const body = await response.json().catch(() => null) as {
        agents?: ExecutionDestination[];
      } | null;
      if (!response.ok) throw new Error(responseError(body, response.status));
      setDestinations(
        (body?.agents ?? []).filter((agent) =>
          agent.type === 'copilot-cloud' || agent.type === 'paperclip'),
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Failed to load execution destinations';
      setLoadError(message);
      settingsLogger.error('Failed to load execution destinations', { error: message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadDestinations();
    });
  }, [loadDestinations]);

  const formDestination = form?.id
    ? destinations.find((destination) => destination.id === form.id)
    : undefined;
  const switchingGitHubCredentialSource = Boolean(
    form?.type === 'copilot-cloud'
    && form.id
    && formDestination?.credentialSource !== form.credentialSource,
  );

  function updateForm(patch: Partial<DestinationForm>) {
    setForm((current) => current ? { ...current, ...patch } : current);
  }

  function toggleCapability(capability: Capability) {
    setForm((current) => current
      ? {
        ...current,
        capabilities: {
          ...current.capabilities,
          [capability]: !current.capabilities[capability],
        },
      }
      : current);
  }

  function toggleClassification(classification: AgentDataClassification) {
    setForm((current) => {
      if (!current) return current;
      const exists = current.allowedClassifications.includes(classification);
      if (exists && current.allowedClassifications.length === 1) return current;
      return {
        ...current,
        allowedClassifications: exists
          ? current.allowedClassifications.filter((value) => value !== classification)
          : [...current.allowedClassifications, classification],
      };
    });
  }

  async function saveDestination(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveError(null);

    const existing = form.id
      ? destinations.find((destination) => destination.id === form.id)
      : undefined;
    const credentialRef = form.credentialRef.trim();
    const credential = form.credential.trim();
    const usesManagedGitHubCredential = form.type === 'copilot-cloud'
      && form.credentialSource === 'mission-control';
    const paperclipUsesCredential = form.type === 'paperclip'
      && Boolean(credentialRef || existing?.hasCredentialReference);
    const body = {
      name: form.name.trim(),
      type: form.type,
      description: form.description.trim() || null,
      endpoint: form.type === 'copilot-cloud'
        ? 'https://api.github.com'
        : form.endpoint.trim(),
      authType: form.type === 'copilot-cloud'
        ? 'github-user'
        : paperclipUsesCredential ? 'bearer' : 'none',
      ...(usesManagedGitHubCredential && credential ? { credential } : {}),
      ...(!usesManagedGitHubCredential && credentialRef
        ? { authCredentialRef: credentialRef }
        : {}),
      ...(form.type === 'paperclip' && !paperclipUsesCredential
        ? { authCredentialRef: null }
        : {}),
      providerConfig: form.type === 'paperclip'
        ? {
          ...(form.alwaysInstructions.trim()
            ? { alwaysInstructions: form.alwaysInstructions.trim() }
            : {}),
          paperclip: {
            companyId: form.companyId.trim(),
            assigneeAgentId: form.assigneeAgentId.trim(),
            ...(form.projectId.trim() ? { projectId: form.projectId.trim() } : {}),
            ...(form.requiredAdapterType.trim()
              ? { requiredAdapterType: form.requiredAdapterType.trim() }
              : {}),
          },
        }
        : {
          ...(form.alwaysInstructions.trim()
            ? { alwaysInstructions: form.alwaysInstructions.trim() }
            : {}),
        },
      capabilities: form.capabilities,
      dataPolicy: {
        allowedClassifications: form.allowedClassifications,
      },
      enabled: form.enabled,
    };

    try {
      const response = await fetch(
        form.id ? `/api/external-agents/${encodeURIComponent(form.id)}` : '/api/external-agents',
        {
          method: form.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(responseBody, response.status));
      setForm(null);
      await loadDestinations();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save destination';
      setSaveError(message);
      settingsLogger.error('Failed to save execution destination', { error: message });
    } finally {
      setSaving(false);
    }
  }

  async function toggleDestination(destination: ExecutionDestination) {
    try {
      const response = await fetch(
        `/api/external-agents/${encodeURIComponent(destination.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !destination.enabled }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(body, response.status));
      await loadDestinations();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update destination';
      setLoadError(message);
      settingsLogger.error('Failed to toggle execution destination', { error: message });
    }
  }

  async function deleteDestination() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch(
        `/api/external-agents/${encodeURIComponent(deleteTarget.id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(responseError(body, response.status));
      }
      setDeleteTarget(null);
      if (form?.id === deleteTarget.id) setForm(null);
      await loadDestinations();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete destination';
      setLoadError(message);
      settingsLogger.error('Failed to delete execution destination', { error: message });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="execution-destinations-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3
            id="execution-destinations-heading"
            className="text-base font-semibold text-[var(--text-primary)]"
          >
            Execution Destinations
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-tertiary)]">
            Configure the trusted routes available when you delegate a task. Source connectors
            remain separate and determine which repositories can be selected.
          </p>
        </div>
        {!form && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setForm(emptyForm('paperclip'))}
            >
              <Plus size={14} />
              Paperclip route
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setForm(emptyForm('copilot-cloud'))}
            >
              <Plus size={14} />
              GitHub Copilot Cloud
            </Button>
          </div>
        )}
      </div>

      {loadError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-red-800/40 bg-red-950/20 p-3 text-sm text-red-300"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadDestinations()}
            className="shrink-0 rounded p-1 text-red-200 hover:bg-red-900/30"
            aria-label="Retry loading execution destinations"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] text-sm text-[var(--text-muted)]">
          <Loader2 size={16} className="animate-spin" />
          Loading destinations...
        </div>
      ) : destinations.length === 0 && !form && !loadError ? (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-1)] px-5 py-8 text-center">
          <Bot size={24} className="mx-auto text-[var(--text-muted)]" />
          <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">
            No execution destinations yet
          </p>
          <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-[var(--text-muted)]">
            Add GitHub Copilot Cloud for GitHub-hosted Agent Tasks or bind a validated Paperclip
            route. Nothing is transmitted until a delegation preview is reviewed and confirmed.
          </p>
        </div>
      ) : destinations.length > 0 ? (
        <div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
          {destinations.map((destination) => {
            const paperclip = destination.providerConfig.paperclip;
            return (
              <div key={destination.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
                  <DestinationIcon type={destination.type} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {destination.name}
                    </p>
                    <Badge variant={destination.enabled ? 'success' : 'secondary'}>
                      {destination.enabled ? 'Ready' : 'Disabled'}
                    </Badge>
                    <Badge variant="outline">{destinationLabel(destination.type)}</Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                    {destination.description
                      || (destination.type === 'copilot-cloud'
                        ? 'GitHub-hosted execution using the official Agent Tasks API.'
                        : `${destination.endpoint} · company ${paperclip?.companyId ?? 'not bound'}`)}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                    {destination.hasCredentialReference
                      ? destination.credentialSource === 'mission-control'
                        ? 'Personal access token stored in Mission Control'
                        : 'Deployment secret reference configured'
                      : destination.authType === 'none'
                        ? 'Trusted local access; no credential stored'
                        : 'Credential reference required'}
                    {' · '}{destination.executionLocality}
                  </p>
                </div>
                <div className="flex items-center gap-2 sm:justify-end">
                  <Toggle
                    enabled={destination.enabled}
                    onChange={() => void toggleDestination(destination)}
                    label={`${destination.enabled ? 'Disable' : 'Enable'} ${destination.name}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setSaveError(null);
                      setForm(editForm(destination));
                    }}
                    aria-label={`Edit ${destination.name}`}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteTarget(destination)}
                    aria-label={`Delete ${destination.name}`}
                    className="hover:text-red-300"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {form && (
        <form
          onSubmit={saveDestination}
          className="space-y-5 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] p-5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                {form.id ? `Edit ${destinationLabel(form.type)}` : `Add ${destinationLabel(form.type)}`}
              </h4>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                {form.type === 'copilot-cloud'
                  ? 'Use a GitHub personal access token here, just like a GitHub Issues connector. Mission Control validates it with GitHub and never returns it to the browser.'
                  : 'The company, project, assignee, and adapter binding is validated now and cannot be changed during delegation.'}
              </p>
            </div>
            <Badge variant="outline">
              <DestinationIcon type={form.type} size={13} />
              {destinationLabel(form.type)}
            </Badge>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="destination-name">
              <input
                id="destination-name"
                required
                maxLength={120}
                value={form.name}
                onChange={(event) => updateForm({ name: event.target.value })}
                className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </Field>
            {form.type === 'copilot-cloud' ? (
              <Field label="Credential source" htmlFor="destination-credential-source">
                <Select
                  value={form.credentialSource}
                  onValueChange={(value) => updateForm({
                    credentialSource: value as DestinationForm['credentialSource'],
                    credential: '',
                    credentialRef: '',
                  })}
                >
                  <SelectTrigger id="destination-credential-source" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mission-control">
                      Personal access token
                    </SelectItem>
                    <SelectItem value="deployment-secret">
                      Deployment secret reference
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <Field
                label="Credential reference"
                htmlFor="destination-credential"
                hint={form.id
                  ? 'Leave blank to keep the current server-side reference.'
                  : 'Optional only for a trusted local Paperclip endpoint.'}
              >
                <input
                  id="destination-credential"
                  maxLength={200}
                  autoComplete="off"
                  value={form.credentialRef}
                  onChange={(event) => updateForm({ credentialRef: event.target.value })}
                  placeholder={form.id ? 'Current reference is hidden' : 'paperclip-token'}
                  className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                />
              </Field>
            )}
          </div>

          {form.type === 'copilot-cloud' && form.credentialSource === 'mission-control' && (
            <Field
              label="Personal access token"
              htmlFor="github-cloud-token"
              hint={form.id && !switchingGitHubCredentialSource
                ? 'Leave blank to keep the currently stored token.'
                : 'Required. Use a GitHub user token authorized for Copilot Agent Tasks.'}
            >
              <div className="relative">
                <input
                  id="github-cloud-token"
                  type={showCredential ? 'text' : 'password'}
                  required={!form.id || switchingGitHubCredentialSource}
                  autoComplete="new-password"
                  value={form.credential}
                  onChange={(event) => updateForm({ credential: event.target.value })}
                  placeholder={form.id && !switchingGitHubCredentialSource
                    ? 'Current token is hidden'
                    : 'github_pat_...'}
                  className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 pr-10 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowCredential((current) => !current)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                  aria-label={`${showCredential ? 'Hide' : 'Show'} personal access token`}
                >
                  {showCredential ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                <a
                  href="https://github.com/settings/personal-access-tokens/new"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                >
                  Create fine-grained token <ExternalLink size={11} />
                </a>
                <a
                  href="https://github.com/settings/tokens/new"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                >
                  Create classic token <ExternalLink size={11} />
                </a>
              </div>
            </Field>
          )}

          {form.type === 'copilot-cloud' && form.credentialSource === 'deployment-secret' && (
            <Field
              label="Deployment secret reference"
              htmlFor="destination-credential"
              hint={form.id && !switchingGitHubCredentialSource
                ? 'Leave blank to keep the current reference.'
                : 'Required. Key in MC_EXTERNAL_AGENT_CREDENTIALS_JSON.'}
            >
              <input
                id="destination-credential"
                required={!form.id || switchingGitHubCredentialSource}
                maxLength={200}
                autoComplete="off"
                value={form.credentialRef}
                onChange={(event) => updateForm({ credentialRef: event.target.value })}
                placeholder={form.id && !switchingGitHubCredentialSource
                  ? 'Current reference is hidden'
                  : 'github-agent-user'}
                className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </Field>
          )}

          <Field label="Description" htmlFor="destination-description">
            <textarea
              id="destination-description"
              rows={2}
              maxLength={500}
              value={form.description}
              onChange={(event) => updateForm({ description: event.target.value })}
              placeholder="When should this destination be used?"
              className="input-glow w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
          </Field>

          <Field
            label="Always instructions"
            htmlFor="destination-always-instructions"
            hint="Server-owned instructions applied to every eligible dispatch. They are shown again in disclosure review before confirmation."
          >
            <textarea
              id="destination-always-instructions"
              rows={5}
              maxLength={16_000}
              value={form.alwaysInstructions}
              onChange={(event) => updateForm({ alwaysInstructions: event.target.value })}
              placeholder="Standards, validation, or handoff requirements for every dispatch to this destination."
              className="input-glow w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
          </Field>

          {form.type === 'paperclip' && (
            <div className="space-y-4">
              <Field
                label="Paperclip API origin"
                htmlFor="paperclip-endpoint"
                hint="Use an origin only, without an API path, query, or fragment."
              >
                <input
                  id="paperclip-endpoint"
                  type="url"
                  required
                  value={form.endpoint}
                  onChange={(event) => updateForm({ endpoint: event.target.value })}
                  placeholder="https://paperclip.example.com"
                  className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Company ID" htmlFor="paperclip-company">
                  <input
                    id="paperclip-company"
                    required
                    value={form.companyId}
                    onChange={(event) => updateForm({ companyId: event.target.value })}
                    placeholder="UUID"
                    className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                </Field>
                <Field label="Project ID" htmlFor="paperclip-project" hint="Optional route scope.">
                  <input
                    id="paperclip-project"
                    value={form.projectId}
                    onChange={(event) => updateForm({ projectId: event.target.value })}
                    placeholder="UUID"
                    className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                </Field>
                <Field label="Assignee agent ID" htmlFor="paperclip-agent">
                  <input
                    id="paperclip-agent"
                    required
                    value={form.assigneeAgentId}
                    onChange={(event) => updateForm({ assigneeAgentId: event.target.value })}
                    placeholder="UUID"
                    className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                </Field>
                <Field
                  label="Required adapter type"
                  htmlFor="paperclip-adapter"
                  hint="Optional runtime compatibility lock."
                >
                  <input
                    id="paperclip-adapter"
                    value={form.requiredAdapterType}
                    onChange={(event) => updateForm({ requiredAdapterType: event.target.value })}
                    placeholder="claude-local"
                    className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                </Field>
              </div>
            </div>
          )}

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
              Allowed work
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {CAPABILITY_OPTIONS
                .filter((option) => option.types.includes(form.type))
                .map((option) => (
                  <label
                    key={option.key}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                      form.capabilities[option.key]
                        ? 'border-[var(--accent-500)]/50 bg-[var(--accent-900)]/15'
                        : 'border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-2)]',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(form.capabilities[option.key])}
                      onChange={() => toggleCapability(option.key)}
                      className="mt-0.5 h-4 w-4 rounded border-[var(--border-strong)]"
                    />
                    <span>
                      <span className="block text-sm font-medium text-[var(--text-secondary)]">
                        {option.label}
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-[var(--text-muted)]">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
              Data classifications
            </legend>
            <p className="text-xs leading-5 text-[var(--text-muted)]">
              Local-only task context can never be sent to these destinations. Restricted context
              remains denied unless you explicitly allow it here.
            </p>
            <div className="flex flex-wrap gap-2">
              {(['standard', 'restricted'] as const).map((classification) => {
                const selected = form.allowedClassifications.includes(classification);
                return (
                  <button
                    key={classification}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleClassification(classification)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                      selected
                        ? 'border-[var(--accent-500)]/50 bg-[var(--accent-900)]/20 text-[var(--accent-300)]'
                        : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]',
                    )}
                  >
                    {selected && <CheckCircle2 size={13} />}
                    {classification === 'standard' ? 'Standard' : 'Restricted'}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
            <div>
              <p className="text-sm font-medium text-[var(--text-secondary)]">
                Available for delegation
              </p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Disabled destinations remain configured but cannot receive new work.
              </p>
            </div>
            <Toggle
              enabled={form.enabled}
              onChange={(enabled) => updateForm({ enabled })}
              label="Available for delegation"
            />
          </div>

          {saveError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-800/40 bg-red-950/20 p-3 text-sm text-red-300"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setForm(null);
                setSaveError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {saving
                ? 'Validating...'
                : form.id ? 'Save destination' : 'Add destination'}
            </Button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete execution destination?"
        message={deleteTarget
          ? `${deleteTarget.name} will no longer be available for new delegations. Existing run history is preserved.`
          : ''}
        confirmLabel={deleting ? 'Deleting...' : 'Delete destination'}
        confirmVariant="danger"
        onConfirm={() => void deleteDestination()}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
      />
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]"
      >
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}
