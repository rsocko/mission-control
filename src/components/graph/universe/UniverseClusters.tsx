'use client';

import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Check,
  Layers3,
  LoaderCircle,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  UniverseCluster,
  UniverseClusterDestination,
  UniverseClusterProjection,
  UniverseSubgraph,
} from '@/lib/graph/universe-types';

export type UniverseClusterFilter = 'all' | 'outliers' | string;

export function UniverseClusterControls({
  enabled,
  available,
  projection,
  filter,
  onToggle,
  onFilterChange,
}: {
  enabled: boolean;
  available: boolean;
  projection: UniverseClusterProjection | null;
  filter: UniverseClusterFilter;
  onToggle: () => void;
  onFilterChange: (filter: UniverseClusterFilter) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1" aria-label="Transient cluster controls">
      <button
        type="button"
        onClick={onToggle}
        disabled={!available}
        aria-pressed={enabled}
        title={available
          ? 'Group the current authorized graph without changing saved data'
          : 'Universe cluster grouping is disabled'}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)] disabled:cursor-not-allowed disabled:opacity-40 ${
          enabled
            ? 'border-violet-400/60 bg-violet-500/15 text-violet-100'
            : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
        }`}
      >
        <Layers3 size={12} aria-hidden="true" />
        {enabled ? 'Transient groups on' : 'Group by meaning'}
      </button>
      {enabled && projection ? (
        <label className="flex min-w-0 items-center gap-1 text-xs text-[var(--text-tertiary)]">
          <span className="sr-only">Filter transient clusters</span>
          <select
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            className="h-7 max-w-44 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-500)]"
          >
            <option value="all">All {projection.clusters.length} groups</option>
            {projection.clusters.map((cluster) => (
              <option key={cluster.id} value={cluster.id}>
                {cluster.label} ({cluster.taskIds.length})
              </option>
            ))}
            <option value="outliers">
              Ungrouped ({projection.outlierNodeIds.length})
            </option>
          </select>
        </label>
      ) : null}
    </div>
  );
}

export function UniverseClusterSummary({
  projection,
  graph,
  onFilter,
  onSave,
}: {
  projection: UniverseClusterProjection;
  graph: UniverseSubgraph;
  onFilter: (filter: UniverseClusterFilter) => void;
  onSave: (cluster: UniverseCluster) => void;
}) {
  if (!projection.clusters.length) {
    return (
      <div
        role="status"
        className="absolute left-3 top-3 z-10 max-w-sm rounded-lg border border-violet-400/25 bg-slate-950/95 px-3 py-2 text-xs text-violet-100 shadow-lg"
      >
        No stable groups meet the current {Math.round(projection.settings.resolution * 100)}%
        {' '}similarity and {projection.settings.minimumSize}-task minimum. The graph remains unchanged.
      </div>
    );
  }
  const labelsByNodeId = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return (
    <aside
      aria-label="Computed transient groups"
      className="absolute left-3 top-3 z-10 hidden w-72 overflow-hidden rounded-lg border border-violet-400/25 bg-slate-950/95 shadow-xl xl:block"
    >
      <div className="border-b border-violet-400/20 px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-violet-100">
          <Sparkles size={13} aria-hidden="true" />
          Computed, not saved
        </div>
        <p className="mt-1 text-xs leading-4 text-slate-300">
          Deterministic semantic groups in this bounded graph. Re-indexing can change them.
        </p>
      </div>
      <ol className="max-h-72 overflow-y-auto p-2">
        {projection.clusters.map((cluster) => (
          <li key={cluster.id} className="border-b border-slate-800 px-1 py-2 last:border-0">
            <div className="flex items-start gap-2">
              <span
                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: cluster.color }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-slate-100">{cluster.label}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {cluster.taskIds.length} tasks · {Math.round(cluster.confidence * 100)}% confidence
                </p>
                <p className="mt-1 line-clamp-2 text-xs leading-4 text-slate-300">
                  {cluster.representativeNodeIds
                    .map((nodeId) => labelsByNodeId.get(nodeId))
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <div className="mt-2 flex gap-1">
                  <button
                    type="button"
                    onClick={() => onFilter(cluster.id)}
                    className="rounded border border-slate-700 px-1.5 py-1 text-xs font-semibold text-slate-200 hover:border-violet-400"
                  >
                    Isolate
                  </button>
                  <button
                    type="button"
                    onClick={() => onSave(cluster)}
                    className="rounded border border-violet-400/50 bg-violet-500/10 px-1.5 py-1 text-xs font-semibold text-violet-100 hover:bg-violet-500/20"
                  >
                    Review & save
                  </button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function UniverseClusterReviewPanel({
  cluster,
  graph,
  projectionFingerprint,
  onClose,
  onSaved,
}: {
  cluster: UniverseCluster;
  graph: UniverseSubgraph;
  projectionFingerprint: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const members = useMemo(() => {
    const memberIds = new Set(cluster.memberNodeIds);
    return graph.nodes
      .filter((node) => node.kind === 'task' && memberIds.has(node.id))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [cluster.memberNodeIds, graph.nodes]);
  const [selectedTaskIds, setSelectedTaskIds] = useState(() =>
    new Set(members.map((node) => node.entityId)));
  const [destination, setDestination] = useState<UniverseClusterDestination>('project');
  const [name, setName] = useState(cluster.label);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!confirmed || !name.trim() || selectedTaskIds.size === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/graph/universe/clusters/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          destination,
          name: name.trim(),
          taskIds: [...selectedTaskIds],
          clusterId: cluster.id,
          projectionFingerprint,
        }),
      });
      const payload = await response.json() as {
        status?: 'saved' | 'partial';
        destinationId?: string;
        savedTaskIds?: string[];
        failures?: Array<{ message: string }>;
        error?: string;
      };
      if (!response.ok && response.status !== 207) {
        throw new Error(payload.error ?? 'The reviewed group could not be saved');
      }
      if (payload.status === 'partial') {
        setError(
          `${payload.savedTaskIds?.length ?? 0} task${
            (payload.savedTaskIds?.length ?? 0) === 1 ? '' : 's'
          } saved; ${
            payload.failures?.length ?? 0
          } failed. ${payload.failures?.[0]?.message ?? 'Review the destination before retrying.'}`,
        );
        return;
      }
      onSaved(
        `${selectedTaskIds.size} reviewed task${selectedTaskIds.size === 1 ? '' : 's'} saved to ${
          destination === 'project' ? 'project' : 'tag'
        } “${name.trim()}”.`,
      );
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The reviewed group could not be saved');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/55" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-violet-400/30 bg-[var(--surface-1)] shadow-2xl outline-none sm:w-[420px]">
      <div className="flex items-start gap-3 border-b border-[var(--border)] p-4">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="text-sm font-semibold text-[var(--text-primary)]">
            Review before saving
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
            “{cluster.label}” is computed, not canonical. Choose the exact members and destination.
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <Button variant="ghost" size="icon" aria-label="Cancel cluster save">
            <X size={16} />
          </Button>
        </Dialog.Close>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <fieldset>
          <legend className="text-xs font-semibold text-[var(--text-primary)]">
            Destination
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(['project', 'tag'] as const).map((value) => (
              <label
                key={value}
                className={`cursor-pointer rounded-lg border p-3 text-xs ${
                  destination === value
                    ? 'border-violet-400 bg-violet-500/10 text-violet-100'
                    : 'border-[var(--border)] text-[var(--text-secondary)]'
                }`}
              >
                <input
                  type="radio"
                  name="cluster-destination"
                  value={value}
                  checked={destination === value}
                  onChange={() => setDestination(value)}
                  className="mr-2 accent-violet-500"
                />
                {value === 'project' ? 'New project' : 'New or existing tag'}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs leading-4 text-[var(--text-tertiary)]">
            Saved graph views and named collections remain unavailable until their domain commands ship.
          </p>
        </fieldset>
        <label className="mt-5 block text-xs font-semibold text-[var(--text-primary)]">
          {destination === 'project' ? 'Project name' : 'Tag name'}
          <input
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value);
              setConfirmed(false);
            }}
            className="mt-2 h-9 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-500)]"
          />
        </label>
        <fieldset className="mt-5">
          <legend className="flex w-full items-center justify-between text-xs font-semibold text-[var(--text-primary)]">
            Membership
            <span className="font-normal text-[var(--text-tertiary)]">
              {selectedTaskIds.size} of {members.length}
            </span>
          </legend>
          <ol className="mt-2 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {members.map((member) => (
              <li key={member.id}>
                <label className="flex cursor-pointer items-start gap-2 px-3 py-2.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]">
                  <input
                    type="checkbox"
                    checked={selectedTaskIds.has(member.entityId)}
                    onChange={(event) => {
                      setSelectedTaskIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(member.entityId);
                        else next.delete(member.entityId);
                        return next;
                      });
                      setConfirmed(false);
                    }}
                    className="mt-0.5 accent-violet-500"
                  />
                  <span>{member.label}</span>
                </label>
              </li>
            ))}
          </ol>
        </fieldset>
        <label className="mt-5 flex cursor-pointer items-start gap-2 rounded-lg border border-violet-400/25 bg-violet-500/5 p-3 text-xs leading-5 text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-1 accent-violet-500"
          />
          <span>
            I reviewed these {selectedTaskIds.size} members and want to create canonical
            {' '}{destination === 'project' ? 'project membership' : 'tag assignments'}.
          </span>
        </label>
        {error ? (
          <div role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-950/70 p-3 text-xs leading-5 text-red-200">
            {error}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] p-4">
        <Dialog.Close asChild>
          <Button variant="ghost">Cancel</Button>
        </Dialog.Close>
        <Button
          onClick={() => void save()}
          disabled={!confirmed || !name.trim() || selectedTaskIds.size === 0 || saving}
        >
          {saving
            ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
            : confirmed
              ? <Check size={14} aria-hidden="true" />
              : <Save size={14} aria-hidden="true" />}
          {saving ? 'Saving reviewed group' : 'Confirm & save'}
        </Button>
      </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
