'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  RefreshCw, ChevronRight, Shield, Loader2, ServerCrash,
  AlertTriangle, Clock, CheckCircle2, XCircle, RotateCcw, Activity,
  ChevronLeft, Archive, Trash2, Upload, Unplug, ExternalLink, Info, ArchiveRestore,
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import type {
  ConnectorConfig,
  SyncLogEntry,
  SyncAuditDetail,
  SyncScheduleHealth,
} from './types';
import { getConnectorDisplayName } from './types';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import {
  classifyRetainedReason,
  getAvailableRetentionActions,
  getBlockedRetentionCapability,
  getRetentionResolutionLabel,
  isDestructiveRetentionResolution,
  type RetentionResolution,
  type RetentionResolutionStatus,
} from '@/lib/sync/retention';

const PAGE_SIZE = 10;
const DETAIL_PAGE_SIZE = 10;

const triggerLabels: Record<NonNullable<SyncLogEntry['trigger']>, string> = {
  api: 'Manual',
  schedule: 'Scheduled',
  nightly: 'Nightly',
  watchdog: 'Automatic recovery',
  recovery: 'Retried after interruption',
};

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

function ScheduleHealthPanel({
  health,
  connectorNames,
  onSync,
  syncing,
}: {
  health: SyncScheduleHealth;
  connectorNames: Record<string, string>;
  onSync: (connectorId: string) => Promise<void>;
  syncing: Set<string>;
}) {
  const overdue = health.schedules.filter((schedule) => schedule.overdue);
  const needsAction = health.status === 'action_required';
  const Icon = health.userAction?.type === 'restart_worker' ? ServerCrash : needsAction ? AlertTriangle : CheckCircle2;

  return (
    <div className={`mb-6 rounded-xl border p-4 ${
      needsAction
        ? 'border-amber-800/50 bg-amber-950/20'
        : 'border-emerald-900/40 bg-emerald-950/15'
    }`}>
      <div className="flex items-start gap-3">
        <Icon
          size={18}
          className={needsAction ? 'mt-0.5 shrink-0 text-amber-400' : 'mt-0.5 shrink-0 text-emerald-400'}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Automatic sync health</h3>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              needsAction ? 'bg-amber-900/40 text-amber-300' : 'bg-emerald-900/30 text-emerald-300'
            }`}>
              {needsAction ? 'Action required' : 'No action needed'}
            </span>
          </div>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{health.message}</p>
          {health.userAction && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              <span className="font-medium text-[var(--text-secondary)]">
                Recommended action: {health.userAction.label}.
              </span>{' '}
              {health.userAction.detail}
            </p>
          )}
          {health.worker && (
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Worker {health.worker.available ? 'online' : 'not reporting'} · last report {new Date(health.worker.heartbeatAt).toLocaleString()}
            </p>
          )}

          {overdue.length > 0 && (
            <div className="mt-3 space-y-2">
              {overdue.map((schedule) => (
                <div
                  key={schedule.connectorId}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      {connectorNames[schedule.connectorId] || schedule.connectorId}
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      Due {new Date(schedule.nextDueAt).toLocaleString()} · overdue {formatElapsed(schedule.overdueMs)}
                    </div>
                  </div>
                  {health.userAction?.type === 'sync_now' && (
                    <button
                      type="button"
                      onClick={() => void onSync(schedule.connectorId)}
                      disabled={syncing.has(schedule.connectorId)}
                      className="rounded-lg bg-[var(--accent-600)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:opacity-50"
                    >
                      {syncing.has(schedule.connectorId) ? 'Syncing…' : 'Sync now'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Format a number with locale-appropriate thousands separators */
function fmt(n: number): string {
  return n.toLocaleString();
}

function SyncHistorySkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--surface-2)]" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-[var(--surface-2)] rounded w-1/3" />
            <div className="h-3 bg-[var(--surface-2)] rounded w-1/2" />
          </div>
          <div className="space-y-1">
            <div className="h-3 bg-[var(--surface-2)] rounded w-12 ml-auto" />
            <div className="h-3 bg-[var(--surface-2)] rounded w-8 ml-auto" />
          </div>
        </div>
      ))}
    </div>
  );
}

const actionConfig: Record<string, { color: string; label: string; icon: string }> = {
  added: { color: 'text-emerald-400', label: 'Added', icon: '+' },
  updated: { color: 'text-blue-400', label: 'Updated', icon: '~' },
  removed: { color: 'text-red-400', label: 'Removed', icon: '−' },
  pushed: { color: 'text-purple-400', label: 'Pushed', icon: '↑' },
  push_failed: { color: 'text-red-400', label: 'Push Failed', icon: '!' },
  protected: { color: 'text-amber-400', label: 'Retained locally', icon: '*' },
  conflict_resolved: { color: 'text-orange-400', label: 'Conflict', icon: '!' },
};

const getErrorCategory = (error: string): { label: string; action: string; actionType: 'retry' | 'reauth' | 'info' } => {
  if (error.includes('401') || error.includes('token') || error.includes('Token') || error.includes('auth')) {
    return { label: 'Authentication', action: 'Re-authenticate', actionType: 'reauth' };
  }
  if (error.includes('429') || error.includes('rate') || error.includes('throttl')) {
    return { label: 'Rate Limited', action: 'Retry sync', actionType: 'retry' };
  }
  if (error.includes('timeout') || error.includes('ECONNREFUSED') || error.includes('Network')) {
    return { label: 'Network', action: 'Retry sync', actionType: 'retry' };
  }
  if (error.includes('conflict')) {
    return { label: 'Conflict', action: 'View details', actionType: 'info' };
  }
  return { label: 'Error', action: 'Retry sync', actionType: 'retry' };
};

type ActionFilter = 'added' | 'updated' | 'removed' | 'pushed' | 'protected' | null;

type IndexedAuditDetail = {
  detail: SyncAuditDetail;
  detailIndex: number;
};

type ResolutionResult = {
  syncLogId: string;
  detailIndex: number;
  resolution: RetentionResolution;
  success: boolean;
  message: string;
  resolutionStatus?: RetentionResolutionStatus;
};

const resolutionIcons: Record<RetentionResolution, React.ComponentType<{ size?: number; className?: string }>> = {
  retry_push: Upload,
  keep_local: Unplug,
  archive_local: Archive,
  discard_local_changes: Trash2,
  delete_local: Trash2,
};

const attentionLabels = {
  informational: 'Informational',
  'action-recommended': 'Action recommended',
  'configuration-required': 'Configuration required',
} as const;

function getConfirmationCopy(action: RetentionResolution, count: number) {
  const subject = count === 1 ? 'this task' : `these ${count} tasks`;
  switch (action) {
    case 'keep_local':
      return {
        title: 'Keep locally?',
        message: `Mission Control will detach ${subject} from the connector and preserve the task data locally. Future upstream changes will not apply.`,
      };
    case 'archive_local':
      return {
        title: 'Archive locally?',
        message: `Mission Control will detach ${subject} from the connector and retain the closed task history locally.`,
      };
    case 'discard_local_changes':
      return {
        title: 'Discard local changes?',
        message: `The upstream item no longer exists. This will permanently delete ${subject} and all unpushed local changes.`,
      };
    case 'delete_local':
      return {
        title: 'Delete local copy?',
        message: `This will permanently delete ${subject} and any local subtasks. It will not change the upstream source.`,
      };
    case 'retry_push':
      return { title: '', message: '' };
  }
}

/** Expanded detail panel with clickable KPI cards and paginated audit trail */
function DetailPanel({ entry, auditDetails, connectorCapabilities, pushed, formatDuration, handleRetry, errors, hasErrors, onResolutionRecorded, onOpenDetail }: {
  entry: SyncLogEntry;
  auditDetails: SyncAuditDetail[];
  connectorCapabilities: ConnectorConfig['capabilities'];
  pushed: number;
  formatDuration: (ms: number | null) => string | null;
  handleRetry: (connectorId: string) => void;
  errors: string[];
  hasErrors: boolean;
  onResolutionRecorded: (results: ResolutionResult[]) => void;
  onOpenDetail: (detail: SyncAuditDetail, connectorId: string) => void;
}) {
  const [activeFilter, setActiveFilter] = useState<ActionFilter>(null);
  const [detailPage, setDetailPage] = useState(0);
  const [resolving, setResolving] = useState<Set<number>>(new Set());
  const [confirmation, setConfirmation] = useState<{
    action: RetentionResolution;
    targets: IndexedAuditDetail[];
  } | null>(null);

  // Derive protected count from actual audit details (not the potentially incomplete top-level field)
  const protectedFromAudit = useMemo(
    () => auditDetails.filter(d => d.action === 'protected').length,
    [auditDetails]
  );
  const protectedCount = Math.max(entry.localOnlyProtected || 0, protectedFromAudit);

  // Items with actual changes (exclude untouched — items not in audit are untouched)
  const changedDetails = useMemo(
    () => auditDetails
      .map((detail, detailIndex) => ({ detail, detailIndex }))
      .filter(({ detail }) => ['added', 'updated', 'removed', 'pushed', 'push_failed', 'protected', 'conflict_resolved'].includes(detail.action)),
    [auditDetails]
  );

  // Filtered list based on active KPI filter
  const filteredDetails = useMemo(() => {
    if (!activeFilter) return changedDetails;
    return changedDetails.filter(({ detail }) => detail.action === activeFilter);
  }, [changedDetails, activeFilter]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredDetails.length / DETAIL_PAGE_SIZE));
  const pagedDetails = filteredDetails.slice(detailPage * DETAIL_PAGE_SIZE, (detailPage + 1) * DETAIL_PAGE_SIZE);

  const unresolvedRetainedGroups = useMemo(() => {
    const groups = new Map<string, IndexedAuditDetail[]>();
    for (const indexed of changedDetails) {
      if (indexed.detail.action !== 'protected' || indexed.detail.resolution?.status === 'succeeded') continue;
      const category = classifyRetainedReason(indexed.detail.reason).category;
      const group = groups.get(category);
      if (group) group.push(indexed);
      else groups.set(category, [indexed]);
    }
    return Array.from(groups.values());
  }, [changedDetails]);

  const submitResolution = async (
    action: RetentionResolution,
    targets: IndexedAuditDetail[],
    confirmed: boolean,
  ) => {
    const detailIndexes = new Set(targets.map((target) => target.detailIndex));
    setResolving((current) => new Set([...current, ...detailIndexes]));
    try {
      const response = await fetch('/api/sync/retained/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: targets.map((target) => ({
            syncLogId: entry.id,
            detailIndex: target.detailIndex,
            resolution: action,
            confirmed,
          })),
        }),
      });
      const data = await response.json();
      const results = (data.results || []) as ResolutionResult[];
      if (results.length === 0) {
        throw new Error(data.error || 'Resolution failed');
      }
      onResolutionRecorded(results);
      if (data.failed > 0 && data.succeeded > 0) {
        toast.warning(`Resolved ${data.succeeded}; ${data.failed} failed`);
      } else if (data.failed > 0) {
        toast.error(results[0]?.message || 'Resolution failed');
      } else {
        toast.success(results.length === 1 ? results[0].message : `Resolved ${results.length} retained items`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Resolution failed');
    } finally {
      setResolving((current) => {
        const next = new Set(current);
        for (const detailIndex of detailIndexes) next.delete(detailIndex);
        return next;
      });
      setConfirmation(null);
    }
  };

  const requestResolution = (action: RetentionResolution, targets: IndexedAuditDetail[]) => {
    if (action === 'retry_push') {
      void submitResolution(action, targets, false);
      return;
    }
    setConfirmation({ action, targets });
  };

  const handleFilterClick = (filter: ActionFilter) => {
    setActiveFilter(prev => prev === filter ? null : filter);
    setDetailPage(0);
  };

  const kpiCards: { key: ActionFilter; label: string; value: number; color: string }[] = [
    { key: 'added', label: 'Added', value: entry.tasksAdded, color: 'text-emerald-400' },
    { key: 'updated', label: 'Updated', value: entry.tasksUpdated, color: 'text-blue-400' },
    { key: 'removed', label: 'Removed', value: entry.tasksRemoved, color: 'text-red-400' },
    { key: 'pushed', label: 'Pushed', value: pushed, color: 'text-purple-400' },
    { key: 'protected', label: 'Retained', value: protectedCount, color: 'text-amber-400' },
  ];

  return (
    <div className="space-y-3">
      {/* Stats grid — clickable KPI cards */}
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        {kpiCards.map(({ key, label, value, color }) => (
          <button
            key={key}
            onClick={() => value > 0 ? handleFilterClick(key) : undefined}
            className={`bg-[var(--surface-2)] rounded-lg px-3 py-2 text-left transition-all ${
              value > 0 ? 'cursor-pointer hover:bg-[var(--surface-3)] hover:ring-1 hover:ring-[var(--border)]' : 'cursor-default'
            } ${activeFilter === key ? 'ring-2 ring-[var(--accent-400)] bg-[var(--surface-3)]' : ''}`}
          >
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">{label}</div>
            <div className={`text-sm font-semibold ${color} tabular-nums`}>{fmt(value)}</div>
          </button>
        ))}
        <div className="bg-[var(--surface-2)] rounded-lg px-3 py-2">
          <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Notifications</div>
          <div className={`text-sm font-semibold tabular-nums ${entry.notificationsAdded > 0 ? 'text-orange-400' : 'text-[var(--text-primary)]'}`}>{fmt(entry.notificationsAdded)}</div>
        </div>
        <div className="bg-[var(--surface-2)] rounded-lg px-3 py-2">
          <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Duration</div>
          <div className="text-sm font-semibold text-[var(--text-primary)] tabular-nums">{formatDuration(entry.durationMs) || '—'}</div>
        </div>
      </div>

      {/* Timestamp */}
      <dl className="grid gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-[var(--text-muted)]">Completed</dt>
          <dd className="mt-0.5 text-[var(--text-secondary)]">{new Date(entry.syncedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Trigger</dt>
          <dd className="mt-0.5 text-[var(--text-secondary)]">
            {entry.trigger ? triggerLabels[entry.trigger] : 'Legacy or direct operation'}
          </dd>
        </div>
        {entry.scheduledFor && (
          <div>
            <dt className="text-[var(--text-muted)]">Scheduled for</dt>
            <dd className="mt-0.5 text-[var(--text-secondary)]">{new Date(entry.scheduledFor).toLocaleString()}</dd>
          </div>
        )}
        {entry.startedAt && (
          <div>
            <dt className="text-[var(--text-muted)]">Started</dt>
            <dd className="mt-0.5 text-[var(--text-secondary)]">
              {new Date(entry.startedAt).toLocaleString()}
              {entry.scheduledFor && new Date(entry.startedAt) > new Date(entry.scheduledFor)
                ? ` (${formatElapsed(new Date(entry.startedAt).getTime() - new Date(entry.scheduledFor).getTime())} late)`
                : ''}
            </dd>
          </div>
        )}
        {entry.attempt != null && (
          <div>
            <dt className="text-[var(--text-muted)]">Attempt</dt>
            <dd className="mt-0.5 text-[var(--text-secondary)]">
              {entry.attempt} of {entry.maxAttempts ?? entry.attempt}
            </dd>
          </div>
        )}
        {entry.jobId && (
          <div>
            <dt className="text-[var(--text-muted)]">Job ID</dt>
            <dd className="mt-0.5 truncate font-mono text-[var(--text-secondary)]" title={entry.jobId}>{entry.jobId}</dd>
          </div>
        )}
      </dl>

      {/* Errors section */}
      {hasErrors && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-amber-400" />
            {errors.length} {errors.length === 1 ? 'issue' : 'issues'} during sync
          </div>
          <div className="space-y-1.5">
            {errors.map((error, i) => {
              const category = getErrorCategory(error);
              return (
                <div key={i} className="bg-red-950/20 border border-red-900/30 rounded-lg px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-red-300 uppercase tracking-wide">{category.label}</span>
                      <p className="text-xs text-[var(--text-secondary)] mt-0.5 break-words">{error}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => handleRetry(entry.connectorId)}
              className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--accent-900)]/40 text-[var(--accent-300)] hover:bg-[var(--accent-900)]/60 transition-colors flex items-center gap-1.5"
            >
              <RotateCcw size={11} />
              Retry sync
            </button>
            {errors.some(e => e.includes('401') || e.includes('token') || e.includes('Token')) && (
              <button
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-900/30 text-amber-300 hover:bg-amber-900/50 transition-colors flex items-center gap-1.5"
              >
                <Shield size={11} />
                Re-authenticate
              </button>
            )}
          </div>
        </div>
      )}

      {entry.success && !hasErrors && protectedCount === 0 && (
        <div className="flex items-center gap-2 text-xs text-emerald-400/80">
          <CheckCircle2 size={12} />
          Completed successfully with no issues
        </div>
      )}

      {protectedCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-800/30 bg-amber-950/15 px-3 py-2 text-xs text-amber-100/80">
          <Info size={13} className="mt-0.5 shrink-0 text-amber-400" />
          <span>
            Mission Control retained these items locally instead of making an unsafe automatic deletion or overwrite.
            Expand each item for its reason and available actions.
          </span>
        </div>
      )}

      {unresolvedRetainedGroups.some((group) => group.length > 1) && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--text-secondary)]">Bulk actions for matching retained items</div>
          {unresolvedRetainedGroups.filter((group) => group.length > 1).map((group) => {
            const classification = classifyRetainedReason(group[0].detail.reason);
            const availableActions = getAvailableRetentionActions(classification, connectorCapabilities);
            return (
              <div key={classification.category} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2">
                <span className="mr-auto text-xs text-[var(--text-secondary)]">
                  {classification.label}: {fmt(group.length)}
                </span>
                {availableActions
                  .filter((action) => action !== 'retry_push'
                    || group.every((item) => item.detail.resolution?.status !== 'indeterminate'))
                  .map((action) => {
                  const Icon = resolutionIcons[action];
                  const isResolving = group.some((item) => resolving.has(item.detailIndex));
                  return (
                    <button
                      key={action}
                      onClick={() => requestResolution(action, group)}
                      disabled={isResolving}
                      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium disabled:opacity-50 ${
                        isDestructiveRetentionResolution(action)
                          ? 'bg-red-950/40 text-red-300 hover:bg-red-950/60'
                          : 'bg-[var(--surface-3)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {isResolving ? <Loader2 size={11} className="animate-spin" /> : <Icon size={11} />}
                      {getRetentionResolutionLabel(action)}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Audit trail — paginated, filtered */}
      {changedDetails.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
            <Activity size={12} className="text-[var(--accent-400)]" />
            {activeFilter
              ? `${actionConfig[activeFilter]?.label || activeFilter} items (${fmt(filteredDetails.length)})`
              : `Task-level details (${fmt(changedDetails.length)}${auditDetails.length > changedDetails.length ? ` of ${fmt(auditDetails.length)} total` : ''})`
            }
            {activeFilter && (
              <button
                onClick={() => { setActiveFilter(null); setDetailPage(0); }}
                className="ml-2 text-[var(--accent-400)] hover:text-[var(--accent-300)] underline"
              >
                Clear filter
              </button>
            )}
          </div>
          <div className="bg-[var(--surface-2)] rounded-lg overflow-hidden">
            {pagedDetails.map(({ detail, detailIndex }, i) => {
              const config = actionConfig[detail.action] || { color: 'text-[var(--text-muted)]', label: detail.action, icon: '•' };
              const retention = detail.action === 'protected' ? classifyRetainedReason(detail.reason) : null;
              const availableActions = retention
                ? getAvailableRetentionActions(retention, connectorCapabilities)
                : [];
              const blockedCapability = retention
                ? getBlockedRetentionCapability(retention, connectorCapabilities)
                : undefined;
              const isResolved = detail.resolution?.status === 'succeeded';
              const isResolving = resolving.has(detailIndex);
              return (
                <div key={detailIndex} className={`px-3 py-2 flex items-start gap-2 text-xs ${i > 0 ? 'border-t border-[var(--border-subtle)]' : ''}`}>
                  <span className={`${config.color} font-mono w-4 text-center flex-shrink-0`}>{config.icon}</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[var(--text-primary)] break-words">{detail.taskTitle}</span>
                    {detail.listName && (
                      <span className="text-[var(--text-muted)]"> ({detail.listName})</span>
                    )}
                    {retention ? (
                      <div className="mt-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-amber-900/30 px-1.5 py-0.5 font-medium text-amber-300">
                            {retention.label}
                          </span>
                          <span className="rounded bg-[var(--surface-3)] px-1.5 py-0.5 text-[var(--text-muted)]">
                            {attentionLabels[retention.attention]}
                          </span>
                          <span className="text-[var(--text-muted)]">{retention.explanation}</span>
                        </div>
                        {detail.reason && (
                          <div className="text-[var(--text-muted)]">Technical reason: {detail.reason}</div>
                        )}
                        {detail.resolution && (
                          <div className={detail.resolution.status === 'succeeded' ? 'text-emerald-400' : 'text-red-400'}>
                            {detail.resolution.status === 'succeeded'
                              ? 'Resolved'
                              : detail.resolution.status === 'indeterminate'
                                ? 'Upstream outcome unknown'
                                : 'Last attempt failed'}:
                            {' '}{detail.resolution.message}
                          </div>
                        )}
                        {!isResolved && (
                          <div className="flex flex-wrap gap-1.5">
                            {availableActions
                              .filter((action) => action !== 'retry_push'
                                || detail.resolution?.status !== 'indeterminate')
                              .map((action) => {
                              const Icon = resolutionIcons[action];
                              return (
                                <button
                                  key={action}
                                  onClick={() => requestResolution(action, [{ detail, detailIndex }])}
                                  disabled={isResolving}
                                  className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium disabled:opacity-50 ${
                                    isDestructiveRetentionResolution(action)
                                      ? 'bg-red-950/40 text-red-300 hover:bg-red-950/60'
                                      : 'bg-[var(--surface-3)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                  }`}
                                >
                                  {isResolving ? <Loader2 size={11} className="animate-spin" /> : <Icon size={11} />}
                                  {getRetentionResolutionLabel(action)}
                                </button>
                              );
                            })}
                            {blockedCapability && (
                              <a
                                href={`/settings/connectors?setting=Capabilities&connector=${encodeURIComponent(entry.connectorId)}`}
                                className="inline-flex items-center gap-1 rounded bg-[var(--surface-3)] px-2 py-1 text-xs font-medium text-[var(--accent-300)] hover:text-[var(--accent-200)]"
                              >
                                <ExternalLink size={11} />
                                Open {blockedCapability} setting
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    ) : detail.reason ? (
                      <span className="text-[var(--text-muted)]"> — {detail.reason}</span>
                    ) : null}
                  </div>
                  <span className={`${isResolved ? 'text-emerald-400' : config.color} text-xs uppercase tracking-wide flex-shrink-0`}>
                    {isResolved ? 'Resolved' : config.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenDetail(detail, entry.connectorId)}
                    className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                    aria-label={`Open ${detail.action === 'removed' ? 'removed task details' : 'task'}: ${detail.taskTitle}`}
                  >
                    <ExternalLink size={11} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Pagination controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => setDetailPage(p => Math.max(0, p - 1))}
                disabled={detailPage === 0}
                className="text-xs font-medium px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)] disabled:opacity-30 disabled:cursor-default flex items-center gap-1"
              >
                <ChevronLeft size={12} />
                Prev
              </button>
              <span className="text-xs text-[var(--text-muted)] tabular-nums">
                Page {detailPage + 1} of {fmt(totalPages)}
              </span>
              <button
                onClick={() => setDetailPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={detailPage >= totalPages - 1}
                className="text-xs font-medium px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)] disabled:opacity-30 disabled:cursor-default flex items-center gap-1"
              >
                Next
                <ChevronRight size={12} />
              </button>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation ? getConfirmationCopy(confirmation.action, confirmation.targets.length).title : ''}
        message={confirmation ? getConfirmationCopy(confirmation.action, confirmation.targets.length).message : ''}
        confirmLabel={confirmation ? getRetentionResolutionLabel(confirmation.action) : 'Confirm'}
        confirmVariant={confirmation && isDestructiveRetentionResolution(confirmation.action) ? 'danger' : 'warning'}
        onConfirm={() => {
          if (confirmation) {
            void submitResolution(confirmation.action, confirmation.targets, true);
          }
        }}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
}

interface RemovedTaskSnapshot {
  id: string;
  originalTaskId: string;
  connectorId: string;
  sourceId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  reason: string;
  deletedAt: string;
  restoredAt: string | null;
  restoredTaskId: string | null;
  restoreMode: 'local' | 'source' | null;
  canRestoreToSource: boolean;
}

function RemovedTaskDialog({ snapshotId, onClose, onOpenTask }: {
  snapshotId: string;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<RemovedTaskSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<null | 'local' | 'source'>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sync/deletions/${encodeURIComponent(snapshotId)}`)
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load removed task');
        return data.snapshot as RemovedTaskSnapshot;
      })
      .then(data => {
        if (!cancelled) setSnapshot(data);
      })
      .catch(error => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : 'Failed to load removed task');
          onClose();
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [snapshotId, onClose]);

  const restore = async (mode: 'local' | 'source') => {
    setRestoring(mode);
    try {
      const response = await fetch(`/api/sync/deletions/${encodeURIComponent(snapshotId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Restore failed');
      toast.success(mode === 'source'
        ? 'Task queued to be recreated at its source'
        : 'Task restored locally');
      onOpenTask(data.taskId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Restore failed');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] w-[min(92vw,36rem)] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-5 shadow-2xl focus:outline-none">
          <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
            <ArchiveRestore size={18} className="text-red-400" />
            Removed task
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-[var(--text-tertiary)]">
            This is the preserved state from immediately before Sync removed the task.
          </Dialog.Description>

          {loading || !snapshot ? (
            <div className="flex justify-center py-12"><Loader2 className="animate-spin text-[var(--accent-400)]" /></div>
          ) : (
            <div className="mt-5 space-y-4">
              <div className="rounded-xl bg-[var(--surface-2)] p-4">
                <h3 className="font-medium text-[var(--text-primary)]">{snapshot.title}</h3>
                {snapshot.description && (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--text-secondary)] line-clamp-6">{snapshot.description}</p>
                )}
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-[var(--text-muted)]">Status</dt><dd className="text-[var(--text-secondary)]">{snapshot.status}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Priority</dt><dd className="text-[var(--text-secondary)]">{snapshot.priority}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Source</dt><dd className="text-[var(--text-secondary)]">{snapshot.connectorType}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Removed</dt><dd className="text-[var(--text-secondary)]">{new Date(snapshot.deletedAt).toLocaleString()}</dd></div>
                </dl>
              </div>

              <div className="rounded-xl border border-red-900/30 bg-red-950/20 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-red-300">Removal reason</div>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">{snapshot.reason}</p>
              </div>

              {snapshot.restoredTaskId ? (
                <button
                  type="button"
                  onClick={() => onOpenTask(snapshot.restoredTaskId!)}
                  className="w-full rounded-lg bg-[var(--accent-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-500)]"
                >
                  Open restored task
                </button>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => restore('local')}
                    disabled={restoring !== null}
                    className="flex-1 rounded-lg bg-[var(--accent-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-500)] disabled:opacity-50"
                  >
                    {restoring === 'local' ? 'Restoring…' : 'Restore locally'}
                  </button>
                  {snapshot.canRestoreToSource && (
                    <button
                      type="button"
                      onClick={() => restore('source')}
                      disabled={restoring !== null}
                      className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--surface-3)] disabled:opacity-50"
                    >
                      {restoring === 'source' ? 'Queuing…' : 'Recreate at source'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <Dialog.Close asChild>
            <button type="button" className="absolute right-4 top-4 text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label="Close removed task details">
              <XCircle size={18} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SyncHistorySection({ connectors }: { connectors: ConnectorConfig[] }) {
  const connectorNames = Object.fromEntries(connectors.map(c => [c.id, getConnectorDisplayName(c)]));
  const [entries, setEntries] = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [scheduleHealth, setScheduleHealth] = useState<SyncScheduleHealth | null>(null);
  const [syncingConnectors, setSyncingConnectors] = useState<Set<string>>(new Set());
  const [relativeTimeNow] = useState(() => Date.now());

  const fetchPage = useCallback(async (before?: string) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) params.set('before', before);
    const res = await fetch(`/api/sync?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load sync history');
    return {
      history: (data.history || []) as SyncLogEntry[],
      hasMore: !!data.hasMore,
      scheduleHealth: (data.scheduleHealth || null) as SyncScheduleHealth | null,
    };
  }, []);

  useEffect(() => {
    let refreshGeneration = 0;
    const refreshEntries = async () => {
      const requestId = ++refreshGeneration;
      try {
        const { history, hasMore: more, scheduleHealth: health } = await fetchPage();
        if (requestId !== refreshGeneration) return;
        setEntries(history);
        setHasMore(more);
        setScheduleHealth(health);
      } finally {
        if (requestId === refreshGeneration) setLoading(false);
      }
    };

    void refreshEntries().catch((error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to load sync history');
    });
    const handleSyncComplete = () => {
      void refreshEntries().catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Failed to refresh sync history');
      });
    };
    window.addEventListener('mission-control:sync-complete', handleSyncComplete);
    return () => {
      refreshGeneration++;
      window.removeEventListener('mission-control:sync-complete', handleSyncComplete);
    };
  }, [fetchPage]);

  const loadMore = async () => {
    if (loadingMore || !hasMore || entries.length === 0) return;
    setLoadingMore(true);
    try {
      const cursor = entries[entries.length - 1].syncedAt;
      const { history, hasMore: more } = await fetchPage(cursor);
      setEntries(prev => [...prev, ...history]);
      setHasMore(more);
    } finally {
      setLoadingMore(false);
    }
  };

  const formatDuration = (ms: number | null) => {
    if (!ms) return null;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  };

  const formatRelativeTime = (dateStr: string) => {
    const then = new Date(dateStr).getTime();
    const diff = relativeTimeNow - then;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  const parseErrors = (errors: string[] | string): string[] => {
    if (Array.isArray(errors)) return errors;
    if (typeof errors === 'string') {
      try { return JSON.parse(errors); } catch { return errors ? [errors] : []; }
    }
    return [];
  };

  const parseDetails = (details: SyncAuditDetail[] | string | undefined): SyncAuditDetail[] => {
    if (!details) return [];
    if (Array.isArray(details)) return details;
    if (typeof details === 'string') {
      try { return JSON.parse(details); } catch { return []; }
    }
    return [];
  };

  const handleResolutionRecorded = (syncLogId: string, results: ResolutionResult[]) => {
    setEntries((current) => current.map((entry) => {
      if (entry.id !== syncLogId) return entry;
      const details = parseDetails(entry.details);
      const nextDetails = details.map((detail, detailIndex) => {
        const result = results.find((candidate) => candidate.detailIndex === detailIndex);
        if (!result) return detail;
        return {
          ...detail,
          resolution: {
            action: result.resolution,
            status: result.resolutionStatus
              ?? (result.success ? 'succeeded' as const : 'failed' as const),
            resolvedAt: new Date().toISOString(),
            message: result.message,
          },
        };
      });
      return { ...entry, details: nextDetails };
    }));
  };

  const handleRetry = async (connectorId: string) => {
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId }),
      });
      const data = await response.json();
      if (!response.ok || data.results?.some((result: { success: boolean }) => !result.success)) {
        throw new Error(data.error || data.results?.[0]?.errors?.[0] || 'Sync failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed');
    }
  };

  const handleScheduleSync = async (connectorId: string) => {
    setSyncingConnectors((current) => new Set(current).add(connectorId));
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Sync failed');
      }
      const data = await response.json();
      const failed = data.results?.find((result: { success: boolean }) => !result.success);
      if (failed) throw new Error(failed.errors?.[0] || 'Sync failed');
      const { history, hasMore: more, scheduleHealth: health } = await fetchPage();
      setEntries(history);
      setHasMore(more);
      setScheduleHealth(health);
      toast.success(`${connectorNames[connectorId] || 'Connector'} sync completed`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed');
    } finally {
      setSyncingConnectors((current) => {
        const next = new Set(current);
        next.delete(connectorId);
        return next;
      });
    }
  };

  const openAuditDetail = async (detail: SyncAuditDetail, connectorId: string) => {
    if (detail.action === 'removed') {
      if (detail.deletionSnapshotId) {
        setSelectedSnapshotId(detail.deletionSnapshotId);
      } else {
        toast.info('This removal predates recovery snapshots, so only its audit details are available.');
      }
      return;
    }
    if (detail.taskId) {
      setSelectedTaskId(detail.taskId);
      return;
    }

    try {
      const params = new URLSearchParams({ connectorId, sourceId: detail.taskSourceId });
      const response = await fetch(`/api/sync/tasks/resolve?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to find task');
      if (!data.taskId) {
        toast.info('This task is no longer available.');
        return;
      }
      setSelectedTaskId(data.taskId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open task');
    }
  };

  return (
    <>
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">Sync History</h2>
      <p className="text-sm text-[var(--text-tertiary)] mb-6">
        Completed syncs, how they started, and whether automatic scheduling needs your attention.
      </p>

      {scheduleHealth && (
        <ScheduleHealthPanel
          health={scheduleHealth}
          connectorNames={connectorNames}
          onSync={handleScheduleSync}
          syncing={syncingConnectors}
        />
      )}

      {loading ? (
        <SyncHistorySkeleton />
      ) : entries.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-12 text-[var(--text-muted)]"
        >
          <RefreshCw size={28} className="mb-3 opacity-40" />
          <p className="text-sm">Sync history will appear here once you run your first sync.</p>
          <p className="text-xs mt-1">You&apos;re all set up — just hit sync when ready.</p>
        </motion.div>
      ) : (
        <>
        <div className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl overflow-hidden">
          {entries.map((entry, idx) => {
            const errors = parseErrors(entry.errors);
            const auditDetails = parseDetails(entry.details);
            const isExpanded = expandedId === entry.id;
            const hasErrors = errors.length > 0;
            const totalChanges = entry.tasksAdded + entry.tasksUpdated + entry.tasksRemoved;
            const pushed = entry.tasksPushed || 0;
            const protectedFromDetails = auditDetails.filter(d => d.action === 'protected').length;
            const protectedCount = Math.max(entry.localOnlyProtected || 0, protectedFromDetails);

            return (
              <div key={entry.id}
                className={idx < entries.length - 1 ? 'border-b border-[var(--border-subtle)]' : ''}
              >
                {/* Main row — clickable */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[var(--surface-0)] transition-colors text-left"
                >
                  {/* Status icon */}
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    entry.success && !hasErrors
                      ? 'bg-emerald-900/30 text-emerald-400'
                      : entry.success && hasErrors
                      ? 'bg-amber-900/30 text-amber-400'
                      : 'bg-red-900/30 text-red-400'
                  }`}>
                    {entry.success && !hasErrors ? <CheckCircle2 size={15} /> : hasErrors ? <AlertTriangle size={15} /> : <XCircle size={15} />}
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {connectorNames[entry.connectorId] || entry.connectorId}
                      </span>
                      {!entry.success && (
                        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 uppercase tracking-wide">Failed</span>
                      )}
                      {entry.success && hasErrors && (
                        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 uppercase tracking-wide">Partial</span>
                      )}
                      {entry.trigger && (
                        <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
                          {triggerLabels[entry.trigger]}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-2 font-variant-numeric tabular-nums">
                      {entry.tasksAdded > 0 && <span className="text-emerald-400">+{fmt(entry.tasksAdded)} added</span>}
                      {entry.tasksUpdated > 0 && <span className="text-blue-400">~{fmt(entry.tasksUpdated)} updated</span>}
                      {entry.tasksRemoved > 0 && <span className="text-red-400">-{fmt(entry.tasksRemoved)} removed</span>}
                      {pushed > 0 && <span className="text-purple-400">↑{fmt(pushed)} pushed</span>}
                      {protectedCount > 0 && <span className="text-amber-400">🛡{fmt(protectedCount)} retained locally</span>}
                      {entry.notificationsAdded > 0 && <span className="text-amber-400">{fmt(entry.notificationsAdded)} notifications</span>}
                      {totalChanges === 0
                        && pushed === 0
                        && protectedCount === 0
                        && entry.notificationsAdded === 0
                        && entry.success
                        && <span>No changes</span>}
                      {!entry.success && errors.length > 0 && <span className="text-red-400 truncate max-w-[200px]">{errors[0]?.slice(0, 60)}</span>}
                    </div>
                  </div>

                  {/* Time + duration */}
                  <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                    <div className="text-xs text-[var(--text-tertiary)]">{formatRelativeTime(entry.syncedAt)}</div>
                    {entry.durationMs != null && (
                      <div className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                        <Clock size={9} />
                        {formatDuration(entry.durationMs)}
                      </div>
                    )}
                    {entry.startedAt && entry.scheduledFor && new Date(entry.startedAt) > new Date(entry.scheduledFor) && (
                      <div className="text-[10px] text-amber-400">
                        {formatElapsed(new Date(entry.startedAt).getTime() - new Date(entry.scheduledFor).getTime())} late
                      </div>
                    )}
                  </div>

                  {/* Expand chevron */}
                  <motion.div
                    animate={{ rotate: isExpanded ? 90 : 0 }}
                    transition={{ duration: 0.15 }}
                    className="text-[var(--text-muted)] flex-shrink-0"
                  >
                    <ChevronRight size={14} />
                  </motion.div>
                </button>

                {/* Expanded detail panel */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4 pt-1 ml-11 space-y-3">
                        {/* Stats grid — clickable KPI cards filter the detail list */}
                        <DetailPanel
                          entry={entry}
                          auditDetails={auditDetails}
                          connectorCapabilities={connectors.find((connector) => connector.id === entry.connectorId)?.capabilities ?? {}}
                          pushed={pushed}
                          formatDuration={formatDuration}
                          handleRetry={handleRetry}
                          errors={errors}
                          hasErrors={hasErrors}
                          onResolutionRecorded={(results) => handleResolutionRecorded(entry.id, results)}
                          onOpenDetail={openAuditDetail}
                        />

                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>

        {hasMore && (
          <div className="flex justify-center mt-4">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-[var(--surface-1)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {loadingMore ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Loading…
                </>
              ) : (
                'Load more'
              )}
            </button>
          </div>
        )}
        </>
      )}
      {selectedTaskId && (
        <TaskDetailPanel
          taskId={selectedTaskId}
          mode="dialog"
          portalDialog
          onClose={() => setSelectedTaskId(null)}
        />
      )}
      {selectedSnapshotId && (
        <RemovedTaskDialog
          snapshotId={selectedSnapshotId}
          onClose={() => setSelectedSnapshotId(null)}
          onOpenTask={taskId => {
            setSelectedSnapshotId(null);
            setSelectedTaskId(taskId);
          }}
        />
      )}
    </>
  );
}


export { SyncHistorySection };
