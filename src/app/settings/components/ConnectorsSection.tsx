'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plug, RefreshCw, ChevronRight, Trash2, Loader2, Shield, Circle,
  Plus, AlertTriangle, FolderOpen, Zap, Save, Activity,
  Clock, Check, CheckCircle2, X, XCircle, RotateCcw,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  staggerContainer, fadeSlideUp,
} from '@/lib/motion';
import { settingsLogger } from '@/lib/client-logger';
import type { ConnectorConfig, SourceList } from './types';
import {
  getConnectorDisplayName,
  isFinanceConnectorType,
  isSourceListSelected,
} from './types';
import { ConnectorBrandIcon } from './ConnectorBrandIcon';
import {
  ConnectionStatus,
  type ConnectorHealthState,
} from './ConnectionStatus';
import { useConnectorHealth } from './useConnectorHealth';
import { SyncHealthBanner } from './SyncHealthBanner';
import { LabelHealthPanel } from './LabelHealthPanel';
import { isMicroStatusSyncEnabled } from '@/lib/micro-status';
import { getConnectorNameUpdate } from '@/lib/connectors/display-name';
import {
  LEGACY_SCOUT_SETTINGS,
  SCOUT_SOURCE_TYPES,
  parseScoutSettings,
  type ScoutConnectorSettings,
  type ScoutSourceType,
} from '@/lib/connectors/scout/settings';
import { WorkTodoBridgePanel } from './WorkTodoBridgePanel';
import { defaultTyrionBridgeUrlForEnvironment } from '@/lib/connectors/monarch-money/constants';

const SYNC_MODE_OPTIONS = [
  { value: 'poll', label: 'Polling' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'manual', label: 'Manual Only' },
];

const POLL_INTERVAL_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '60 min' },
];

const CAPABILITY_KEYS = ['read', 'write', 'delete', 'sync', 'lists', 'subtasks', 'tags', 'tagWriteBack'];
const LOCKED_CAPABILITIES = new Set(['read', 'sync', 'lists', 'subtasks']);
const TOGGLEABLE_CAPABILITIES = CAPABILITY_KEYS.filter(k => !LOCKED_CAPABILITIES.has(k));
const SCOUT_SOURCE_LABELS: Record<ScoutSourceType, string> = {
  email: 'Email',
  teams: 'Teams',
  meeting: 'Meetings',
  planner: 'Planner',
  'cross-source': 'Cross-source',
};

function asSettingsRecord(settings: ConnectorConfig['settings']): Record<string, unknown> {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) return settings;
  if (typeof settings === 'string') {
    try {
      const parsed = JSON.parse(settings);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

// --- Connectors Section ----------------------------------------------------

function ConnectorsSection({
  connectors, sourceLists, loading, syncing, onToggle, onSync, onDelete, onUpdate, onAdd, selectedConnector, onSelect,
  deletedConnectors, onRestore, onPermanentDelete,
}: {
  connectors: ConnectorConfig[];
  sourceLists: SourceList[];
  loading: boolean;
  syncing: string | null;
  onToggle: (id: string, enabled: boolean) => void;
  onSync: (id?: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<ConnectorConfig>) => Promise<void>;
  onAdd: () => void;
  selectedConnector: string | null;
  onSelect: (id: string | null) => void;
  deletedConnectors: ConnectorConfig[];
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; message: string; confirmLabel: string; variant: 'danger' | 'warning'; onConfirm: () => void }>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });
  const { getHealthState, refreshHealth } = useConnectorHealth(connectors);

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold text-[var(--text-primary)]">Connectors</h2>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            Manage data source connections. Each connector syncs tasks and/or alerts.
          </p>
        </div>
        <motion.button
          onClick={onAdd}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 font-medium flex items-center gap-2 shadow-md shadow-blue-900/20"
        >
          <Plus size={14} /> Add Connector
        </motion.button>
      </div>

      <SyncHealthBanner />

      {loading ? (
        <div className="flex items-center justify-center gap-2 text-[var(--text-muted)] py-12">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading connectors...</span>
        </div>
      ) : connectors.length === 0 ? (
        <motion.div {...fadeSlideUp} className="bg-[var(--surface-1)] border border-dashed border-[var(--border-strong)] rounded-xl p-10 text-center">
          <Plug size={32} className="mx-auto text-[var(--text-muted)] mb-3" />
          <p className="text-base text-[var(--text-tertiary)] mb-1">No connectors configured</p>
          <p className="text-sm text-[var(--text-muted)]">Click &quot;Add Connector&quot; to get started.</p>
        </motion.div>
      ) : (
        <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-3">
          {connectors.map(conn => {
           const isExpanded = selectedConnector === conn.id;
           const isSyncing = syncing === conn.id;
           const connSourceLists = sourceLists.filter(sl => sl.connectorInstanceId === conn.id);
           const healthState = getHealthState(conn);

           return (
             <motion.div
               key={conn.id}
               variants={fadeSlideUp}
               layout
               className={`bg-[var(--surface-1)] border rounded-xl overflow-hidden transition-colors ${
                 !conn.enabled ? 'opacity-60 border-[var(--border)]' :
                 isExpanded ? 'border-blue-500/40 ring-1 ring-blue-500/20' : 'border-[var(--border)] hover:border-[var(--border-strong)]'
               }`}
             >
               {/* Header */}
               <div className="px-4 py-3 flex items-center gap-3 cursor-pointer" onClick={() => onSelect(isExpanded ? null : conn.id)}>
                 <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                   conn.enabled ? 'bg-[var(--surface-2)]' : 'bg-[var(--surface-2)] opacity-50'
                 }`}>
                   <ConnectorBrandIcon type={conn.type} size={20} />
                 </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">{getConnectorDisplayName(conn)}</span>
                      <ConnectionStatus connector={conn} healthState={healthState} />
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-[var(--text-muted)]">
                      {conn.enabled ? (
                        conn.type === 'scout' ? (
                          <>
                            <span className="flex items-center gap-1"><Zap size={10} /> MCP push</span>
                            <span>{connSourceLists.length} source{connSourceLists.length !== 1 ? 's' : ''}</span>
                          </>
                        ) : (
                          <>
                            <span className="flex items-center gap-1"><Clock size={10} /> {conn.syncMode}</span>
                            {conn.pollIntervalMinutes && <span>Every {conn.pollIntervalMinutes}min</span>}
                            <span>{connSourceLists.length} source{connSourceLists.length !== 1 ? 's' : ''}</span>
                          </>
                        )
                      ) : (
                        <span>Paused -- enable to {conn.type === 'scout' ? 'accept pushes' : 'activate syncing'}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {conn.enabled && conn.type !== 'scout' && (
                      <button onClick={(e) => { e.stopPropagation(); onSync(conn.id); }}
                        disabled={!!isSyncing}
                        className="p-1.5 border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] disabled:opacity-50 transition-colors"
                        title="Sync now">
                        <RefreshCw size={12} className={isSyncing ? 'animate-spin text-blue-400' : 'text-[var(--text-muted)]'} />
                      </button>
                    )}
                    <label className="relative inline-flex items-center cursor-pointer" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={conn.enabled} onChange={e => onToggle(conn.id, e.target.checked)}
                        className="sr-only peer" />
                      <div className="w-9 h-5 bg-[var(--surface-3)] rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-full"></div>
                    </label>
                    <motion.div
                      animate={{ rotate: isExpanded ? 90 : 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <ChevronRight size={14} className="text-[var(--text-muted)]" />
                    </motion.div>
                  </div>
                </div>

                {/* Expanded Editable Config */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <ConnectorEditPanel
                        connector={conn}
                        sourceLists={connSourceLists}
                        onUpdate={onUpdate}
                        onDelete={onDelete}
                        confirmDelete={confirmDelete}
                        setConfirmDelete={setConfirmDelete}
                        healthState={healthState}
                        onHealthRefresh={refreshHealth}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      {/* Recently Deleted */}
      {deletedConnectors.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-3 flex items-center gap-2">
            <Trash2 size={12} />
            Recently Deleted
          </h3>
          <p className="text-xs text-[var(--text-muted)] mb-3">
            Deleted connectors are kept for 7 days. Tasks and source lists remain in the database until permanently removed.
          </p>
          <div className="space-y-2">
            {deletedConnectors.map(conn => {
              const daysSinceDelete = conn.deletedAt
                ? Math.floor((Date.now() - new Date(conn.deletedAt).getTime()) / (1000 * 60 * 60 * 24))
                : 0;
              const daysRemaining = Math.max(0, 7 - daysSinceDelete);

              return (
                <div
                  key={conn.id}
                  className="flex items-center justify-between rounded-lg border border-red-900/30 bg-red-950/20 px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="opacity-40">
                      <ConnectorBrandIcon type={conn.type} size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm text-[var(--text-secondary)] truncate">{getConnectorDisplayName(conn)}</div>
                      <div className="text-xs text-[var(--text-muted)]">
                        Deleted {conn.deletedAt ? new Date(conn.deletedAt).toLocaleDateString() : 'recently'}
                        {daysRemaining > 0 && ` · ${daysRemaining}d until permanent removal`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <motion.button
                      whileTap={{ scale: 0.96 }}
                      onClick={() => onRestore(conn.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 transition-colors flex items-center gap-1.5"
                    >
                      <RotateCcw size={11} />
                      Restore
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.96 }}
                      onClick={() => {
                        setConfirmDialog({
                          open: true,
                          title: 'Permanently delete connector?',
                          message: `Permanently delete "${getConnectorDisplayName(conn)}"? This cannot be undone.`,
                          confirmLabel: 'Delete Forever',
                          variant: 'danger',
                          onConfirm: () => {
                            setConfirmDialog((d) => ({ ...d, open: false }));
                            onPermanentDelete(conn.id);
                          },
                        });
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors flex items-center gap-1.5"
                    >
                      <Trash2 size={11} />
                      Delete Forever
                    </motion.button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />
    </>
  );
}

// --- Scout Connector Panel -------------------------------------------------

function ScoutEditPanel({
  connector, sourceLists, onUpdate, onDelete, confirmDelete, setConfirmDelete,
}: {
  connector: ConnectorConfig;
  sourceLists: SourceList[];
  onUpdate: (id: string, updates: Partial<ConnectorConfig>) => Promise<void>;
  onDelete: (id: string) => void;
  confirmDelete: string | null;
  setConfirmDelete: (id: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<ScoutConnectorSettings>(
    () => parseScoutSettings(connector.settings, LEGACY_SCOUT_SETTINGS),
  );
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  const mcpSnippet = JSON.stringify({
    'mission-control': {
      type: 'streamable-http',
      url: 'https://mission-control.example/api/mcp',
    },
  }, null, 2);

  function handleCopy() {
    navigator.clipboard.writeText(mcpSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/hub-projects?includeHidden=true')
      .then(async response => {
        if (!response.ok) throw new Error('Failed to load projects');
        return response.json() as Promise<{ projects?: Array<{ id: string; name: string }> }>;
      })
      .then(data => {
        if (!cancelled) setProjects(data.projects || []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function updateDraft(updates: Partial<ScoutConnectorSettings>) {
    setDraft(current => ({ ...current, ...updates }));
    setDirty(true);
    setSaved(false);
    setSaveError('');
  }

  function toggleSource(sourceType: ScoutSourceType) {
    updateDraft({
      allowedSourceTypes: draft.allowedSourceTypes.includes(sourceType)
        ? draft.allowedSourceTypes.filter(value => value !== sourceType)
        : [...draft.allowedSourceTypes, sourceType],
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError('');
    try {
      await onUpdate(connector.id, {
        settings: {
          ...asSettingsRecord(connector.settings),
          ...draft,
        },
      });
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save Scout settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-[var(--border-subtle)] px-4 py-4 bg-[var(--surface-0)]">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: About & MCP Config */}
        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
              Landing Mode
            </label>
            <Select
              value={draft.landingMode}
              disabled={saving}
              onValueChange={value => updateDraft({
                landingMode: value as ScoutConnectorSettings['landingMode'],
              })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">Direct — create tasks immediately</SelectItem>
                <SelectItem value="triage">Triage — review every item</SelectItem>
                <SelectItem value="hybrid">Hybrid — route by confidence</SelectItem>
              </SelectContent>
            </Select>
            {draft.landingMode === 'hybrid' && (
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between text-xs text-[var(--text-secondary)]">
                  <span>Direct-push confidence</span>
                  <span className="tabular-nums">{Math.round(draft.hybridConfidenceThreshold * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={draft.hybridConfidenceThreshold}
                  disabled={saving}
                  onChange={event => updateDraft({
                    hybridConfidenceThreshold: Number(event.target.value),
                  })}
                  className="w-full accent-[var(--accent)]"
                  aria-label="Hybrid direct-push confidence threshold"
                />
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Items below this confidence go to Triage.
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">How It Works</label>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Scout is a <strong>push-only</strong> AI agent connector. It scans your M365 environment
              (email, Teams, meetings, Planner) and pushes curated action items into Mission Control
              via MCP. No polling — tasks arrive as Scout finds them.
            </p>
          </div>

          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
              MCP Config Snippet
            </label>
            <p className="text-xs text-[var(--text-muted)] mb-2">
              Add this to your MCP client config (e.g. Copilot, Claude Desktop, etc.):
            </p>
            <div className="relative">
              <pre className="bg-[var(--surface-2)] border border-[var(--border-subtle)] rounded-lg p-3 text-xs font-mono text-[var(--text-secondary)] overflow-x-auto whitespace-pre">
                {mcpSnippet}
              </pre>
              <button
                onClick={handleCopy}
                className="absolute top-2 right-2 px-2 py-1 text-[10px] font-medium rounded bg-[var(--surface-3)] hover:bg-[var(--surface-4)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-[var(--border-subtle)] transition-colors"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block flex items-center gap-1.5">
              <Shield size={10} /> Capabilities
            </label>
            <div className="flex flex-wrap gap-1.5">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-green-900/30 text-green-400 border border-green-800/40">
                <Check size={10} /> Push ingest
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-green-900/30 text-green-400 border border-green-800/40">
                <Check size={10} /> Auto-tagging
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-green-900/30 text-green-400 border border-green-800/40">
                <Check size={10} /> Dedup / cross-link
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-zinc-800/50 text-zinc-500 border border-zinc-700/40">
                <X size={10} /> Write-back
              </span>
            </div>
          </div>
        </div>

        {/* Right Column: Source Lists & Status */}
        <div className="space-y-4">
          <div>
            <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2">
              Allowed Sources
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {SCOUT_SOURCE_TYPES.map(sourceType => (
                <label
                  key={sourceType}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2.5 py-2 text-xs text-[var(--text-secondary)]"
                >
                  <input
                    type="checkbox"
                    checked={draft.allowedSourceTypes.includes(sourceType)}
                    disabled={saving}
                    onChange={() => toggleSource(sourceType)}
                    className="accent-[var(--accent)]"
                  />
                  {SCOUT_SOURCE_LABELS[sourceType]}
                </label>
              ))}
            </div>
            {draft.allowedSourceTypes.length === 0 && (
              <p className="mt-2 text-xs text-amber-400">All incoming Scout items will be skipped.</p>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
              Default Project
            </label>
            <Select
              value={draft.autoProjectId || 'none'}
              onValueChange={value => updateDraft({ autoProjectId: value === 'none' ? null : value })}
              disabled={projectsLoading || saving}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={projectsLoading ? 'Loading projects...' : 'No default project'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No default project</SelectItem>
                {projects.map(project => (
                  <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Used when Scout does not provide a suggested project.
            </p>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 flex items-center gap-1.5">
              <Zap size={10} /> Source Lists
            </h4>
            <div className="space-y-1.5">
              {sourceLists.map(sl => (
                <div key={sl.id} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
                    <span className="truncate text-xs text-[var(--text-primary)]">{sl.name}</span>
                    <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--accent)] font-medium">
                      {sl.type}
                    </span>
                    <span className="text-xs text-[var(--text-muted)] tabular-nums ml-auto">{sl.taskCount}</span>
                  </div>
                </div>
              ))}
              {sourceLists.length === 0 && (
                <p className="text-xs text-[var(--text-muted)] italic">Source lists are auto-created on first push</p>
              )}
            </div>
          </div>

          {/* Connector metadata */}
          <div className="pt-2 border-t border-[var(--border-subtle)] text-xs text-[var(--text-muted)] space-y-1">
            <div>Mode: <code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">push-only (MCP)</code></div>
            <div>Created: {new Date(connector.createdAt).toLocaleDateString()}</div>
            <div>ID: <code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">{connector.id}</code></div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-4 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between">
        <div>
          <p className="text-xs text-[var(--text-muted)]">
            Disable the toggle above to reject future Scout pushes.
          </p>
          {saveError && <p className="mt-1 text-xs text-red-400">{saveError}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : saved ? <Check size={11} /> : <Save size={11} />}
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save Settings'}
          </button>
          {confirmDelete === connector.id ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-400">Remove Scout connector?</span>
              <button onClick={() => onDelete(connector.id)}
                className="px-2 py-1 text-xs font-medium rounded bg-red-900/40 hover:bg-red-900/60 text-red-400 border border-red-800/40">
                Remove
              </button>
              <button onClick={() => setConfirmDelete(null)}
                className="px-2 py-1 text-xs font-medium rounded bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)]">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(connector.id); }}
              className="p-1.5 rounded-md hover:bg-red-900/20 text-[var(--text-muted)] hover:text-red-400 transition-colors"
              title="Remove connector">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectorEditPanel(props: {
  connector: ConnectorConfig;
  sourceLists: SourceList[];
  onUpdate: (id: string, updates: Partial<ConnectorConfig>) => Promise<void>;
  onDelete: (id: string) => void;
  confirmDelete: string | null;
  setConfirmDelete: (id: string | null) => void;
  healthState?: ConnectorHealthState;
  onHealthRefresh: (id: string) => void;
}) {
  if (props.connector.type === 'scout') {
    return (
      <ScoutEditPanel
        connector={props.connector}
        sourceLists={props.sourceLists}
        onUpdate={props.onUpdate}
        onDelete={props.onDelete}
        confirmDelete={props.confirmDelete}
        setConfirmDelete={props.setConfirmDelete}
      />
    );
  }
  if (props.connector.type === 'microsoft-todo-work') {
    return (
      <WorkTodoBridgePanel
        connector={props.connector}
        sourceLists={props.sourceLists}
        onUpdate={props.onUpdate}
        onDelete={props.onDelete}
      />
    );
  }

  return <DefaultConnectorEditPanel {...props} />;
}

function DefaultConnectorEditPanel({
  connector, sourceLists, onUpdate, onDelete, confirmDelete, setConfirmDelete, healthState, onHealthRefresh,
}: {
  connector: ConnectorConfig;
  sourceLists: SourceList[];
  onUpdate: (id: string, updates: Partial<ConnectorConfig>) => Promise<void>;
  onDelete: (id: string) => void;
  confirmDelete: string | null;
  setConfirmDelete: (id: string | null) => void;
  healthState?: ConnectorHealthState;
  onHealthRefresh: (id: string) => void;
}) {
  const [editSyncMode, setEditSyncMode] = useState(connector.syncMode);
  const [editInterval, setEditInterval] = useState(connector.pollIntervalMinutes || 5);
  const [editCaps, setEditCaps] = useState<Record<string, boolean>>(connector.capabilities || {});
  const [editName, setEditName] = useState(getConnectorDisplayName(connector));
  const [editNameChanged, setEditNameChanged] = useState(false);
  const connectorSettings = typeof connector.settings === 'string'
    ? JSON.parse(connector.settings)
    : ((connector.settings || {}) as Record<string, unknown>);
  const isFinanceConnector = isFinanceConnectorType(connector.type);
  const [editBridgeUrl, setEditBridgeUrl] = useState(
    typeof connectorSettings.bridgeUrl === 'string'
      ? connectorSettings.bridgeUrl
      : defaultTyrionBridgeUrlForEnvironment(process.env.NODE_ENV)
  );
  const isGitHubConnector = connector.type === 'github-issues';
  const [editFetchNotifications, setEditFetchNotifications] = useState(
    typeof connectorSettings.fetchNotifications === 'boolean'
      ? connectorSettings.fetchNotifications
      : true
  );
  const supportsMicroStatusSync = connector.capabilities?.microStatusSync === true;
  const [editSyncMicroStatus, setEditSyncMicroStatus] = useState(
    isMicroStatusSyncEnabled(connectorSettings)
  );
  const [newRepoInput, setNewRepoInput] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const [repoError, setRepoError] = useState('');
  const currentRepos: string[] = Array.isArray(connectorSettings.repos) ? connectorSettings.repos : [];
  const [editRepos, setEditRepos] = useState<string[]>(currentRepos);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; latencyMs?: number; error?: string; details?: string } | null>(null);

  // GitHub token scope probe
  const [ghScopes, setGhScopes] = useState<Array<{ scope: string; label: string; description: string; granted: boolean; required: boolean }> | null>(null);
  const [ghScopeLoading, setGhScopeLoading] = useState(false);
  const [ghTokenType, setGhTokenType] = useState<'classic' | 'fine-grained' | 'unknown'>('unknown');

  // Document Intelligence module health
  const isDiConnector = connector.type === 'document-intelligence';
  const diHealth = healthState?.data || null;
  const diHealthLoading = isDiConnector && !healthState;

  useEffect(() => {
    if (!isGitHubConnector) return;
    setGhScopeLoading(true);
    fetch(`/api/connectors/${connector.id}/permissions`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.scopes) {
          setGhScopes(data.scopes);
          setGhTokenType(data.tokenType || 'unknown');
        }
      })
      .catch(() => { /* silently fail — permissions section won't render */ })
      .finally(() => setGhScopeLoading(false));
  }, [isGitHubConnector, connector.id]);

  function markDirty() { setDirty(true); setSaved(false); }

  function toggleCap(key: string) {
    setEditCaps(prev => ({ ...prev, [key]: !prev[key] }));
    markDirty();
  }

  async function handleSave() {
    setSaving(true);
    setSaveError('');
    const updates: Partial<ConnectorConfig> = {
      name: getConnectorNameUpdate(connector, editName, editNameChanged),
      syncMode: editSyncMode,
      pollIntervalMinutes: editSyncMode === 'poll' ? editInterval : null,
      capabilities: editCaps,
    };

    if (supportsMicroStatusSync) {
      updates.settings = {
        ...connectorSettings,
        syncMicroStatus: editSyncMicroStatus,
      };
    }

    if (isFinanceConnector) {
      updates.settings = {
        ...connectorSettings,
        bridgeUrl: editBridgeUrl.trim(),
      };
    }

    if (isGitHubConnector) {
      updates.settings = {
        ...connectorSettings,
        ...(updates.settings || {}),
        fetchNotifications: editFetchNotifications,
        repos: editRepos,
      };
      updates.syncedLists = editRepos;
    }

    try {
      await onUpdate(connector.id, updates);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      if (isGitHubConnector) {
        setEditRepos(currentRepos);
        setNewRepoInput('');
        setRepoError('');
      }
      setSaveError(error instanceof Error ? error.message : 'Failed to save connector');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/connectors/${connector.id}/test`, { method: 'POST' });
      const data = await res.json();
      setTestResult(data);
      if (isDiConnector) {
        onHealthRefresh(connector.id);
      }
    } catch {
      setTestResult({ success: false, error: 'Request failed' });
    }
    setTesting(false);
    setTimeout(() => setTestResult(null), 8000);
  }

  async function handleAddRepo() {
    const repo = newRepoInput.trim();
    if (!repo) return;

    // Validate format
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      setRepoError('Use owner/repo format (e.g. facebook/react)');
      return;
    }

    // Check not already added
    if (editRepos.includes(repo)) {
      setRepoError('Repository already added');
      return;
    }

    // Validate repo exists via server-side API (keeps token out of the browser)
    setAddingRepo(true);
    setRepoError('');
    try {
      const res = await fetch(`/api/connectors/${connector.id}/validate-repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo }),
      });
      const data = await res.json();
      if (!data.valid) {
        setRepoError(data.error || 'Repository not found');
        setAddingRepo(false);
        return;
      }
      setEditRepos(prev => [...prev, repo]);
      setNewRepoInput('');
      markDirty();
    } catch {
      setRepoError('Failed to validate repository');
    }
    setAddingRepo(false);
  }

  return (
    <div className="border-t border-[var(--border-subtle)] px-4 py-4 bg-[var(--surface-0)]">
      <div className="grid grid-cols-2 gap-6">
        {/* Left Column: Config */}
        <div className="space-y-4">
          {/* Display Name */}
          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">Display Name</label>
            <input
              type="text"
              value={editName}
              onChange={e => { setEditName(e.target.value); setEditNameChanged(true); markDirty(); }}
              className="w-full px-3 py-1.5 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none"
            />
          </div>

          {isFinanceConnector && (
            <div>
              <label htmlFor={`tyrion-bridge-url-${connector.id}`} className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
                Tyrion Bridge API URL
              </label>
              <input
                id={`tyrion-bridge-url-${connector.id}`}
                type="url"
                maxLength={2048}
                required
                value={editBridgeUrl}
                onChange={(event) => { setEditBridgeUrl(event.target.value); markDirty(); }}
                className="w-full px-3 py-1.5 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none"
              />
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Include the approved versioned gateway path; the bare operations UI and browser proxy are not connector APIs.
              </p>
            </div>
          )}

          {/* Connector Feature Summary */}
          <div>
           <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">Feeds</label>
           <div className="flex flex-wrap gap-1.5">
             <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full border ${editCaps.read ? 'bg-green-900/30 text-green-400 border-green-800/40' : 'bg-zinc-800/50 text-zinc-500 border-zinc-700/40'}`}>
               {editCaps.read ? <Check size={10} /> : <X size={10} />} Alerts
             </span>
             <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full border ${editCaps.write ? 'bg-green-900/30 text-green-400 border-green-800/40' : 'bg-zinc-800/50 text-zinc-500 border-zinc-700/40'}`}>
               {editCaps.write ? <Check size={10} /> : <X size={10} />} Tasks
             </span>
             <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full border ${editCaps.write ? 'bg-green-900/30 text-green-400 border-green-800/40' : 'bg-zinc-800/50 text-zinc-500 border-zinc-700/40'}`}>
               {editCaps.write ? <Check size={10} /> : <X size={10} />} Write-back
             </span>
             {connector.type === 'outlook-calendar' && (
               <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-amber-900/30 text-amber-400 border border-amber-800/40"><Check size={10} /> Timeline</span>
             )}
           </div>
           {editCaps.read && !editCaps.write && (
             <p className="mt-1.5 text-[12px] text-[var(--text-muted)]">
               Read-only — this connector surfaces alerts but cannot create or modify tasks.
             </p>
           )}
          </div>

          {isGitHubConnector && (
            <div>
              <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
                Alerts
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3 cursor-pointer hover:border-[var(--border-strong)] transition-colors">
                <input
                  type="checkbox"
                  checked={editFetchNotifications}
                  onChange={e => { setEditFetchNotifications(e.target.checked); markDirty(); }}
                  className="mt-0.5 h-4 w-4 rounded border-[var(--border-strong)] bg-[var(--surface-0)] text-blue-600 focus:ring-2 focus:ring-blue-500/50"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-[var(--text-primary)]">Sync GitHub notifications as alerts</span>
                  <span className="mt-1 block text-xs text-[var(--text-muted)]">
                    Pull review requests, mentions, CI activity, security alerts, and other notification threads into Mission Control alerts.
                  </span>
                </span>
              </label>
            </div>
          )}

          {supportsMicroStatusSync && (
            <div>
              <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
                Status reasons
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3 cursor-pointer hover:border-[var(--border-strong)] transition-colors">
                <input
                  type="checkbox"
                  checked={editSyncMicroStatus}
                  onChange={e => { setEditSyncMicroStatus(e.target.checked); markDirty(); }}
                  className="mt-0.5 h-4 w-4 rounded border-[var(--border-strong)] bg-[var(--surface-0)] text-blue-600 focus:ring-2 focus:ring-blue-500/50"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-[var(--text-primary)]">Sync status reasons to source</span>
                  <span className="mt-1 block text-xs text-[var(--text-muted)]">
                    Write Mission Control micro-statuses as <code>mc:*</code> labels or categories. Existing source values are still read when this is off.
                  </span>
                </span>
              </label>
            </div>
          )}

          {isGitHubConnector && (
            <div>
              <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
                Repositories
              </label>
              <div className="space-y-1.5 mb-2">
                {editRepos.map(repo => (
                  <div key={repo} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <FolderOpen size={11} className="text-[var(--text-muted)] shrink-0" />
                    <span className="font-mono truncate">{repo}</span>
                  </div>
                ))}
                {editRepos.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)] italic">No repositories configured</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newRepoInput}
                  onChange={e => { setNewRepoInput(e.target.value); setRepoError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddRepo(); } }}
                  placeholder="owner/repo"
                  className="flex-1 px-2.5 py-1.5 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-xs font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                />
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.96 }}
                  disabled={addingRepo || !newRepoInput.trim()}
                  onClick={handleAddRepo}
                  className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {addingRepo ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                  Add
                </motion.button>
              </div>
              {repoError && (
                <p className="mt-1 text-xs text-red-400 flex items-center gap-1">
                  <AlertTriangle size={10} /> {repoError}
                </p>
              )}
            </div>
          )}

          {/* Sync Mode */}
          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">Sync Mode</label>
            <Select value={editSyncMode} onValueChange={(v) => { setEditSyncMode(v); markDirty(); }}>
              <SelectTrigger className="w-full px-3 py-1.5 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYNC_MODE_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Poll Interval (only shown for poll mode) */}
          {editSyncMode === 'poll' && (
            <div>
              <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">Poll Interval</label>
              <Select value={String(editInterval)} onValueChange={(v) => { setEditInterval(Number(v)); markDirty(); }}>
                <SelectTrigger className="w-full px-3 py-1.5 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POLL_INTERVAL_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={String(opt.value)}>Every {opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Capabilities */}
          <div>
            <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 flex items-center gap-1.5">
              <Shield size={10} /> Capabilities
            </label>
            {/* Always-on capabilities (read, sync) */}
            <div className="flex gap-1.5 mb-2">
              {[...LOCKED_CAPABILITIES].map(key => (
                <span key={key} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                  <CheckCircle2 size={10} className="text-green-500" />
                  {key}
                </span>
              ))}
            </div>
            {/* Toggleable capabilities */}
            <div className="grid grid-cols-2 gap-1.5">
              {TOGGLEABLE_CAPABILITIES.map(key => (
                <label key={key} className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] py-0.5">
                  <input
                    type="checkbox"
                    checked={!!editCaps[key]}
                    onChange={() => toggleCap(key)}
                    className="w-3.5 h-3.5 rounded border-[var(--border-strong)] bg-[var(--surface-0)] text-blue-600 focus:ring-blue-500/50 focus:ring-2 cursor-pointer"
                  />
                  {key}
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Sources & Info */}
        <div className="space-y-4">
          {/* Synced Sources */}
          <div>
            <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 flex items-center gap-1.5">
              <Zap size={10} /> Synced Sources
            </h4>
            <div className="space-y-1.5">
              {sourceLists.map(sl => {
                const selectedForSync = isSourceListSelected(connector, sl);

                return (
                  <div key={sl.id} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2.5 py-2">
                    <div className="flex items-start gap-2">
                      {selectedForSync ? (
                        <CheckCircle2 size={12} className="text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <Circle size={12} className="text-[var(--text-muted)] shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs text-[var(--text-primary)]">{sl.name}</span>
                          <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--accent)] font-medium">
                            {sl.type}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                          <span className="tabular-nums">{sl.taskCount} items</span>
                          <span className={selectedForSync ? 'text-emerald-400' : 'text-[var(--text-muted)]'}>
                            {selectedForSync ? 'Selected for sync' : 'Not selected'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {sourceLists.length === 0 && (
                <p className="text-xs text-[var(--text-muted)] italic">Sources show up after your first sync</p>
              )}
            </div>
          </div>

          {/* Authentication Status */}
          <div>
            <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 flex items-center gap-1.5">
              <Shield size={10} /> Authentication
            </h4>
            {isFinanceConnector ? (
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
                <p className="text-xs text-[var(--text-secondary)]">
                  Tyrion owns the Monarch connection. Mission Control syncs bounded transaction snapshots and sends category changes through the bridge.
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  No Monarch credentials are stored here. The connector service token remains server-side and is never returned to this browser.
                </p>
              </div>
            ) : connector.hasCredentials ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 size={10} /> Credentials stored
                </span>
                <button
                  className="text-xs text-blue-400 hover:text-blue-300 underline"
                  onClick={() => {
                    const accountType = (connector.settings?.accountType as string) || 'personal';
                    const authUrl = `/api/auth/microsoft/connect?instanceId=${encodeURIComponent(connector.id)}&accountType=${accountType}&connectorType=${encodeURIComponent(connector.type)}`;
                    window.open(authUrl, 'microsoft-oauth', 'width=600,height=700,popup=yes');
                  }}
                >Re-authenticate</button>
              </div>
            ) : isDiConnector ? (
              <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                <Shield size={10} /> No connector credentials stored; server environment or unauthenticated access may be in use
              </span>
            ) : (
              <span className="text-xs text-amber-400 flex items-center gap-1">
                <AlertTriangle size={10} /> No credentials configured
              </span>
            )}
          </div>

          {/* GitHub Token Permissions */}
          {isGitHubConnector && (
            <div>
              <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 flex items-center gap-1.5">
                <Shield size={10} /> Token Permissions
              </h4>
              {ghScopeLoading ? (
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <Loader2 size={10} className="animate-spin" /> Detecting scopes…
                </div>
              ) : ghTokenType === 'fine-grained' ? (
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
                  <p className="text-xs text-[var(--text-secondary)]">
                    Fine-grained token detected. Scope detection is not available for this token type.
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    If features like Projects v2 or Notifications aren&apos;t working, check your token&apos;s permissions on GitHub.
                  </p>
                </div>
              ) : ghScopes ? (
                <div className="space-y-1.5">
                  {ghScopes.map(scope => (
                    <div key={scope.scope} className="flex items-center gap-2 group" title={scope.description}>
                      {scope.granted ? (
                        <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
                      ) : (
                        <XCircle size={11} className={`shrink-0 ${scope.required ? 'text-red-400' : 'text-[var(--text-muted)]'}`} />
                      )}
                      <span className={`text-xs ${scope.granted ? 'text-[var(--text-secondary)]' : scope.required ? 'text-red-300' : 'text-[var(--text-muted)]'}`}>
                        {scope.label}
                      </span>
                      <code className="text-xs text-[var(--text-muted)] bg-[var(--surface-2)] px-1 py-0.5 rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                        {scope.scope}
                      </code>
                      {!scope.granted && !scope.required && (
                                              <span className="text-xs text-amber-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                          — {scope.description}
                        </span>
                      )}
                      {!scope.granted && scope.required && (
                        <span className="text-xs text-red-400">
                          Required
                        </span>
                      )}
                    </div>
                  ))}
                  {ghScopes.some(s => !s.granted) && (
                    <p className="text-xs text-[var(--text-muted)] mt-2 pt-1.5 border-t border-[var(--border-subtle)]">
                      Missing scopes limit available features.{' '}
                      <a
                        href="https://github.com/settings/tokens"
                        target="_blank"
                        rel="noopener"
                        className="text-blue-400 hover:text-blue-300 underline"
                      >
                        Update token on GitHub
                      </a>
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {/* GitHub Label Health */}
          {isGitHubConnector && connector.enabled && (
            <LabelHealthPanel connectorId={connector.id} />
          )}

          {/* OWL module health */}
          {isDiConnector && connector.enabled && (
            <div>
              <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 flex items-center gap-1.5">
                <Activity size={10} /> OWL Health
              </h4>
              {diHealthLoading ? (
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <Loader2 size={10} className="animate-spin" /> Checking OWL modules…
                </div>
              ) : diHealth ? (
                <div className="space-y-1.5">
                  {/* Overall status */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border ${
                      diHealth.overall === 'healthy' ? 'bg-emerald-900/30 text-emerald-400 border-emerald-800/30' :
                      diHealth.overall === 'degraded' ? 'bg-amber-900/30 text-amber-400 border-amber-800/30' :
                      'bg-red-900/30 text-red-400 border-red-800/30'
                    }`}>
                      {diHealth.overall === 'healthy' ? <CheckCircle2 size={10} /> :
                       diHealth.overall === 'degraded' ? <AlertTriangle size={10} /> :
                       <XCircle size={10} />}
                      {diHealth.overall}
                    </span>
                    {diHealth.latencyMs !== undefined && (
                      <span className="text-xs text-[var(--text-muted)]">{diHealth.latencyMs}ms</span>
                    )}
                  </div>
                  {/* Per-module status */}
                  {diHealth.modules.map(mod => (
                    <div key={mod.name} className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2.5 py-2">
                      {mod.status === 'healthy' ? (
                        <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
                      ) : mod.status === 'disabled' ? (
                        <Circle size={11} className="text-[var(--text-muted)] shrink-0" />
                      ) : mod.status === 'error' ? (
                        <XCircle size={11} className="text-red-400 shrink-0" />
                      ) : (
                        <AlertTriangle size={11} className="text-amber-400 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <span className={`text-xs ${mod.enabled ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>
                          {mod.name}
                        </span>
                        {mod.detail && (
                          <span className="text-xs text-[var(--text-muted)] ml-2">— {mod.detail}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[var(--text-muted)] italic">OWL health data unavailable</p>
              )}
            </div>
          )}

          {/* Connector metadata */}
          <div className="pt-2 border-t border-[var(--border-subtle)] text-xs text-[var(--text-muted)] space-y-1">
            <div>Created: {new Date(connector.createdAt).toLocaleDateString()}</div>
            <div>Updated: {new Date(connector.updatedAt).toLocaleDateString()}</div>
            <div>ID: <code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">{connector.id.slice(0, 12)}</code></div>
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div className="mt-4 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
          <motion.button
            onClick={handleSave}
            disabled={!dirty || saving}
            whileTap={{ scale: 0.97 }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors ${
              dirty
                ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-sm'
                : 'bg-[var(--surface-2)] text-[var(--text-muted)] cursor-not-allowed'
            }`}
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            {saving ? 'Saving...' : 'Save Changes'}
          </motion.button>
          <motion.button
            onClick={handleTest}
            disabled={testing}
            whileTap={{ scale: 0.97 }}
            className="px-3 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)] disabled:opacity-50"
          >
            {testing ? <Loader2 size={11} className="animate-spin" /> : <Activity size={11} />}
            {testing ? 'Testing...' : 'Test Connection'}
          </motion.button>
          </div>
          {saveError && <p className="mt-1 text-xs text-red-400">{saveError}</p>}
          {saved && (
            <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="text-xs text-emerald-400 flex items-center gap-1">
              <CheckCircle2 size={11} /> Saved
            </motion.span>
          )}
          {testResult && (
            <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
              className={`text-xs flex items-center gap-1 ${testResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult.success ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
              {testResult.success
                ? `OK (${testResult.latencyMs}ms)${testResult.details ? ` — ${testResult.details}` : ''}`
                : testResult.error}
            </motion.span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {confirmDelete === connector.id ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-400">Remove connector? Tasks remain for 7 days.</span>
              <button onClick={() => onDelete(connector.id)}
                className="px-2 py-1 text-xs font-medium rounded bg-red-900/40 hover:bg-red-900/60 text-red-400 border border-red-800/40">
                Remove
              </button>
              <button onClick={() => setConfirmDelete(null)}
                className="px-2 py-1 text-xs font-medium rounded bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)]">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(connector.id); }}
              className="p-1.5 rounded-md hover:bg-red-900/20 text-[var(--text-muted)] hover:text-red-400 transition-colors"
              title="Remove connector">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


export { ConnectorsSection, DefaultConnectorEditPanel };
