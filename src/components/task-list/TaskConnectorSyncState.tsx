'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  GitMerge,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { getConnectorLabel } from '@/lib/constants/colors';
import { notifyTaskChanged } from '@/lib/task-change-events';
import { cn } from '@/lib/utils';

type OperationState = 'confirmed' | 'pending' | 'failed' | 'blocked' | 'conflicted' | 'unknown';

interface OperationPresentation {
  state: OperationState;
  label: string;
  detail: (sourceLabel: string, retryCount: number) => string;
  className: string;
  icon: typeof CheckCircle2;
}

const PRESENTATIONS: Record<OperationState, OperationPresentation> = {
  confirmed: {
    state: 'confirmed',
    label: 'Confirmed',
    detail: (sourceLabel) => `Changes are confirmed by ${sourceLabel}.`,
    className: 'border-emerald-800/40 bg-emerald-950/35 text-emerald-300',
    icon: CheckCircle2,
  },
  pending: {
    state: 'pending',
    label: 'Pending',
    detail: (sourceLabel) => `Saved in Mission Control. Waiting for ${sourceLabel} to confirm the change.`,
    className: 'border-blue-800/40 bg-blue-950/35 text-blue-300',
    icon: Loader2,
  },
  failed: {
    state: 'failed',
    label: 'Failed',
    detail: (sourceLabel, retryCount) => (
      `Delivery to ${sourceLabel} failed${retryCount > 0 ? ` after ${retryCount} attempt${retryCount === 1 ? '' : 's'}` : ''}. It will retry on the next sync.`
    ),
    className: 'border-amber-800/40 bg-amber-950/35 text-amber-300',
    icon: AlertTriangle,
  },
  blocked: {
    state: 'blocked',
    label: 'Blocked',
    detail: (sourceLabel, retryCount) => (
      `Automatic delivery to ${sourceLabel} stopped${retryCount > 0 ? ` after ${retryCount} attempts` : ''}. Check the connector, then retry.`
    ),
    className: 'border-red-800/40 bg-red-950/35 text-red-300',
    icon: ShieldAlert,
  },
  conflicted: {
    state: 'conflicted',
    label: 'Conflicted',
    detail: (sourceLabel) => (
      `${sourceLabel} changed at the same time. Sync again to reconcile before making another edit.`
    ),
    className: 'border-orange-800/40 bg-orange-950/35 text-orange-300',
    icon: GitMerge,
  },
  unknown: {
    state: 'unknown',
    label: 'State unknown',
    detail: (sourceLabel) => (
      `Mission Control could not confirm the current ${sourceLabel} operation state. Sync to check it.`
    ),
    className: 'border-slate-700 bg-slate-950/35 text-slate-300',
    icon: CircleHelp,
  },
};

export function getTaskOperationPresentation(syncStatus: string | null | undefined) {
  switch (syncStatus) {
    case 'synced':
      return PRESENTATIONS.confirmed;
    case 'pending_push':
    case 'pushing':
    case 'move_in_progress':
      return PRESENTATIONS.pending;
    case 'push_error':
    case 'error':
      return PRESENTATIONS.failed;
    case 'push_failed':
      return PRESENTATIONS.blocked;
    case 'conflict':
      return PRESENTATIONS.conflicted;
    default:
      return PRESENTATIONS.unknown;
  }
}

interface TaskConnectorSyncStateProps {
  taskId?: string;
  syncStatus?: string | null;
  connectorType: string;
  connectorInstanceId?: string | null;
  pushRetryCount?: number | null;
  compact?: boolean;
  onRetryComplete?: () => void | Promise<void>;
}

export function TaskConnectorSyncState({
  taskId,
  syncStatus,
  connectorType,
  connectorInstanceId,
  pushRetryCount = 0,
  compact = false,
  onRetryComplete,
}: TaskConnectorSyncStateProps) {
  const presentation = getTaskOperationPresentation(syncStatus);
  const sourceLabel = getConnectorLabel(connectorType);
  const Icon = presentation.icon;
  const canRetry = !compact
    && connectorType !== 'local'
    && Boolean(connectorInstanceId)
    && presentation.state !== 'confirmed';
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  const retrySync = async () => {
    if (!connectorInstanceId || retrying) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setRetryMessage('You are offline. Retry when your connection returns.');
      return;
    }

    setRetrying(true);
    setRetryMessage(null);
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId: connectorInstanceId }),
      });
      const payload = await response.json().catch(() => ({})) as {
        results?: Array<{ success?: boolean }>;
      };
      if (!response.ok || payload.results?.[0]?.success === false) {
        throw new Error('Connector sync was rejected');
      }
      setRetryMessage(`Sync with ${sourceLabel} finished. Checking the task state.`);
      if (taskId) notifyTaskChanged(taskId);
      await onRetryComplete?.();
    } catch {
      setRetryMessage(`Could not sync with ${sourceLabel}. Check the connector and try again.`);
    } finally {
      setRetrying(false);
    }
  };

  if (connectorType === 'local' || connectorType === 'mission-control') return null;

  if (compact) {
    return (
      <span
        role="status"
        aria-live="polite"
        aria-label={`${sourceLabel} sync state: ${presentation.label}`}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium leading-none',
          presentation.className,
        )}
      >
        <Icon
          size={10}
          aria-hidden="true"
          className={presentation.state === 'pending' ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
        {presentation.label}
      </span>
    );
  }

  return (
    <section
      aria-label="Connector operation state"
      className={cn('rounded-lg border p-3', presentation.className)}
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {sourceLabel} sync state: {presentation.label}
      </span>
      <div className="flex items-start gap-2.5">
        <Icon
          size={18}
          aria-hidden="true"
          className={cn(
            'mt-0.5 shrink-0',
            presentation.state === 'pending' && 'animate-spin motion-reduce:animate-none',
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{presentation.label}</p>
          <p className="mt-0.5 text-xs leading-5 opacity-90">
            {presentation.detail(sourceLabel, pushRetryCount ?? 0)}
          </p>
        </div>
        {canRetry && (
          <button
            type="button"
            onClick={() => { void retrySync(); }}
            disabled={retrying}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-current/30 px-3 text-xs font-semibold transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
              className={retrying ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            {retrying ? 'Syncing' : 'Retry'}
          </button>
        )}
      </div>
      {retryMessage && (
        <p
          role={retryMessage.startsWith('Could not') || retryMessage.startsWith('You are offline') ? 'alert' : 'status'}
          aria-live="polite"
          className="mt-2 border-t border-current/20 pt-2 text-xs leading-5"
        >
          {retryMessage}
        </p>
      )}
    </section>
  );
}
