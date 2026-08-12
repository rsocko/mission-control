'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Cloud,
  CloudOff,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip, TooltipProvider } from '@/components/ui/Tooltip';
import type {
  TaskRelationship,
  TaskRelationshipCandidate,
} from '@/lib/task-relationships-types';
import {
  announceTaskRelationshipsChanged,
  TASK_RELATIONSHIPS_CHANGED_EVENT,
  type TaskRelationshipsChangedDetail,
} from '@/lib/task-relationships-events';
import { cn } from '@/lib/utils';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface TaskRelationshipsSectionProps {
  taskId: string;
  canEdit?: boolean;
  onUpdate?: () => void;
  className?: string;
  touch?: boolean;
}

type RelationshipType = 'blocks' | 'related';
type BlockingDirection = 'incoming' | 'outgoing';

const SYNC_LABELS: Record<TaskRelationship['edge']['syncStatus'], string> = {
  local: 'Local only',
  pending: 'Sync pending',
  synced: 'Synced',
  failed: 'Sync failed',
};

function SyncState({ relationship }: { relationship: TaskRelationship }) {
  const Icon = relationship.edge.syncStatus === 'failed'
    ? CloudOff
    : relationship.edge.syncStatus === 'pending' ? Loader2 : Cloud;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] ${
        relationship.edge.syncStatus === 'failed' ? 'text-red-400' : 'text-[var(--text-muted)]'
      }`}
      title={relationship.edge.syncError ?? SYNC_LABELS[relationship.edge.syncStatus]}
    >
      <Icon
        size={10}
        className={relationship.edge.syncStatus === 'pending' ? 'animate-spin' : ''}
        aria-hidden="true"
      />
      {SYNC_LABELS[relationship.edge.syncStatus]}
      {relationship.edge.syncAction ? ` (${relationship.edge.syncAction})` : ''}
    </span>
  );
}

function RelationshipRow({
  relationship,
  canEdit,
  touch,
  onRemove,
}: {
  relationship: TaskRelationship;
  canEdit: boolean;
  touch: boolean;
  onRemove: (relationship: TaskRelationship) => void;
}) {
  const isIncoming = relationship.direction === 'incoming';
  const isRelated = relationship.direction === 'related';
  const relationshipLabel = isRelated ? 'Related' : isIncoming ? 'Blocked by' : 'Blocks';
  const projectLabel = relationship.task.projectNames.join(', ');
  const displayId = getTaskDisplayId(
    relationship.task.connectorType ?? '',
    relationship.task.metadata,
    relationship.task.sourceId,
  );
  const RelationshipIcon = isRelated ? Link2 : ArrowRight;

  return (
    <li className="group rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2 py-1.5">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1 text-xs text-[var(--text-primary)]">
            <TooltipProvider>
              <Tooltip content={relationshipLabel}>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center justify-center',
                    isRelated ? 'text-violet-400' : 'text-orange-400',
                  )}
                  role="img"
                  aria-label={relationshipLabel}
                >
                  <RelationshipIcon
                    size={11}
                    className={isIncoming ? 'rotate-180' : undefined}
                    aria-hidden="true"
                  />
                </span>
              </Tooltip>
            </TooltipProvider>
            <span className="truncate" title={relationship.task.title}>
              {relationship.task.title}
            </span>
            {displayId && (
              <span className="shrink-0 text-[var(--text-muted)]">{displayId}</span>
            )}
          </div>
          {projectLabel && (
            <div className="truncate text-[10px] text-[var(--text-muted)]">{projectLabel}</div>
          )}
          <SyncState relationship={relationship} />
          {relationship.edge.syncError && (
            <p className="mt-0.5 text-[10px] text-red-400" role="status">
              {relationship.edge.syncError}
            </p>
          )}
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => onRemove(relationship)}
            className={cn(
              'rounded p-1 text-[var(--text-muted)] opacity-0 transition-[opacity,color] hover:text-red-400 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100',
              touch ? 'min-h-11 min-w-11 opacity-100' : 'min-h-7 min-w-7',
            )}
            aria-label={`Remove relationship with ${relationship.task.title}`}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

export function TaskRelationshipsSection({
  taskId,
  canEdit = true,
  onUpdate,
  className,
  touch = false,
}: TaskRelationshipsSectionProps) {
  const [relationships, setRelationships] = useState<TaskRelationship[]>([]);
  const [relationshipsTruncated, setRelationshipsTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('blocks');
  const [direction, setDirection] = useState<BlockingDirection>('outgoing');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<TaskRelationshipCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [addingTaskId, setAddingTaskId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [relationshipToRemove, setRelationshipToRemove] = useState<TaskRelationship | null>(null);
  const [removing, setRemoving] = useState(false);
  const loadRequestRef = useRef<AbortController | null>(null);
  const loadSequenceRef = useRef(0);
  const searchSequenceRef = useRef(0);
  const addSequenceRef = useRef(0);
  const removeSequenceRef = useRef(0);
  const activeTaskIdRef = useRef<string | null>(taskId);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const loadRelationships = useCallback(async () => {
    loadRequestRef.current?.abort();
    const controller = new AbortController();
    loadRequestRef.current = controller;
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/relationships`, {
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        relationships?: TaskRelationship[];
        pageInfo?: { truncated: boolean };
        error?: string;
      } | null;
      if (!response.ok || !payload?.relationships) {
        throw new Error(payload?.error || 'Failed to load relationships');
      }
      if (sequence === loadSequenceRef.current) {
        setRelationships(payload.relationships);
        setRelationshipsTruncated(payload.pageInfo?.truncated ?? false);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (sequence === loadSequenceRef.current) {
        setLoadError(error instanceof Error ? error.message : 'Failed to load relationships');
      }
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    activeTaskIdRef.current = taskId;
    const timer = window.setTimeout(() => void loadRelationships(), 0);
    return () => {
      window.clearTimeout(timer);
      loadRequestRef.current?.abort();
      activeTaskIdRef.current = null;
    };
  }, [loadRelationships, taskId]);

  useEffect(() => {
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<TaskRelationshipsChangedDetail>).detail;
      if (!detail?.taskIds.includes(taskId)) return;
      void loadRelationships();
    };
    window.addEventListener(TASK_RELATIONSHIPS_CHANGED_EVENT, handleChange);
    return () => window.removeEventListener(TASK_RELATIONSHIPS_CHANGED_EVENT, handleChange);
  }, [loadRelationships, taskId]);

  useEffect(() => {
    if (!showEditor) return;
    const sequence = ++searchSequenceRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const params = new URLSearchParams({ query: query.trim(), limit: '20' });
        const response = await fetch(
          `/api/tasks/${taskId}/relationship-candidates?${params}`,
          { signal: controller.signal },
        );
        const payload = await response.json().catch(() => null) as {
          candidates?: TaskRelationshipCandidate[];
          error?: string;
        } | null;
        if (!response.ok || !payload?.candidates) {
          throw new Error(payload?.error || 'Failed to search tasks');
        }
        if (sequence === searchSequenceRef.current) setCandidates(payload.candidates);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (sequence === searchSequenceRef.current) {
          setSearchError(error instanceof Error ? error.message : 'Failed to search tasks');
        }
      } finally {
        if (sequence === searchSequenceRef.current) setSearching(false);
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, showEditor, taskId]);

  const grouped = useMemo(() => ({
    incoming: relationships.filter((relationship) => relationship.direction === 'incoming'),
    outgoing: relationships.filter((relationship) => relationship.direction === 'outgoing'),
    related: relationships.filter((relationship) => relationship.direction === 'related'),
  }), [relationships]);

  const addRelationship = useCallback(async (candidate: TaskRelationshipCandidate) => {
    const sequence = ++addSequenceRef.current;
    setAddingTaskId(candidate.id);
    setMutationError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relatedTaskId: candidate.id,
          type: relationshipType,
          direction: relationshipType === 'blocks' ? direction : undefined,
        }),
      });
      const payload = await response.json().catch(() => null) as {
        dependency?: { syncStatus: TaskRelationship['edge']['syncStatus'] };
        error?: string;
      } | null;
      if (!response.ok || !payload?.dependency) {
        throw new Error(payload?.error || 'Failed to add relationship');
      }
      announceTaskRelationshipsChanged([taskId, candidate.id]);
      if (sequence !== addSequenceRef.current || activeTaskIdRef.current !== taskId) return;
      setShowEditor(false);
      setQuery('');
      onUpdate?.();
      if (payload.dependency.syncStatus === 'failed') {
        toast.warning('Relationship saved locally, but source sync failed');
      } else {
        toast.success('Relationship added');
      }
    } catch (error) {
      if (sequence !== addSequenceRef.current || activeTaskIdRef.current !== taskId) return;
      const message = error instanceof Error ? error.message : 'Failed to add relationship';
      setMutationError(message);
      toast.error(message);
      announceTaskRelationshipsChanged([taskId, candidate.id]);
    } finally {
      if (sequence === addSequenceRef.current && activeTaskIdRef.current === taskId) {
        setAddingTaskId(null);
      }
    }
  }, [direction, onUpdate, relationshipType, taskId]);

  const removeRelationship = useCallback(async () => {
    if (!relationshipToRemove) return;
    const removingRelationship = relationshipToRemove;
    const sequence = ++removeSequenceRef.current;
    setRemoving(true);
    setMutationError(null);
    try {
      const response = await fetch(
        `/api/tasks/${taskId}/relationships/${encodeURIComponent(removingRelationship.edge.id)}`,
        { method: 'DELETE' },
      );
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || 'Failed to remove relationship');
      announceTaskRelationshipsChanged([taskId, removingRelationship.task.id]);
      if (sequence !== removeSequenceRef.current || activeTaskIdRef.current !== taskId) return;
      setRelationshipToRemove(null);
      onUpdate?.();
      toast.success('Relationship removed');
    } catch (error) {
      if (sequence !== removeSequenceRef.current || activeTaskIdRef.current !== taskId) return;
      const message = error instanceof Error ? error.message : 'Failed to remove relationship';
      setMutationError(message);
      setRelationshipToRemove(null);
      toast.error(message);
      announceTaskRelationshipsChanged([taskId, removingRelationship.task.id]);
    } finally {
      if (sequence === removeSequenceRef.current && activeTaskIdRef.current === taskId) {
        setRemoving(false);
      }
    }
  }, [onUpdate, relationshipToRemove, taskId]);

  const sections: Array<{
    key: keyof typeof grouped;
    label: string;
    emptyLabel: string;
  }> = [
    { key: 'incoming', label: 'Blocked by', emptyLabel: 'No tasks block this task' },
    { key: 'outgoing', label: 'Blocks', emptyLabel: 'This task blocks no other tasks' },
    { key: 'related', label: 'Related', emptyLabel: 'No related tasks' },
  ];

  return (
    <>
      <section
        aria-labelledby={`task-relationships-${taskId}`}
        className={cn('mb-4', className)}
        data-task-relationships
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link2 size={13} className="text-[var(--text-muted)]" aria-hidden="true" />
            <h3
              id={`task-relationships-${taskId}`}
              className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
            >
              Relationships
            </h3>
          </div>
          {canEdit && (
            <button
              type="button"
              ref={addButtonRef}
              onClick={() => {
                setShowEditor((open) => !open);
                setMutationError(null);
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 text-xs text-[var(--accent)] hover:bg-[var(--surface-1)]',
                touch ? 'min-h-11' : 'min-h-8',
              )}
              aria-expanded={showEditor}
              aria-controls={`relationship-editor-${taskId}`}
            >
              <Plus size={12} aria-hidden="true" />
              Add
            </button>
          )}
        </div>

        {showEditor && (
          <div
            id={`relationship-editor-${taskId}`}
            data-task-relationship-editor
            className="mb-2 space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-2"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setShowEditor(false);
                requestAnimationFrame(() => addButtonRef.current?.focus());
              }
            }}
          >
            <div className="flex gap-2">
              <label className="min-w-0 flex-1 text-[10px] text-[var(--text-muted)]">
                Relationship
                <Select
                  value={relationshipType}
                  onValueChange={(value) => setRelationshipType(value as RelationshipType)}
                >
                  <SelectTrigger
                    aria-label="Relationship"
                    className={cn('mt-0.5 w-full text-xs', touch ? 'h-11' : 'h-8 min-h-0')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="blocks">Blocks</SelectItem>
                    <SelectItem value="related">Related</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {relationshipType === 'blocks' && (
                <label className="min-w-0 flex-1 text-[10px] text-[var(--text-muted)]">
                  Direction
                  <Select
                    value={direction}
                    onValueChange={(value) => setDirection(value as BlockingDirection)}
                  >
                    <SelectTrigger
                      aria-label="Direction"
                      className={cn('mt-0.5 w-full text-xs', touch ? 'h-11' : 'h-8 min-h-0')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="outgoing">This task blocks...</SelectItem>
                      <SelectItem value="incoming">This task is blocked by...</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              )}
            </div>
            <label className="block text-[10px] text-[var(--text-muted)]">
              Find a task across all projects
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tasks..."
                autoFocus
                className={cn(
                  'mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]',
                  touch ? 'min-h-11' : 'min-h-8',
                )}
              />
            </label>
            <div className="max-h-44 overflow-y-auto" aria-live="polite">
              {searching ? (
                <div className="flex items-center gap-1 px-2 py-3 text-xs text-[var(--text-muted)]">
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  Searching tasks...
                </div>
              ) : searchError ? (
                <div className="space-y-1 px-2 py-2 text-xs text-red-400" role="alert">
                  <p>{searchError}</p>
                  <button
                    type="button"
                    onClick={() => setQuery((value) => `${value} `)}
                    className={cn(
                      'inline-flex items-center gap-1 text-[var(--accent)]',
                      touch ? 'min-h-11' : 'min-h-7',
                    )}
                  >
                    <RefreshCw size={11} aria-hidden="true" />
                    Retry
                  </button>
                </div>
              ) : candidates.length === 0 ? (
                <p className="px-2 py-3 text-xs text-[var(--text-muted)]">No matching tasks</p>
              ) : (
                <ul>
                  {candidates.map((candidate) => {
                    const displayId = getTaskDisplayId(
                      candidate.connectorType,
                      candidate.metadata,
                      candidate.sourceId,
                    );
                    return (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          disabled={addingTaskId !== null}
                          onClick={() => void addRelationship(candidate)}
                          className={cn(
                            'flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] disabled:opacity-50',
                            touch ? 'min-h-11' : 'min-h-9',
                          )}
                          aria-label={`Add relationship with ${candidate.title}`}
                        >
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-1">
                              <span className="truncate">{candidate.title}</span>
                              {displayId && (
                                <span className="shrink-0 text-[var(--text-muted)]">{displayId}</span>
                              )}
                            </span>
                            <span className="block truncate text-[10px] text-[var(--text-muted)]">
                              {candidate.projectNames.join(', ') || candidate.sourceListName || 'No project'}
                            </span>
                          </span>
                          {addingTaskId === candidate.id && (
                            <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden="true" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}

        {mutationError && (
          <div className="mb-2 flex items-start gap-1 text-xs text-red-400" role="alert">
            <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            {mutationError}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-[var(--text-muted)]" role="status">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            Loading relationships...
          </div>
        ) : loadError ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400" role="alert">
            <p>{loadError}</p>
            <button
              type="button"
              onClick={() => void loadRelationships()}
              className={cn(
                'mt-1 inline-flex items-center gap-1 text-[var(--accent)]',
                touch ? 'min-h-11' : 'min-h-7',
              )}
            >
              <RefreshCw size={11} aria-hidden="true" />
              Retry
            </button>
          </div>
        ) : relationships.length === 0 ? (
          <p className="py-2 text-xs text-[var(--text-muted)]">No task relationships</p>
        ) : (
          <div className="space-y-2">
            {sections.map((section) => (
              <div key={section.key}>
                <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  {section.label}
                </h4>
                {grouped[section.key].length === 0 ? (
                  <p className="text-[10px] text-[var(--text-muted)]">{section.emptyLabel}</p>
                ) : (
                  <ul className="space-y-1" aria-label={section.label}>
                    {grouped[section.key].map((relationship) => (
                      <RelationshipRow
                        key={relationship.edge.id}
                        relationship={relationship}
                        canEdit={canEdit}
                        touch={touch}
                        onRemove={setRelationshipToRemove}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {relationshipsTruncated && (
              <p className="text-[10px] text-amber-400" role="status">
                Showing the first 249 relationships.
              </p>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={relationshipToRemove !== null}
        title="Remove task relationship?"
        message={relationshipToRemove
          ? `Remove the relationship with "${relationshipToRemove.task.title}"? Connector-backed relationships will also be removed from their source.`
          : ''}
        confirmLabel={removing ? 'Removing...' : 'Remove'}
        confirmVariant="danger"
        onConfirm={() => void removeRelationship()}
        onCancel={() => !removing && setRelationshipToRemove(null)}
      />
    </>
  );
}
