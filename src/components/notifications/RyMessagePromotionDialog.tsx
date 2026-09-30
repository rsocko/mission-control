'use client';

import { useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { useQuickAddDestinations } from '@/lib/hooks/useQuickAddDestinations';
import type { QuickAddDestination } from '@/components/add-task/quick-add-types';

interface PromotionSeed {
  title: string;
  body?: string | null;
  priority?: string;
  actionId: string;
  connectorId: string;
  sourceNotificationId: string;
}

interface PromotionRow {
  intentId: string;
  title: string;
  destinationKey: string;
  state: 'idle' | 'creating' | 'created' | 'failed';
  error?: string;
  taskId?: string;
}

function destinationKey(destination: QuickAddDestination): string {
  return `${destination.id}:${destination.listId ?? ''}`;
}

export function RyMessagePromotionDialog({
  seed,
  onClose,
}: {
  seed: PromotionSeed;
  onClose: () => void;
}) {
  const { destinations } = useQuickAddDestinations({
    sourceFilter: null,
    listFilter: null,
    listFilterName: null,
    listFilterConnectorType: null,
  });
  const eligibleDestinations = useMemo(() => destinations.filter(destination => (
    destination.listSelectionMode !== 'required' || Boolean(destination.listId)
  )), [destinations]);
  const initialDestinationKey = destinationKey(eligibleDestinations[0] ?? {
    id: 'local',
    connectorType: 'local',
  } as QuickAddDestination);
  const [rows, setRows] = useState<PromotionRow[]>([{
    intentId: crypto.randomUUID(),
    title: seed.title,
    destinationKey: initialDestinationKey,
    state: 'idle',
  }]);
  const [submitting, setSubmitting] = useState(false);

  function destinationFor(row: PromotionRow): QuickAddDestination | undefined {
    return eligibleDestinations.find(destination => destinationKey(destination) === row.destinationKey);
  }

  function patchRow(intentId: string, patch: Partial<PromotionRow>) {
    setRows(current => current.map(row => row.intentId === intentId ? { ...row, ...patch } : row));
  }

  function addRow() {
    setRows(current => [...current, {
      intentId: crypto.randomUUID(),
      title: seed.title,
      destinationKey: destinationKey(eligibleDestinations[0] ?? {
        id: 'local',
        connectorType: 'local',
      } as QuickAddDestination),
      state: 'idle',
    }]);
  }

  async function createTasks() {
    const pending = rows.filter(row => row.state !== 'created');
    if (pending.length === 0) return;
    setSubmitting(true);
    setRows(current => current.map(row => (
      row.state === 'created' ? row : { ...row, state: 'creating', error: undefined }
    )));
    try {
      const intents = pending.map(row => {
        const destination = destinationFor(row);
        return {
          intentId: row.intentId,
          title: row.title.trim(),
          description: seed.body || '',
          priority: seed.priority || 'none',
          connectorType: destination?.connectorType || 'local',
          connectorInstanceId: destination?.id || 'local',
          sourceListId: destination?.listId,
        };
      });
      const intentResponse = await fetch(
        `/api/notifications/${seed.sourceNotificationId}/rymessage-promotion-intents`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: intents }),
        },
      );
      const intentPayload = await intentResponse.json() as {
        results?: Array<{ intentId: string; success: boolean; error?: string }>;
        error?: string;
      };
      if (!intentResponse.ok) {
        throw new Error(intentPayload.error || 'Companion rejected the promotion batch');
      }
      const registrationById = new Map(
        (intentPayload.results || []).map(result => [result.intentId, result]),
      );
      await Promise.all(pending.map(async row => {
        const registration = registrationById.get(row.intentId);
        if (!registration?.success) {
          patchRow(row.intentId, {
            state: 'failed',
            error: registration?.error || 'Companion did not persist this intent',
          });
          return;
        }
        const destination = destinationFor(row);
        const response = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: row.intentId,
            rymessagePromotion: {
              actionId: seed.actionId,
              notificationId: seed.sourceNotificationId,
              connectorId: seed.connectorId,
            },
            title: row.title.trim(),
            description: seed.body || undefined,
            priority: seed.priority || 'none',
            connectorType: destination?.connectorType || 'local',
            connectorInstanceId: destination?.id || undefined,
            sourceListId: destination?.listId,
            sourceListName: destination?.listName,
          }),
        });
        const taskPayload = await response.json() as { id?: string; error?: string };
        patchRow(row.intentId, response.ok && taskPayload.id
          ? { state: 'created', taskId: taskPayload.id, error: undefined }
          : { state: 'failed', error: taskPayload.error || 'Task creation failed' });
      }));
    } catch (error) {
      setRows(current => current.map(row => row.state === 'creating'
        ? {
            ...row,
            state: 'failed',
            error: error instanceof Error ? error.message : 'Promotion failed',
          }
        : row));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="rymessage-promotion-title">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 id="rymessage-promotion-title" className="text-lg font-semibold text-[var(--text-primary)]">Create linked tasks</h2>
            <p className="mt-1 text-sm text-[var(--text-tertiary)]">Choose any writable destination. Each row is retried independently without duplicating a task.</p>
          </div>
          <button onClick={onClose} aria-label="Close task creation" className="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 p-5">
          {eligibleDestinations.length === 0 && (
            <div role="alert" className="rounded-lg border border-amber-800/40 bg-amber-950/30 p-3 text-sm text-amber-200">
              No writable task destination is available. Enable a task provider or use Mission Control local tasks.
            </div>
          )}
          {rows.map((row, index) => (
            <div key={row.intentId} className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)_auto]">
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                Task {index + 1}
                <input value={row.title} disabled={row.state === 'created'} onChange={event => patchRow(row.intentId, { title: event.target.value, state: 'idle' })}
                  className="mt-1 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60" />
              </label>
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                Destination
                <select value={row.destinationKey} disabled={row.state === 'created'} onChange={event => patchRow(row.intentId, { destinationKey: event.target.value, state: 'idle' })}
                  className="mt-1 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60">
                  {eligibleDestinations.map(destination => (
                    <option key={destinationKey(destination)} value={destinationKey(destination)}>
                      {destination.label}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => setRows(current => current.filter(candidate => candidate.intentId !== row.intentId))}
                disabled={rows.length === 1 || row.state === 'creating'}
                aria-label={`Remove task ${index + 1}`}
                className="self-end rounded-lg p-2 text-[var(--text-muted)] hover:bg-red-950/30 hover:text-red-300 disabled:opacity-30">
                <Trash2 size={16} />
              </button>
              {row.state === 'created' && <p className="text-xs text-emerald-300 sm:col-span-3">Task linked successfully.</p>}
              {row.state === 'failed' && <p role="alert" className="text-xs text-red-300 sm:col-span-3">{row.error}</p>}
            </div>
          ))}
          <button onClick={addRow} disabled={rows.length >= 16 || submitting}
            className="inline-flex items-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50">
            <Plus size={15} /> Add another task
          </button>
        </div>

        <div className="flex justify-end gap-3 border-t border-[var(--border)] px-5 py-4">
          <button onClick={onClose} className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            {rows.some(row => row.state === 'created') ? 'Done' : 'Cancel'}
          </button>
          <button onClick={createTasks} disabled={submitting || rows.every(row => row.state === 'created') || rows.some(row => !row.title.trim()) || eligibleDestinations.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {submitting && <Loader2 size={15} className="animate-spin" />}
            {rows.some(row => row.state === 'failed') ? 'Retry failed tasks' : 'Create tasks'}
          </button>
        </div>
      </div>
    </div>
  );
}
