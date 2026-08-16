"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  LoaderCircle,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fadeSlideUp, modalContent, modalOverlay, scaleIn, staggerContainer } from "@/lib/motion";
import type { TaskPriority } from "@/types";
import {
  executeProjectHierarchyCommand,
  loadProjectHierarchy,
} from "@/lib/projects/hierarchy-client";
import type { PhaseProposal } from "@/lib/projects/phase-planning";
import {
  getProjectTaskConnectorIcon as getConnectorIcon,
  getProjectTaskPriorityColor as getPriorityDotColor,
  PROJECT_TASK_PRIORITY_LABELS as PRIORITY_LABELS,
} from "@/lib/projects/task-visuals";
export type { PhaseProposal } from "@/lib/projects/phase-planning";

interface ProposalTask {
  id: string;
  title: string;
  priority: TaskPriority;
  status: string;
  connectorType: string;
}

interface PhaseProposalReviewProps {
  proposal: PhaseProposal;
  projectId: string;
  taskMap: Map<string, ProposalTask>;
  onAccept: () => void;
  onReject: () => void;
  isOpen: boolean;
}

type EditablePhase = PhaseProposal["phases"][number] & {
  originalName: string;
};

const STATUS_BADGE_VARIANTS: Record<string, "default" | "secondary" | "success" | "warning" | "danger" | "outline"> = {
  todo: "secondary",
  in_progress: "default",
  done: "success",
  cancelled: "warning",
};

function normalizePhaseKey(value: string) {
  return value.trim().toLowerCase();
}

function addIndex(current: Set<number>, index: number) {
  const next = new Set(current);
  next.add(index);
  return next;
}

function removeIndex(current: Set<number>, index: number) {
  const next = new Set(current);
  next.delete(index);
  return next;
}

export function PhaseProposalReview({
  proposal,
  projectId,
  taskMap,
  onAccept,
  onReject,
  isOpen,
}: PhaseProposalReviewProps) {
  const [editablePhases, setEditablePhases] = useState<EditablePhase[]>([]);
  const [acceptedPhaseIndexes, setAcceptedPhaseIndexes] = useState<Set<number>>(new Set());
  const [expandedPhaseIndexes, setExpandedPhaseIndexes] = useState<Set<number>>(new Set());
  const [includedNewTaskIndexes, setIncludedNewTaskIndexes] = useState<Set<number>>(new Set());
  const [includedClosureIndexes, setIncludedClosureIndexes] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    const nextPhases = proposal.phases.map((phase) => ({
      ...phase,
      originalName: phase.name,
    }));

    setEditablePhases(nextPhases);
    setAcceptedPhaseIndexes(new Set(nextPhases.map((_, index) => index)));
    setExpandedPhaseIndexes(new Set(nextPhases.map((_, index) => index)));
    setIncludedNewTaskIndexes(new Set());
    setIncludedClosureIndexes(new Set());
    setSaving(false);
  }, [isOpen, proposal]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        onReject();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onReject, saving]);

  const acceptedPhases = useMemo(
    () => editablePhases.filter((_, index) => acceptedPhaseIndexes.has(index)),
    [acceptedPhaseIndexes, editablePhases],
  );

  const selectableAcceptedCount = acceptedPhaseIndexes.size;

  function acceptPhase(index: number) {
    setAcceptedPhaseIndexes((current) => addIndex(current, index));
  }

  function rejectPhase(index: number) {
    setAcceptedPhaseIndexes((current) => removeIndex(current, index));
  }

  function togglePhaseExpanded(index: number) {
    setExpandedPhaseIndexes((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function updatePhaseName(index: number, name: string) {
    setEditablePhases((current) =>
      current.map((phase, phaseIndex) => (phaseIndex === index ? { ...phase, name } : phase)),
    );
  }

  function movePhase(index: number, direction: -1 | 1) {
    setEditablePhases((current) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }

      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];

      setAcceptedPhaseIndexes((acceptedCurrent) => {
        const remapped = new Set<number>();
        const orderedIndices = current.map((_, originalIndex) => originalIndex);
        [orderedIndices[index], orderedIndices[targetIndex]] = [orderedIndices[targetIndex], orderedIndices[index]];
        orderedIndices.forEach((originalIndex, nextIndex) => {
          if (acceptedCurrent.has(originalIndex)) {
            remapped.add(nextIndex);
          }
        });
        return remapped;
      });

      setExpandedPhaseIndexes((expandedCurrent) => {
        const remapped = new Set<number>();
        const orderedIndices = current.map((_, originalIndex) => originalIndex);
        [orderedIndices[index], orderedIndices[targetIndex]] = [orderedIndices[targetIndex], orderedIndices[index]];
        orderedIndices.forEach((originalIndex, nextIndex) => {
          if (expandedCurrent.has(originalIndex)) {
            remapped.add(nextIndex);
          }
        });
        return remapped;
      });

      return next;
    });
  }

  function includeSuggestedTask(index: number) {
    setIncludedNewTaskIndexes((current) => addIndex(current, index));
  }

  function skipSuggestedTask(index: number) {
    setIncludedNewTaskIndexes((current) => removeIndex(current, index));
  }

  function includeSuggestedClosure(index: number) {
    setIncludedClosureIndexes((current) => addIndex(current, index));
  }

  function keepSuggestedClosure(index: number) {
    setIncludedClosureIndexes((current) => removeIndex(current, index));
  }

  async function createPhase(
    phase: EditablePhase,
    sortOrder: number,
  ) {
    const response = await fetch("/api/project-phases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        name: phase.name.trim() || phase.originalName,
        description: phase.description,
        color: phase.color,
        estimatedDays: phase.estimatedDays,
        sortOrder,
      }),
    });

    const payload = (await response.json().catch(() => null)) as { phase?: { id: string }; error?: string } | null;
    if (!response.ok || !payload?.phase?.id) {
      throw new Error(payload?.error || `Failed to create ${phase.name}`);
    }

    return payload.phase.id;
  }

  async function addTaskToPhase(phaseId: string, taskId: string, sortOrder: number, isProposed = false, proposalType?: string) {
    const response = await fetch(`/api/project-phases/${phaseId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId,
        sortOrder,
        isProposed,
        proposalType,
      }),
    });

    const payload = (await response.json().catch(() => null)) as { item?: { id: string }; error?: string } | null;
    if (!response.ok || !payload?.item?.id) {
      throw new Error(payload?.error || "Failed to attach task to phase");
    }
  }

  async function moveTasksToPhase(phaseId: string, taskIds: string[]) {
    if (taskIds.length === 0) return;
    const hierarchy = await loadProjectHierarchy(projectId);
    await executeProjectHierarchyCommand({
      projectId,
      expectedRevision: hierarchy.revision,
      command: {
        type: "move_tasks",
        taskIds,
        toPhaseId: phaseId,
        toIndex: 0,
      },
    });
  }

  async function createSuggestedTask(title: string, description: string) {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: description || undefined,
        projectIds: [projectId],
        connectorType: "local",
      }),
    });

    const payload = (await response.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (!response.ok || !payload?.id) {
      throw new Error(payload?.error || `Failed to create ${title}`);
    }

    return payload.id;
  }

  async function closeSuggestedTask(taskId: string) {
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });

    const payload = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error || "Failed to close task");
    }
  }

  async function handleAccept(subset?: Set<number>) {
    const selectedIndexes = subset ?? acceptedPhaseIndexes;
    if (selectedIndexes.size === 0) {
      toast.error("Select at least one phase to accept.");
      return;
    }

    setSaving(true);
    const toastId = toast.loading("Creating phases from proposal…");

    try {
      const phaseIdByName = new Map<string, string>();
      const acceptedPhaseList = editablePhases
        .map((phase, index) => ({ phase, index }))
        .filter(({ index }) => selectedIndexes.has(index));
      let firstAcceptedPhaseId: string | null = null;

      for (const [sortOrder, { phase }] of acceptedPhaseList.entries()) {
        const phaseId = await createPhase(phase, sortOrder);
        if (!firstAcceptedPhaseId) {
          firstAcceptedPhaseId = phaseId;
        }
        phaseIdByName.set(normalizePhaseKey(phase.name), phaseId);
        phaseIdByName.set(normalizePhaseKey(phase.originalName), phaseId);

        await moveTasksToPhase(phaseId, phase.taskIds);
      }

      for (const index of includedNewTaskIndexes) {
        const suggestion = proposal.suggestedNewTasks[index];
        if (!suggestion) continue;

        const taskId = await createSuggestedTask(suggestion.title, suggestion.description);
        const phaseId =
          phaseIdByName.get(normalizePhaseKey(suggestion.phase)) ??
          firstAcceptedPhaseId;

        if (phaseId) {
          await addTaskToPhase(phaseId, taskId, 999, true, "ai-suggested");
        }
      }

      for (const index of includedClosureIndexes) {
        const suggestion = proposal.suggestedClosures[index];
        if (!suggestion) continue;
        await closeSuggestedTask(suggestion.taskId);
      }

      toast.success("Phase proposal accepted.", { id: toastId });
      onAccept();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply phase proposal";
      toast.error(message, { id: toastId });
    } finally {
      setSaving(false);
    }
  }

  return (
    <AnimatePresence initial={false}>
      {isOpen ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          variants={modalOverlay}
          initial="hidden"
          animate="show"
          exit="exit"
          onClick={() => {
            if (!saving) onReject();
          }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_24px_80px_rgba(0,0,0,0.5)]"
            variants={modalContent}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
              <div>
                <h2 className="text-[20px] font-semibold text-[var(--text-primary)] text-balance">
                  Phase Plan Proposal
                </h2>
                <p className="mt-1 text-sm text-[var(--text-tertiary)]">
                  Review, edit, and accept the AI phase plan before it is applied.
                </p>
              </div>
              <Button variant="ghost" onClick={onReject} disabled={saving} className="min-h-10 min-w-10">
                <X />
                Close
              </Button>
            </div>

            <div className="max-h-[calc(90vh-81px)] overflow-y-auto px-6 py-6">
              <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
                <motion.div variants={scaleIn}>
                  <Card className="border-[var(--border-subtle)] bg-[var(--surface-0)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Brain size={16} />
                        AI reasoning
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-[var(--text-secondary)] text-pretty">
                        {proposal.overallReasoning || "No overall reasoning was provided."}
                      </p>
                    </CardContent>
                  </Card>
                </motion.div>

                <motion.div variants={staggerContainer} className="space-y-4">
                  {editablePhases.map((phase, index) => {
                    const isAccepted = acceptedPhaseIndexes.has(index);
                    const isExpanded = expandedPhaseIndexes.has(index);

                    return (
                      <motion.div key={`${phase.originalName}-${index}`} variants={fadeSlideUp}>
                        <Card className="overflow-hidden border-[var(--border-subtle)] bg-[var(--surface-0)]">
                          <div className="flex flex-col gap-4 border-l-2 p-5" style={{ borderLeftColor: phase.color }}>
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => togglePhaseExpanded(index)}
                                    className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-[8px] text-[var(--text-secondary)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] active:scale-[0.96]"
                                    aria-label={isExpanded ? "Collapse phase" : "Expand phase"}
                                  >
                                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                  </button>
                                  <span className="inline-flex h-3 w-3 rounded-full" style={{ backgroundColor: phase.color }} aria-hidden="true" />
                                  <input
                                    value={phase.name}
                                    onChange={(event) => updatePhaseName(index, event.target.value)}
                                    className="min-h-10 min-w-0 flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm font-semibold text-[var(--text-primary)] outline-none transition-[border-color,box-shadow] duration-150"
                                  />
                                  <Badge variant={isAccepted ? "success" : "outline"}>
                                    {isAccepted ? "Accepted" : "Skipped"}
                                  </Badge>
                                </div>
                                <p className="mt-3 text-sm text-[var(--text-secondary)] text-pretty">
                                  {phase.description || "No description provided."}
                                </p>
                                <p className="mt-3 text-xs text-[var(--text-tertiary)] text-pretty">
                                  {phase.reasoning || "No per-phase reasoning provided."}
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]">
                                  <span className="rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1">
                                    {phase.taskIds.length} {phase.taskIds.length === 1 ? "task" : "tasks"}
                                  </span>
                                  <span className="rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1">
                                    {phase.estimatedDays} {phase.estimatedDays === 1 ? "day" : "days"}
                                  </span>
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  variant={isAccepted ? "secondary" : "default"}
                                  onClick={() => acceptPhase(index)}
                                  disabled={saving}
                                >
                                  <Check />
                                  {isAccepted ? "Accepted" : "Accept"}
                                </Button>
                                <Button
                                  variant={isAccepted ? "ghost" : "secondary"}
                                  onClick={() => rejectPhase(index)}
                                  disabled={saving}
                                  className="min-h-10 min-w-10 px-3"
                                  aria-label={isAccepted ? "Skip phase" : "Keep phase skipped"}
                                >
                                  <X />
                                </Button>
                                <Button
                                  variant="ghost"
                                  onClick={() => movePhase(index, -1)}
                                  disabled={saving || index === 0}
                                >
                                  Up
                                </Button>
                                <Button
                                  variant="ghost"
                                  onClick={() => movePhase(index, 1)}
                                  disabled={saving || index === editablePhases.length - 1}
                                >
                                  Down
                                </Button>
                              </div>
                            </div>

                            <AnimatePresence initial={false}>
                              {isExpanded ? (
                                <motion.div
                                  variants={fadeSlideUp}
                                  initial="hidden"
                                  animate="show"
                                  exit="exit"
                                  className="space-y-2 border-t border-[var(--border)] pt-4"
                                >
                                  {phase.taskIds.map((taskId: string) => {
                                    const task = taskMap.get(taskId);
                                    if (!task) {
                                      return (
                                        <div
                                          key={taskId}
                                          className="rounded-[12px] border border-dashed border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 text-sm text-[var(--text-tertiary)]"
                                        >
                                          Missing task reference: {taskId}
                                        </div>
                                      );
                                    }

                                    const ConnectorIcon = getConnectorIcon(task.connectorType);
                                    return (
                                      <div
                                        key={taskId}
                                        className="flex flex-col gap-3 rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                                      >
                                        <div className="min-w-0">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <span
                                              className="inline-flex h-2.5 w-2.5 rounded-full"
                                              style={{ backgroundColor: getPriorityDotColor(task.priority) }}
                                              aria-hidden="true"
                                            />
                                            <ConnectorIcon size={14} className="text-[var(--text-tertiary)]" />
                                            <p className="truncate text-sm font-medium text-[var(--text-primary)]">{task.title}</p>
                                          </div>
                                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
                                            <span>{PRIORITY_LABELS[task.priority] || task.priority}</span>
                                            <span>•</span>
                                            <span>{task.connectorType}</span>
                                          </div>
                                        </div>
                                        <Badge variant={STATUS_BADGE_VARIANTS[task.status] || "secondary"}>
                                          {task.status.replaceAll("_", " ")}
                                        </Badge>
                                      </div>
                                    );
                                  })}
                                </motion.div>
                              ) : null}
                            </AnimatePresence>
                          </div>
                        </Card>
                      </motion.div>
                    );
                  })}
                </motion.div>

                <motion.div variants={scaleIn} className="grid gap-4 lg:grid-cols-2">
                  <Card className="border-[var(--border-subtle)] bg-[var(--surface-0)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Lightbulb size={16} />
                        Suggested new tasks
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {proposal.suggestedNewTasks.length === 0 ? (
                        <p className="text-sm text-[var(--text-tertiary)]">No additional tasks suggested.</p>
                      ) : (
                        proposal.suggestedNewTasks.map((task, index) => {
                          const isIncluded = includedNewTaskIndexes.has(index);
                          return (
                            <div key={`${task.title}-${index}`} className="rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] p-4">
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Plus size={14} className="text-[var(--accent-400)]" />
                                    <p className="text-sm font-medium text-[var(--text-primary)]">{task.title}</p>
                                    <Badge variant="outline">{task.phase || "Unassigned"}</Badge>
                                  </div>
                                  {task.description ? (
                                    <p className="mt-2 text-sm text-[var(--text-secondary)] text-pretty">
                                      {task.description}
                                    </p>
                                  ) : null}
                                  <p className="mt-2 text-xs text-[var(--text-tertiary)] text-pretty">
                                    {task.reasoning || "No reasoning provided."}
                                  </p>
                                </div>
                                <div className="flex gap-2">
                                  <Button variant={isIncluded ? "secondary" : "default"} onClick={() => includeSuggestedTask(index)} disabled={saving}>
                                    {isIncluded ? <Check /> : <Plus />}
                                    {isIncluded ? "Added" : "Add"}
                                  </Button>
                                  <Button variant="ghost" onClick={() => skipSuggestedTask(index)} disabled={saving}>
                                    Skip
                                  </Button>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </CardContent>
                  </Card>

                  <Card className="border-[var(--border-subtle)] bg-[var(--surface-0)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Trash2 size={16} />
                        Suggested closures
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {proposal.suggestedClosures.length === 0 ? (
                        <p className="text-sm text-[var(--text-tertiary)]">No closures suggested.</p>
                      ) : (
                        proposal.suggestedClosures.map((task, index) => {
                          const isIncluded = includedClosureIndexes.has(index);
                          return (
                            <div key={`${task.taskId}-${index}`} className="rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] p-4">
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Trash2 size={14} className="text-[var(--danger)]" />
                                    <p className="text-sm font-medium text-[var(--text-primary)]">{task.title}</p>
                                  </div>
                                  <p className="mt-2 text-xs text-[var(--text-tertiary)] text-pretty">
                                    {task.reasoning || "No reasoning provided."}
                                  </p>
                                </div>
                                <div className="flex gap-2">
                                  <Button variant={isIncluded ? "secondary" : "default"} onClick={() => includeSuggestedClosure(index)} disabled={saving}>
                                    {isIncluded ? <Check /> : <Trash2 />}
                                    {isIncluded ? "Will close" : "Close"}
                                  </Button>
                                  <Button variant="ghost" onClick={() => keepSuggestedClosure(index)} disabled={saving}>
                                    Keep
                                  </Button>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </CardContent>
                  </Card>
                </motion.div>

                <motion.div variants={fadeSlideUp} className="flex flex-col gap-3 border-t border-[var(--border)] pt-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]">
                    {selectableAcceptedCount} of {editablePhases.length} phases selected • {includedNewTaskIndexes.size} new tasks •{" "}
                    {includedClosureIndexes.size} closures
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="default"
                      onClick={() => void handleAccept(new Set(editablePhases.map((_, index) => index)))}
                      disabled={saving || editablePhases.length === 0}
                    >
                      {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
                      Accept all
                    </Button>
                    <Button variant="secondary" onClick={() => void handleAccept()} disabled={saving || acceptedPhases.length === 0}>
                      {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
                      Accept selected
                    </Button>
                    <Button variant="ghost" onClick={onReject} disabled={saving}>
                      <X />
                      Reject
                    </Button>
                  </div>
                </motion.div>
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default PhaseProposalReview;
