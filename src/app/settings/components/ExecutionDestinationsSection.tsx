'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { ExecutionDestinationIcon } from '@/components/task-delegation/ExecutionDestinationIcon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ConnectorBrandIcon } from './ConnectorBrandIcon';
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

interface ScoutConnector {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
}

interface ScoutWorker {
  id: string;
  name: string;
  enabled: boolean;
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
  companyName: string;
  projectId: string;
  assigneeAgentId: string;
  alwaysInstructions: string;
  capabilities: ExternalAgentCapabilities;
  allowedClassifications: AgentDataClassification[];
  enabled: boolean;
}

interface PaperclipDiscovery {
  health: { status: unknown; version: unknown; deploymentMode: unknown };
  companies: Array<{ id: string; name: string; status: string | null }>;
  projects: Array<{ id: string; name: string; status: string | null }>;
  agents: Array<{
    id: string;
    name: string;
    title: string | null;
    role: string | null;
    status: string | null;
    adapterType: string | null;
  }>;
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
    companyName: '',
    projectId: '',
    assigneeAgentId: '',
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
    companyName: paperclip?.companyName ?? '',
    projectId: paperclip?.projectId ?? '',
    assigneeAgentId: paperclip?.assigneeAgentId ?? '',
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

function ScoutDestinationCard() {
  const [connector, setConnector] = useState<ScoutConnector | null>(null);
  const [worker, setWorker] = useState<ScoutWorker | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupPrompt, setSetupPrompt] = useState('');
  const [copied, setCopied] = useState(false);

  const loadScout = useCallback(async () => {
    setError(null);
    try {
      const connectorsResponse = await fetch('/api/connectors');
      const connectorsBody = await connectorsResponse.json().catch(() => null) as {
        connectors?: ScoutConnector[];
        error?: string;
      } | null;
      if (!connectorsResponse.ok) {
        throw new Error(responseError(connectorsBody, connectorsResponse.status));
      }
      const nextConnector = (connectorsBody?.connectors ?? [])
        .find((candidate) => candidate.type === 'scout') ?? null;
      setConnector(nextConnector);
      if (!nextConnector) {
        setWorker(null);
        return;
      }

      const workerResponse = await fetch(
        `/api/scout/worker?connectorId=${encodeURIComponent(nextConnector.id)}`,
      );
      const workerBody = await workerResponse.json().catch(() => null) as {
        worker?: ScoutWorker | null;
        error?: string;
      } | null;
      if (!workerResponse.ok) {
        throw new Error(responseError(workerBody, workerResponse.status));
      }
      setWorker(workerBody?.worker ?? null);
    } catch (loadError) {
      const message = loadError instanceof Error
        ? loadError.message
        : 'Failed to load Scout status';
      setError(message);
      settingsLogger.error('Failed to load Scout execution status', { error: message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadScout();
    });
  }, [loadScout]);

  async function updateWorker(action: 'generate-setup' | 'disable') {
    if (!connector) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/scout/worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId: connector.id, action }),
      });
      const body = await response.json().catch(() => null) as {
        worker?: ScoutWorker | null;
        setupPrompt?: string;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(responseError(body, response.status));
      setWorker(body?.worker ?? null);
      setSetupPrompt(action === 'generate-setup' ? body?.setupPrompt ?? '' : '');
    } catch (updateError) {
      const message = updateError instanceof Error
        ? updateError.message
        : 'Failed to update Scout work pickup';
      setError(message);
      settingsLogger.error('Failed to update Scout work pickup', { error: message });
    } finally {
      setBusy(false);
    }
  }

  async function copySetupPrompt() {
    try {
      await navigator.clipboard.writeText(setupPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('The setup prompt could not be copied. Select it and copy it manually.');
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-20 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] text-sm text-[var(--text-muted)]">
        <Loader2 size={15} className="animate-spin" />
        Checking Microsoft Scout
      </div>
    );
  }

  if (error && !connector) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-red-800/40 bg-red-950/20 p-4 sm:flex-row sm:items-center">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-red-950/40 text-red-300">
          <AlertTriangle size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-200">Microsoft Scout status unavailable</p>
          <p className="mt-1 text-xs leading-5 text-red-300">{error}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadScout()}>
          <RefreshCw size={14} />
          Retry
        </Button>
      </div>
    );
  }

  if (!connector) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-1)] p-4 sm:flex-row sm:items-center">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
          <ConnectorBrandIcon type="scout" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">Microsoft Scout</p>
            <Badge variant="secondary">Not connected</Badge>
            <Badge variant="outline">Scheduled pickup</Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
            Connect Microsoft Scout to handle delegated work with authorized Microsoft 365 resources.
          </p>
        </div>
        <Button asChild type="button" variant="outline" size="sm">
          <Link href="/settings/connectors?setting=Scout">
            <Plus size={14} />
            Add Microsoft Scout
          </Link>
        </Button>
      </div>
    );
  }

  const pickupEnabled = worker?.enabled === true;

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
          <ConnectorBrandIcon type="scout" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-[var(--text-primary)]">
              {connector.name}
            </p>
            <Badge variant={pickupEnabled ? 'success' : 'secondary'}>
              {pickupEnabled ? 'Pickup enabled' : 'Pickup off'}
            </Badge>
            <Badge variant="outline">Scheduled pickup</Badge>
            {!connector.enabled && <Badge variant="warning">Connector paused</Badge>}
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
            Claims confirmed Mission Control delegations on Microsoft Scout&apos;s automation schedule.
            Inbound M365 sources remain managed by the connector.
          </p>
          <Link
            href="/settings/connectors?setting=Scout"
            className="mt-1 inline-flex text-[11px] font-medium text-[var(--accent)] underline-offset-4 hover:underline"
          >
            Manage Microsoft Scout connector
          </Link>
        </div>
        <div className="flex items-center gap-2 sm:justify-end">
          <Toggle
            enabled={pickupEnabled}
            disabled={busy}
            onChange={() => void updateWorker(pickupEnabled ? 'disable' : 'generate-setup')}
            label={`${pickupEnabled ? 'Disable' : 'Enable'} Microsoft Scout work pickup`}
          />
          {pickupEnabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void updateWorker('generate-setup')}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Rotate setup
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div role="status" className="border-t border-red-800/30 bg-red-950/20 px-4 py-3 text-xs text-red-300">
          {error}
        </div>
      )}

      {setupPrompt && (
        <div className="border-t border-[var(--border)] bg-[var(--surface-0)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-[var(--text-secondary)]">
                Finish setup in Microsoft Scout
              </p>
              <p className="mt-1 text-[11px] leading-4 text-amber-300">
                Pickup is registered in Mission Control, but Microsoft Scout will not claim work until this
                private setup prompt is applied.
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setSetupPrompt('')}>
                <EyeOff size={13} />
                Hide
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void copySetupPrompt()}>
                {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                {copied ? 'Copied' : 'Copy prompt'}
              </Button>
            </div>
          </div>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs leading-5 text-[var(--text-secondary)]">
            {setupPrompt}
          </pre>
        </div>
      )}
    </div>
  );
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
  const [paperclipDiscovery, setPaperclipDiscovery] = useState<PaperclipDiscovery | null>(null);
  const [checkingPaperclip, setCheckingPaperclip] = useState(false);
  const [paperclipCheckError, setPaperclipCheckError] = useState<string | null>(null);
  const paperclipCheckRef = useRef(0);

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
  const switchingCredentialSource = Boolean(
    form?.id
    && formDestination?.credentialSource !== form.credentialSource,
  );
  const duplicateFormRoutes = form?.type === 'paperclip' && form.companyId
    ? destinations.filter((destination) =>
      destination.type === 'paperclip'
      && destination.id !== form.id
      && destination.providerConfig.paperclip?.companyId === form.companyId)
    : [];

  function updateForm(patch: Partial<DestinationForm>) {
    setForm((current) => current ? { ...current, ...patch } : current);
  }

  function openForm(next: DestinationForm | null) {
    paperclipCheckRef.current += 1;
    setForm(next);
    setSaveError(null);
    setPaperclipDiscovery(null);
    setPaperclipCheckError(null);
    setCheckingPaperclip(false);
    setShowCredential(false);
  }

  function updatePaperclipConnection(patch: Partial<DestinationForm>) {
    paperclipCheckRef.current += 1;
    updateForm(patch);
    setPaperclipDiscovery(null);
    setPaperclipCheckError(null);
    setCheckingPaperclip(false);
  }

  async function requestPaperclipDiscovery(companyId?: string) {
    if (!form || form.type !== 'paperclip') return null;
    const response = await fetch('/api/external-agents/paperclip/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: form.endpoint.trim(),
        destinationId: form.id,
        companyId,
        ...(form.credentialSource === 'mission-control' && form.credential.trim()
          ? { credential: form.credential.trim() }
          : {}),
        ...(form.credentialSource === 'deployment-secret' && form.credentialRef.trim()
          ? { authCredentialRef: form.credentialRef.trim() }
          : {}),
      }),
    });
    const body = await response.json().catch(() => null) as PaperclipDiscovery | null;
    if (!response.ok) throw new Error(responseError(body, response.status));
    return body;
  }

  async function checkPaperclipConnection(companyId?: string) {
    if (!form || form.type !== 'paperclip') return;
    const requestId = ++paperclipCheckRef.current;
    setCheckingPaperclip(true);
    setPaperclipCheckError(null);
    try {
      const initial = await requestPaperclipDiscovery(companyId);
      if (!initial || requestId !== paperclipCheckRef.current) return;
      const selectedCompany = companyId
        ?? (
          initial.companies.some(({ id }) => id === form.companyId)
            ? form.companyId
            : initial.companies[0]?.id
        );
      const discovery = selectedCompany && !companyId
        ? await requestPaperclipDiscovery(selectedCompany)
        : initial;
      if (!discovery || requestId !== paperclipCheckRef.current) return;
      const selectedAgent = discovery.agents.some(({ id }) => id === form.assigneeAgentId)
        ? form.assigneeAgentId
        : discovery.agents[0]?.id ?? '';
      const selectedProject = discovery.projects.some(({ id }) => id === form.projectId)
        ? form.projectId
        : '';
      const selectedCompanyRecord = discovery.companies.find(({ id }) => id === selectedCompany);
      setPaperclipDiscovery(discovery);
      updateForm({
        companyId: selectedCompany ?? '',
        companyName: selectedCompanyRecord?.name ?? '',
        projectId: selectedProject,
        assigneeAgentId: selectedAgent,
      });
    } catch (error) {
      if (requestId !== paperclipCheckRef.current) return;
      setPaperclipCheckError(
        error instanceof Error ? error.message : 'Paperclip connection check failed',
      );
    } finally {
      if (requestId === paperclipCheckRef.current) {
        setCheckingPaperclip(false);
      }
    }
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
    const usesManagedCredential = form.credentialSource === 'mission-control';
    const paperclipUsesCredential = form.type === 'paperclip'
      && Boolean(
        credential
        || credentialRef
        || existing?.hasCredentialReference,
      );
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
      ...(usesManagedCredential && credential ? { credential } : {}),
      ...(!usesManagedCredential && credentialRef
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
            ...(form.companyName.trim() ? { companyName: form.companyName.trim() } : {}),
            assigneeAgentId: form.assigneeAgentId.trim(),
            ...(form.projectId.trim() ? { projectId: form.projectId.trim() } : {}),
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
      openForm(null);
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
      if (form?.id === deleteTarget.id) openForm(null);
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
              onClick={() => openForm(emptyForm('paperclip'))}
            >
              <ExecutionDestinationIcon type="paperclip" size={14} />
              Paperclip route
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => openForm(emptyForm('copilot-cloud'))}
            >
              <ExecutionDestinationIcon type="copilot-cloud" size={14} />
              GitHub Copilot Cloud
            </Button>
          </div>
        )}
      </div>

      <ScoutDestinationCard />

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
            No direct execution destinations yet
          </p>
          <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-[var(--text-muted)]">
            Add GitHub Copilot Cloud for GitHub-hosted Agent Tasks or bind a validated Paperclip
            route. Microsoft Scout scheduled pickup is shown separately above. Nothing is transmitted until
            a delegation preview is reviewed and confirmed.
          </p>
        </div>
      ) : destinations.length > 0 ? (
        <div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
          {destinations.map((destination) => {
            const paperclip = destination.providerConfig.paperclip;
            const duplicateCompanyRoutes = paperclip
              ? destinations.filter((candidate) =>
                candidate.type === 'paperclip'
                && candidate.providerConfig.paperclip?.companyId === paperclip.companyId)
              : [];
            return (
              <div key={destination.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
                  <ExecutionDestinationIcon type={destination.type} />
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
                    {duplicateCompanyRoutes.length > 1 && (
                      <Badge variant="warning">
                        {duplicateCompanyRoutes.length} routes for this company
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                    {destination.description
                      || (destination.type === 'copilot-cloud'
                        ? 'GitHub-hosted execution using the official Agent Tasks API.'
                        : `${destination.endpoint} · ${paperclip?.companyName
                          ?? `company ${paperclip?.companyId ?? 'not bound'}`}`)}
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
                      openForm(editForm(destination));
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
                  ? 'Use a fine-grained GitHub personal access token. Mission Control validates it with GitHub, stores it server-side, and never returns it to the browser.'
                  : 'Check the Paperclip URL and credential first, then choose route defaults from the validated options. Delegation can override these defaults for one dispatch.'}
              </p>
            </div>
            <Badge variant="outline">
              <ExecutionDestinationIcon type={form.type} size={13} />
              {destinationLabel(form.type)}
            </Badge>
          </div>

          {form.type === 'paperclip' && (
            <div className="flex gap-3 rounded-lg border border-[var(--accent-500)]/30 bg-[var(--accent-500)]/8 p-3">
              <Bot size={18} className="mt-0.5 shrink-0 text-[var(--accent-300)]" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  Use one integration agent per Paperclip company
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                  Recommended: create a dedicated <strong>Mission Control Dispatcher</strong>{' '}
                  agent with standard trust, then use its API key here. It needs company roster
                  visibility and task assignment access. A CEO key works, but is not required.
                </p>
                <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">
                  In Paperclip: Agents → select the integration agent → Governance → API Keys.
                  One registered route can discover and delegate to eligible agents across that
                  company.
                </p>
              </div>
            </div>
          )}

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
            <Field label="Credential source" htmlFor="destination-credential-source">
              <Select
                value={form.credentialSource}
                onValueChange={(value) => {
                  const update = {
                    credentialSource: value as DestinationForm['credentialSource'],
                    credential: '',
                    credentialRef: '',
                  };
                  if (form.type === 'paperclip') {
                    updatePaperclipConnection(update);
                  } else {
                    updateForm(update);
                  }
                }}
              >
                <SelectTrigger id="destination-credential-source" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mission-control">
                    {form.type === 'copilot-cloud'
                      ? 'Fine-grained personal access token'
                      : 'Agent API key'}
                  </SelectItem>
                  <SelectItem value="deployment-secret">
                    Deployment secret reference
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {form.credentialSource === 'mission-control' && (
            <Field
              label={form.type === 'copilot-cloud' ? 'Fine-grained personal access token' : 'Agent API key'}
              htmlFor="github-cloud-token"
              hint={form.id && !switchingCredentialSource
                ? 'Leave blank to keep the currently stored token.'
                : form.type === 'copilot-cloud'
                  ? 'Required. Configure the repository access and permissions listed below.'
                  : 'Required for remote Paperclip. Trusted local endpoints may be checked without a token.'}
            >
              <div className="relative">
                <input
                  id="github-cloud-token"
                  type={showCredential ? 'text' : 'password'}
                  required={
                    (form.type === 'copilot-cloud' && !form.id)
                    || switchingCredentialSource
                  }
                  autoComplete="new-password"
                  value={form.credential}
                  onChange={(event) => form.type === 'paperclip'
                    ? updatePaperclipConnection({ credential: event.target.value })
                    : updateForm({ credential: event.target.value })}
                  placeholder={form.id && !switchingCredentialSource
                    ? 'Current token is hidden'
                    : form.type === 'copilot-cloud' ? 'github_pat_...' : 'Paste the agent API key'}
                  className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 pr-10 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowCredential((current) => !current)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                  aria-label={`${showCredential ? 'Hide' : 'Show'} ${
                    form.type === 'copilot-cloud' ? 'personal access token' : 'agent API key'
                  }`}
                >
                  {showCredential ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {form.type === 'copilot-cloud' && (
                <>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-[var(--text-muted)]">
                    <li>
                      <span className="font-medium text-[var(--text-secondary)]">Repository access:</span>{' '}
                      Select only the repositories you will delegate to.
                    </li>
                    <li>
                      <span className="font-medium text-[var(--text-secondary)]">Repository permissions:</span>{' '}
                      Agent tasks — Read and write; Contents — Read-only; Pull requests — Read-only.
                    </li>
                    <li>
                      <span className="font-medium text-[var(--text-secondary)]">Account permissions:</span>{' '}
                      None.
                    </li>
                  </ul>
                  <div className="mt-2 text-xs">
                    <a
                      href="https://github.com/settings/personal-access-tokens/new"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                    >
                      Create fine-grained token <ExternalLink size={11} />
                    </a>
                  </div>
                </>
              )}
            </Field>
          )}

          {form.credentialSource === 'deployment-secret' && (
            <Field
              label="Deployment secret reference"
              htmlFor="destination-credential"
              hint={form.id && !switchingCredentialSource
                ? 'Leave blank to keep the current reference.'
                : 'Required. Key in MC_EXTERNAL_AGENT_CREDENTIALS_JSON.'}
            >
              <input
                id="destination-credential"
                required={!form.id || switchingCredentialSource}
                maxLength={200}
                autoComplete="off"
                value={form.credentialRef}
                onChange={(event) => form.type === 'paperclip'
                  ? updatePaperclipConnection({ credentialRef: event.target.value })
                  : updateForm({ credentialRef: event.target.value })}
                placeholder={form.id && !switchingCredentialSource
                  ? 'Current reference is hidden'
                  : form.type === 'copilot-cloud' ? 'github-agent-user' : 'paperclip-token'}
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
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
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
                    onChange={(event) => updatePaperclipConnection({
                      endpoint: event.target.value,
                    })}
                    placeholder="https://paperclip.example.com"
                    className="input-glow w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void checkPaperclipConnection()}
                  disabled={checkingPaperclip || !form.endpoint.trim()}
                  className="w-full sm:w-auto"
                >
                  {checkingPaperclip
                    ? <Loader2 size={14} className="animate-spin" />
                    : <RefreshCw size={14} />}
                  {checkingPaperclip ? 'Checking...' : 'Check connection'}
                </Button>
              </div>
              {paperclipCheckError && (
                <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-800/40 bg-red-950/20 p-3 text-sm text-red-300">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>{paperclipCheckError}</span>
                </div>
              )}
              {paperclipDiscovery ? (
                <>
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
                    <CheckCircle2 size={15} />
                    Connected · company roster visibility verified
                    {paperclipDiscovery.health.version
                      ? ` · Paperclip ${String(paperclipDiscovery.health.version)}`
                      : ''}
                  </div>
                  {duplicateFormRoutes.length > 0 && (
                    <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 p-3 text-xs leading-5 text-amber-200">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      <span>
                        {duplicateFormRoutes.length === 1
                          ? `${duplicateFormRoutes[0].name} already connects this company.`
                          : `${duplicateFormRoutes.length} other routes already connect this company.`}{' '}
                        One route is normally sufficient. If you keep duplicates, the delegation
                        wizard will group them under this company and let you choose the connection.
                      </span>
                    </div>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Paperclip company"
                      htmlFor="paperclip-company"
                      hint="This route represents one company. Register another route for another company."
                    >
                      <Select
                        value={form.companyId}
                        onValueChange={(value) => void checkPaperclipConnection(value)}
                      >
                        <SelectTrigger id="paperclip-company" className="w-full">
                          <SelectValue placeholder="Choose a company" />
                        </SelectTrigger>
                        <SelectContent>
                          {paperclipDiscovery.companies.map((company) => (
                            <SelectItem key={company.id} value={company.id}>
                              {company.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field
                      label="Default project"
                      htmlFor="paperclip-project"
                      hint="Optional. Can be changed for one delegation."
                    >
                      <Select
                        value={form.projectId || '__none__'}
                        onValueChange={(value) => updateForm({
                          projectId: value === '__none__' ? '' : value,
                        })}
                      >
                        <SelectTrigger id="paperclip-project" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">No default project</SelectItem>
                          {paperclipDiscovery.projects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field
                      label="Default assignee"
                      htmlFor="paperclip-agent"
                      hint="The API-key owner is the integration identity. This chooses who receives work by default."
                    >
                      <Select
                        value={form.assigneeAgentId}
                        onValueChange={(value) => updateForm({ assigneeAgentId: value })}
                      >
                        <SelectTrigger id="paperclip-agent" className="w-full">
                          <SelectValue placeholder="Choose an agent" />
                        </SelectTrigger>
                        <SelectContent>
                          {paperclipDiscovery.agents.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {agent.name}{agent.title ? ` · ${agent.title}` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </>
              ) : (
                <p className="rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-3 text-xs leading-5 text-[var(--text-muted)]">
                  Check the connection to verify company roster access and load projects and agents.
                </p>
              )}
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
              onClick={() => openForm(null)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                saving
                || checkingPaperclip
                || (form.type === 'paperclip' && !form.id && !paperclipDiscovery)
              }
            >
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
