'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, Sparkles, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  executeProjectHierarchyCommand,
  loadProjectHierarchy,
} from '@/lib/projects/hierarchy-client';
import type { ProjectPhase } from '@/types';
import type { PhaseReorganizationProposal } from '@/lib/projects/phase-reorganization';

interface ProposalTask {
  id: string;
  title: string;
}

export function PhaseReorganizationReview({
  proposal,
  projectId,
  taskMap,
  isOpen,
  onAccept,
  onReject,
}: {
  proposal: PhaseReorganizationProposal;
  projectId: string;
  taskMap: Map<string, ProposalTask>;
  isOpen: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const changeIndexes = useMemo(() => proposal.destinations.flatMap((destination, index) => (
    destination.kind === 'new' || destination.phaseId !== proposal.sourcePhaseId
      ? [index]
      : []
  )), [proposal]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set(
    changeIndexes.flatMap((index) => proposal.destinations[index].taskIds),
  ));
  const [expanded, setExpanded] = useState<Set<number>>(
    () => new Set(proposal.destinations.map((_, index) => index)),
  );
  const [saving, setSaving] = useState(false);

  const selectedTaskCount = selectedTaskIds.size;
  const selectedNewPhaseCount = changeIndexes.filter((index) => (
    proposal.destinations[index]?.kind === 'new'
    && proposal.destinations[index].taskIds.some((taskId) => selectedTaskIds.has(taskId))
  )).length;

  function toggleDestination(index: number) {
    const taskIds = proposal.destinations[index]?.taskIds ?? [];
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      const allSelected = taskIds.every((taskId) => next.has(taskId));
      for (const taskId of taskIds) {
        if (allSelected) next.delete(taskId);
        else next.add(taskId);
      }
      return next;
    });
  }

  function toggleTask(taskId: string) {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  async function applyChanges() {
    if (selectedTaskIds.size === 0) {
      onReject();
      return;
    }
    setSaving(true);
    const toastId = toast.loading('Applying phase structure…');
    try {
      const hierarchy = await loadProjectHierarchy(projectId);
      if (hierarchy.revision !== proposal.hierarchyRevision) {
        throw new Error('The project plan changed after this review was generated. Generate a new review and try again.');
      }
      const now = new Date().toISOString();
      const sourceIndex = hierarchy.phases.findIndex((phase) => phase.id === proposal.sourcePhaseId);
      if (sourceIndex === -1) throw new Error('The phase no longer exists');

      const destinationPhaseIds = new Map<number, string>();
      const newPhases: ProjectPhase[] = [];
      for (const index of changeIndexes) {
        const destination = proposal.destinations[index];
        if (!destination) continue;
        if (!destination.taskIds.some((taskId) => selectedTaskIds.has(taskId))) continue;
        if (destination.kind === 'existing' && destination.phaseId) {
          destinationPhaseIds.set(index, destination.phaseId);
          continue;
        }
        const id = crypto.randomUUID();
        destinationPhaseIds.set(index, id);
        newPhases.push({
          id,
          projectId,
          name: destination.name,
          description: destination.description || null,
          status: 'pending',
          color: destination.color,
          estimatedDays: destination.estimatedDays,
          targetStart: null,
          targetEnd: null,
          startAfterPhaseId: null,
          sortOrder: 0,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const taskDestination = new Map<string, string>();
      for (const index of changeIndexes) {
        const phaseId = destinationPhaseIds.get(index);
        if (!phaseId) continue;
        for (const taskId of proposal.destinations[index].taskIds) {
          if (selectedTaskIds.has(taskId)) taskDestination.set(taskId, phaseId);
        }
      }
      const phaseOrder = [...hierarchy.phases];
      phaseOrder.splice(sourceIndex + 1, 0, ...newPhases);
      const finalPhases = phaseOrder.map((phase, index) => ({
        ...phase,
        projectId,
        sortOrder: index,
      }));
      const taskIdsByPhase = new Map(finalPhases.map((phase) => [phase.id, [] as string[]]));
      for (const phase of hierarchy.phases) {
        for (const item of hierarchy.phaseItemsByPhase[phase.id] ?? []) {
          const destinationId = taskDestination.get(item.taskId) ?? phase.id;
          taskIdsByPhase.get(destinationId)?.push(item.taskId);
        }
      }
      const itemByTaskId = new Map(
        Object.values(hierarchy.phaseItemsByPhase).flat().map((item) => [item.taskId, item]),
      );
      const placements = finalPhases.flatMap((phase) => (
        (taskIdsByPhase.get(phase.id) ?? []).map((taskId, index) => {
          const item = itemByTaskId.get(taskId);
          return {
            taskId,
            phaseId: phase.id,
            index,
            ...(item ? {
              item: {
                id: item.id,
                estimatedEffortHours: item.estimatedEffortHours,
                isProposed: item.isProposed,
                proposalType: item.proposalType,
                createdAt: item.createdAt,
              },
            } : {}),
          };
        })
      ));

      await executeProjectHierarchyCommand({
        projectId,
        expectedRevision: hierarchy.revision,
        command: {
          type: 'replace_phase_structure',
          phases: finalPhases,
          placements,
        },
      });
      toast.success('Phase structure updated.', { id: toastId });
      onAccept();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to apply phase structure', {
        id: toastId,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open && !saving) onReject(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(94vw,64rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-4">
            <div>
              <Dialog.Title className="text-xl font-semibold text-[var(--text-primary)]">
                Phase structure review
              </Dialog.Title>
              <Dialog.Description className="mt-1 max-w-3xl text-sm text-[var(--text-tertiary)]">
                {proposal.overallReasoning}
              </Dialog.Description>
            </div>
            <Button variant="ghost" onClick={onReject} disabled={saving} aria-label="Close phase structure review">
              <X />
            </Button>
          </div>

          <div className="overflow-y-auto px-6 py-5">
            {changeIndexes.length === 0 ? (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5">
                <div className="flex items-center gap-2 font-medium text-emerald-300">
                  <Check size={16} />
                  Keep this phase as-is
                </div>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  AI found the current grouping cohesive enough that subdividing it would not improve the plan.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 px-4 py-3 text-sm text-[var(--text-secondary)]">
                  <span className="font-medium text-[var(--text-primary)]">Proposed result:</span>{' '}
                  {selectedTaskCount} task{selectedTaskCount === 1 ? '' : 's'} move
                  {selectedNewPhaseCount > 0
                    ? ` into ${selectedNewPhaseCount} new phase${selectedNewPhaseCount === 1 ? '' : 's'}`
                    : ' into existing phases'}.
                </div>
                {proposal.destinations.map((destination, index) => {
                  const isChange = changeIndexes.includes(index);
                  const selectedCount = destination.taskIds.filter(
                    (taskId) => selectedTaskIds.has(taskId),
                  ).length;
                  const isSelected = selectedCount === destination.taskIds.length;
                  const isExpanded = expanded.has(index);
                  return (
                    <section key={`${destination.kind}-${destination.phaseId ?? destination.name}-${index}`} className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)]">
                      <div className="flex items-center gap-3 p-4">
                        <button
                          type="button"
                          onClick={() => setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(index)) next.delete(index); else next.add(index);
                            return next;
                          })}
                          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                          aria-label={isExpanded ? 'Collapse destination' : 'Expand destination'}
                        >
                          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: destination.color ?? 'var(--text-muted)' }} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-medium text-[var(--text-primary)]">{destination.name}</h3>
                            <Badge variant={destination.kind === 'new' ? 'default' : 'outline'}>
                              {destination.kind === 'new' ? 'New phase' : destination.phaseId === proposal.sourcePhaseId ? 'Stays here' : 'Existing phase'}
                            </Badge>
                            <span className="text-xs tabular-nums text-[var(--text-tertiary)]">
                              {destination.taskIds.length} task{destination.taskIds.length === 1 ? '' : 's'}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{destination.reasoning}</p>
                        </div>
                        {isChange ? (
                          <Button
                            variant={isSelected ? 'secondary' : 'outline'}
                            onClick={() => toggleDestination(index)}
                            disabled={saving}
                          >
                            {isSelected ? <Check /> : null}
                            {isSelected
                              ? 'Included'
                              : selectedCount > 0
                                ? `${selectedCount} included`
                                : 'Include'}
                          </Button>
                        ) : null}
                      </div>
                      {isExpanded ? (
                        <div className="space-y-2 border-t border-[var(--border)] px-4 py-3">
                          {destination.taskIds.map((taskId) => {
                            const taskSelected = selectedTaskIds.has(taskId);
                            return (
                              <div key={taskId} className="flex items-center gap-3 rounded-lg bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                                <span className="min-w-0 flex-1 truncate">
                                  {taskMap.get(taskId)?.title ?? taskId}
                                </span>
                                {isChange ? (
                                  <button
                                    type="button"
                                    role="checkbox"
                                    aria-checked={taskSelected}
                                    aria-label={`${taskSelected ? 'Exclude' : 'Include'} ${taskMap.get(taskId)?.title ?? taskId}`}
                                    onClick={() => toggleTask(taskId)}
                                    className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                                  >
                                    {taskSelected ? <Check size={14} /> : null}
                                  </button>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-[var(--border)] px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm tabular-nums text-[var(--text-tertiary)]">
              {selectedTaskCount} task move{selectedTaskCount === 1 ? '' : 's'} selected
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onReject} disabled={saving}>
                {changeIndexes.length === 0 ? 'Close' : 'Cancel'}
              </Button>
              {changeIndexes.length > 0 ? (
                <Button onClick={() => void applyChanges()} disabled={saving || selectedTaskIds.size === 0}>
                  {saving ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                  Apply selected changes
                </Button>
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
