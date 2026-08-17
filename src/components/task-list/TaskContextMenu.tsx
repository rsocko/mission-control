'use client';

import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dialog from '@radix-ui/react-dialog';
import { DayPicker } from 'react-day-picker';
import {
  Archive, CheckCircle2, Sun, Calendar, ArrowRight, Trash2, FolderMinus,
  Clock, CalendarClock, CalendarPlus, ChevronRight, Flag, Search, FastForward, FileText, XCircle, CircleDot, Layers3,
  MoreHorizontal, FolderPlus, Check, ArrowLeftRight,
} from 'lucide-react';
import Image from 'next/image';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { getLocalToday } from '@/lib/utils/client-date';
import { getNextRecurringDate } from '@/lib/utils/recurrence';
import { getDeepLinkInfo } from '@/lib/utils/deep-links';
import { calendarClassNames } from '@/components/ui/calendar-classes';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useLongPress } from '@/lib/hooks/useLongPress';
import type { ListGroup } from '@/types/dashboard';
import type { LocalDisposition, TaskEditPolicy, TaskField, TaskSourceModel } from '@/types';
import { TASK_PRIORITY_VISUALS, TASK_STATUS_VISUALS } from '@/lib/constants/task-formatting';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  TASK_DISPOSITION_OPTIONS,
  taskFieldBlockedReason,
  taskRemovalLabel,
} from '@/lib/tasks/client-edit-policy';
import { MobileTaskActions } from './MobileTaskActions';

// Shared context-menu panel styles
const MENU_CONTENT_CLASS =
  'min-w-[200px] bg-[var(--surface-1)]/95 backdrop-blur-md border border-[var(--border)] rounded-[var(--radius-lg)] shadow-xl py-1.5 z-50 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95';

const SUB_CONTENT_CLASS =
  'bg-[var(--surface-1)]/95 backdrop-blur-lg border border-[var(--border)] rounded-[var(--radius-lg)] shadow-2xl py-1.5 z-50 animate-in fade-in-0 zoom-in-95';

interface SourceList {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  name: string;
  taskCount: number;
  groupId: string | null;
  sortOrder?: number;
}

export interface TaskContextMenuActions {
  onComplete: () => void;
  onSetPriority: (priority: string) => void;
  onSetStatus?: (status: string) => void;
  onAddToMyDay?: () => void;
  onRemoveFromMyDay?: () => void;
  onDueToday: () => void;
  onDueTomorrow: () => void;
  onPickDate: (date: string) => void;
  onClearDueDate?: () => void;
  onSkipToCurrent?: () => void;
  onMoveToList?: (targetListId: string) => void;
  onMoveToSource?: () => void;
  onMoveToPhase?: (phaseId: string | null) => void;
  onAddToProject?: (projectId: string, phaseId?: string | null) => void;
  onRemoveFromProject?: () => void;
  onSetLocalDisposition?: (disposition: LocalDisposition) => void;
  onDelete: () => void;
  onSaveAsTemplate?: () => void;
}

export interface HubProject {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
  category?: string | null;
  phases?: { id: string; name: string }[];
}

export interface TaskProjectPhaseMembership {
  projectId: string;
  phaseId: string | null;
  phaseName: string | null;
}

interface TaskContextMenuProps {
  children: React.ReactNode;
  task: {
    id: string;
    title: string;
    status?: string;
    priority: string;
    connectorType: string;
    connectorInstanceId?: string;
    sourceId?: string | null;
    dueDate: string | null;
    recurrence?: string | null;
    localDisposition: LocalDisposition;
    taskSourceModel: TaskSourceModel;
    editPolicy: TaskEditPolicy;
  };
  actions: TaskContextMenuActions;
  sourceLists?: SourceList[];
  listGroups?: ListGroup[];
  projectPhases?: { id: string; name: string }[];
  projects?: HubProject[];
  taskProjectIds?: string[];
  taskProjectPhaseMemberships?: TaskProjectPhaseMembership[];
  isInMyDay?: boolean;
}

export function TaskContextMenu({
  children,
  task,
  actions,
  sourceLists = [],
  listGroups = [],
  projectPhases = [],
  projects = [],
  taskProjectIds = [],
  taskProjectPhaseMemberships = [],
  isInMyDay = false,
}: TaskContextMenuProps) {
  const [dateInputOpen, setDateInputOpen] = useState(false);
  const isMobile = useIsMobile();
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const canEdit = (field: TaskField) => canEditTaskField(task.editPolicy, field);
  const blockedReason = (field: TaskField) => taskFieldBlockedReason(task.editPolicy, field);
  const canDelete = canRemoveTask(task.editPolicy);
  const canMoveWithinSource = task.editPolicy.sourceMoveSupported;
  const dispositionOptions = TASK_DISPOSITION_OPTIONS.filter((option) => (
    option.value !== task.localDisposition
    && canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, option.value)
  ));

  const openDatePicker = useCallback(() => {
    // Let Radix finish dismissing the context menu before mounting another modal layer.
    setTimeout(() => setDateInputOpen(true), 0);
  }, []);

  const openMobileSheet = useCallback(() => {
    setMobileSheetOpen(true);
  }, []);

  const longPressHandlers = useLongPress({ onLongPress: openMobileSheet });

  // On mobile, render long-press trigger + overflow button + MobileSheet
  if (isMobile) {
    return (
      <>
        <div
          {...longPressHandlers}
          className="relative"
        >
          {children}
          {/* Visible overflow button for users who don't discover long-press */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMobileSheetOpen(true); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-[var(--text-muted)] active:text-[var(--text-primary)] active:bg-[var(--surface-2)] rounded-md"
            aria-label="Task actions"
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
        <MobileTaskActions
          isOpen={mobileSheetOpen}
          onClose={() => setMobileSheetOpen(false)}
          task={task}
          actions={actions}
          sourceLists={sourceLists}
          listGroups={listGroups}
          projectPhases={projectPhases}
          projects={projects}
          taskProjectIds={taskProjectIds}
          taskProjectPhaseMemberships={taskProjectPhaseMemberships}
          isInMyDay={isInMyDay}
        />
      </>
    );
  }

  // Source-aware: determine which actions are available – filter to same connector instance
  const sameSourceLists = task.connectorInstanceId
    ? sourceLists.filter((l) => l.connectorInstanceId === task.connectorInstanceId)
    : sourceLists;
  // Show "Move task to…" if there are same-source lists to pick from OR a cross-source move option
  const hasSameSourceLists = sameSourceLists.length > 0 && !!actions.onMoveToList;

  // Deep link info for "Open in <Source>"
  const deepLink = task.sourceId ? getDeepLinkInfo(task.connectorType, task.sourceId) : null;

  // Skip-to-current: only show when the task is overdue and has a recurrence pattern
  const today = getLocalToday();
  const dueDateStr = task.dueDate?.split('T')[0] ?? null;
  const isOverdue = !!dueDateStr && dueDateStr < today;
  const showSkipToCurrent = isOverdue && !!task.recurrence && !!actions.onSkipToCurrent;
  const nextRecurringDate = showSkipToCurrent
    ? getNextRecurringDate(dueDateStr!, task.recurrence!, today)
    : null;

  const PRIORITY_OPTIONS = [
    ...Object.entries(TASK_PRIORITY_VISUALS).map(([value, visual]) => ({ value, label: visual.label, color: visual.textClass })),
  ];

  const STATUS_OPTIONS = [
    ...(['todo', 'in_progress', 'done', 'cancelled'] as const).map((value) => ({
      value,
      label: TASK_STATUS_VISUALS[value].label,
      color: TASK_STATUS_VISUALS[value].textClass,
    })),
  ];

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="data-[state=open]:bg-[var(--accent-500)]/8 data-[state=open]:ring-1 data-[state=open]:ring-inset data-[state=open]:ring-[var(--accent-400)] data-[state=open]:rounded-sm transition-[background-color,box-shadow] duration-100">
            {children}
          </div>
        </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content
          className={MENU_CONTENT_CLASS}
        >
          {/* Task title header — shows which task this menu acts on */}
          <ContextMenu.Label className="px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] truncate max-w-[260px]">
            {task.title}
          </ContextMenu.Label>
          <ContextMenu.Separator className="h-px bg-[var(--border-subtle)] my-1 mx-2" />

          {/* My Day — universal since MC manages My Day locally */}
          <ContextMenu.Item
            className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
            onSelect={isInMyDay ? actions.onRemoveFromMyDay : actions.onAddToMyDay}
          >
            <Sun size={15} className="text-amber-400" />
            {isInMyDay ? 'Remove from My Day' : 'Add to My Day'}
          </ContextMenu.Item>

          {/* Priority sub-menu */}
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger
              className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('priority') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
              disabled={!canEdit('priority')}
              title={!canEdit('priority') ? blockedReason('priority') : undefined}
            >
              <Flag size={15} className="text-orange-400" />
              Set priority
              <span className="ml-auto flex items-center gap-1">
                <span className={`text-xs ${PRIORITY_OPTIONS.find(p => p.value === task.priority)?.color || 'text-[var(--text-muted)]'}`}>
                  {task.priority !== 'none' ? task.priority : ''}
                </span>
                <ChevronRight size={13} className="text-[var(--text-muted)]" />
              </span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                className={`min-w-[140px] ${SUB_CONTENT_CLASS}`}
              >
                {PRIORITY_OPTIONS.map((opt) => (
                  <ContextMenu.Item
                    key={opt.value}
                    className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${opt.color} ${task.priority === opt.value ? 'font-semibold' : ''}`}
                    onSelect={() => actions.onSetPriority(opt.value)}
                  >
                    {task.priority === opt.value && <Check size={12} />}
                    {opt.label}
                  </ContextMenu.Item>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>

          {/* Status sub-menu */}
          {actions.onSetStatus && (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger
                className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('status') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
                disabled={!canEdit('status')}
                title={!canEdit('status') ? blockedReason('status') : undefined}
              >
                <CircleDot size={15} className={TASK_STATUS_VISUALS.in_progress.textClass} />
                Status
                <span className="ml-auto flex items-center gap-1">
                  <span className={`text-xs ${STATUS_OPTIONS.find(s => s.value === task.status)?.color || 'text-[var(--text-muted)]'}`}>
                    {STATUS_OPTIONS.find(s => s.value === task.status)?.label || ''}
                  </span>
                  <ChevronRight size={13} className="text-[var(--text-muted)]" />
                </span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  className={`min-w-[140px] ${SUB_CONTENT_CLASS}`}
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <ContextMenu.Item
                      key={opt.value}
                      className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${opt.color} ${task.status === opt.value ? 'font-semibold' : ''}`}
                      onSelect={() => actions.onSetStatus?.(opt.value)}
                    >
                      {task.status === opt.value && <Check size={12} />}
                      {opt.label}
                    </ContextMenu.Item>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          )}

          <ContextMenu.Separator className="h-px bg-[var(--border-subtle)] my-1 mx-2" />

          {/* Mark as completed */}
          <ContextMenu.Item
            className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('status') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
            onSelect={canEdit('status') ? actions.onComplete : undefined}
            disabled={!canEdit('status')}
            title={!canEdit('status') ? blockedReason('status') : undefined}
          >
            <CheckCircle2 size={15} className="text-green-400" />
            Mark as completed
            <span className="ml-auto text-xs text-[var(--text-muted)]">Ctrl+D</span>
          </ContextMenu.Item>

          {actions.onSetLocalDisposition && dispositionOptions.length > 0 && (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="mx-1 flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-sm text-emerald-300 outline-none transition-colors duration-75 data-[highlighted]:bg-[var(--surface-2)]">
                <Archive size={15} />
                Mission Control state
                <ChevronRight size={13} className="ml-auto text-[var(--text-muted)]" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={`min-w-[240px] ${SUB_CONTENT_CLASS}`}>
                  <ContextMenu.Label className="block max-w-60 px-3 py-2 text-xs text-[var(--text-muted)]">
                    These actions do not change the upstream task.
                  </ContextMenu.Label>
                  {dispositionOptions.map((option) => (
                    <ContextMenu.Item
                      key={option.value}
                      className="mx-1 flex cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--surface-2)]"
                      onSelect={() => actions.onSetLocalDisposition?.(option.value)}
                      aria-label={`${option.label}. ${option.detail}`}
                    >
                      <span>
                        <span className="block">{option.label}</span>
                        <span className="block text-xs text-[var(--text-muted)]">{option.detail}</span>
                      </span>
                    </ContextMenu.Item>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          )}

          <ContextMenu.Separator className="h-px bg-[var(--border-subtle)] my-1 mx-2" />

          {/* Due date actions */}
          <ContextMenu.Item
            className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('dueDate') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
            onSelect={canEdit('dueDate') ? actions.onDueToday : undefined}
            disabled={!canEdit('dueDate')}
            title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined}
          >
            <Calendar size={15} className="text-blue-400" />
            Due today
          </ContextMenu.Item>

          <ContextMenu.Item
            className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('dueDate') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
            onSelect={canEdit('dueDate') ? actions.onDueTomorrow : undefined}
            disabled={!canEdit('dueDate')}
            title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined}
          >
            <CalendarClock size={15} className="text-orange-400" />
            Due tomorrow
          </ContextMenu.Item>

          <ContextMenu.Item
            className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('dueDate') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
            onSelect={canEdit('dueDate') ? openDatePicker : undefined}
            disabled={!canEdit('dueDate')}
            title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined}
          >
            <CalendarPlus size={15} className="text-purple-400" />
            Pick a date…
          </ContextMenu.Item>

          {/* Clear due date — only shown when a due date is set */}
          {task.dueDate && actions.onClearDueDate && (
            <ContextMenu.Item
              className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('dueDate') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
              onSelect={canEdit('dueDate') ? actions.onClearDueDate : undefined}
              disabled={!canEdit('dueDate')}
              title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined}
            >
              <XCircle size={15} className="text-[var(--text-muted)]" />
              Clear due date
            </ContextMenu.Item>
          )}

          {/* Skip to current — only for overdue recurring tasks */}
          {showSkipToCurrent && (
            <ContextMenu.Item
              className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('dueDate') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
              onSelect={canEdit('dueDate') ? actions.onSkipToCurrent : undefined}
              disabled={!canEdit('dueDate')}
              title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined}
            >
              <FastForward size={15} className="text-blue-400" />
              Skip to current
              {nextRecurringDate && (
                <span className="ml-auto text-xs text-[var(--text-muted)]">{nextRecurringDate}</span>
              )}
            </ContextMenu.Item>
          )}

          {/* ── More… submenu ─────────────────────────────────────────── */}
          <ContextMenu.Separator className="h-px bg-[var(--border-subtle)] my-1 mx-2" />
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]">
              <MoreHorizontal size={15} className="text-[var(--text-muted)]" />
              More…
              <ChevronRight size={13} className="ml-auto text-[var(--text-muted)]" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                className={`min-w-[200px] ${SUB_CONTENT_CLASS}`}
              >
                {/* Add to project */}
                {actions.onAddToProject && projects.length > 0 && (
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger
                      className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)] ${!canEdit('projects') ? 'opacity-50 cursor-not-allowed' : 'text-[var(--text-primary)]'}`}
                      disabled={!canEdit('projects')}
                      title={!canEdit('projects') ? blockedReason('projects') : undefined}
                    >
                      <FolderPlus size={15} className="text-blue-400" />
                      Add to project…
                      <ChevronRight size={13} className="ml-auto text-[var(--text-muted)]" />
                    </ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent
                        className={`min-w-[200px] max-h-80 overflow-y-auto ${SUB_CONTENT_CLASS}`}
                      >
                        <AddToProjectMenu
                          projects={projects}
                          taskProjectIds={taskProjectIds}
                          taskProjectPhaseMemberships={taskProjectPhaseMemberships}
                          onSelect={(projectId, phaseId) => actions.onAddToProject?.(projectId, phaseId)}
                        />
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                )}

                {/* Move to phase (project-aware) */}
                {actions.onMoveToPhase && projectPhases.length > 0 && canEdit('phases') && (
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]">
                      <Layers3 size={15} className="text-[var(--text-muted)]" />
                      Move to phase…
                      <ChevronRight size={13} className="ml-auto text-[var(--text-muted)]" />
                    </ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent
                        className={`min-w-[180px] max-h-72 overflow-y-auto ${SUB_CONTENT_CLASS}`}
                      >
                        <ContextMenu.Item
                          className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-secondary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
                          onSelect={() => actions.onMoveToPhase?.(null)}
                        >
                          <XCircle size={14} className="text-[var(--text-muted)]" />
                          No phase
                        </ContextMenu.Item>
                        {projectPhases.map((phase) => (
                          <ContextMenu.Item
                            key={phase.id}
                            className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
                            onSelect={() => actions.onMoveToPhase?.(phase.id)}
                          >
                            <Layers3 size={14} className="text-[var(--text-muted)]" />
                            {phase.name}
                          </ContextMenu.Item>
                        ))}
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                )}

                {/* Same-source moves follow server policy; cross-source moves remain independent. */}
                {(hasSameSourceLists && canMoveWithinSource || !!actions.onMoveToSource) && (
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]">
                      <ArrowRight size={15} className="text-[var(--text-muted)]" />
                      Move task to…
                      <ChevronRight size={13} className="ml-auto text-[var(--text-muted)]" />
                    </ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent
                        className={`min-w-[220px] max-h-72 overflow-y-auto ${SUB_CONTENT_CLASS}`}
                      >
                        <MoveToListSearch sourceLists={canMoveWithinSource ? sameSourceLists : []} listGroups={listGroups} onSelect={(listId) => actions.onMoveToList?.(listId)} onMoveToSource={actions.onMoveToSource} />
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                )}

                {/* Save as template */}
                {actions.onSaveAsTemplate && (
                  <ContextMenu.Item
                    className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
                    onSelect={actions.onSaveAsTemplate}
                  >
                    <FileText size={15} className="text-teal-400" />
                    Save as template…
                  </ContextMenu.Item>
                )}

                {/* Open in <Source> (deep link) */}
                {deepLink && (
                  <ContextMenu.Item
                    className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
                    onSelect={() => {
                      const url = deepLink.url;
                      if (url.startsWith('https://') || url.startsWith('http://')) {
                        window.open(url, '_blank', 'noopener,noreferrer');
                      }
                    }}
                  >
                    <Image src={deepLink.icon} alt={deepLink.label} width={15} height={15} className="flex-shrink-0" />
                    Open in {deepLink.label}
                  </ContextMenu.Item>
                )}

                {/* Remove from project */}
                {actions.onRemoveFromProject && (
                  <>
                    <ContextMenu.Separator className="h-px bg-[var(--border-subtle)] my-1 mx-2" />
                    <ContextMenu.Item
                      className="flex items-center gap-3 px-3 py-2 text-sm text-orange-400 cursor-pointer outline-none data-[highlighted]:bg-orange-900/20 transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
                      onSelect={actions.onRemoveFromProject}
                    >
                      <FolderMinus size={15} />
                      Remove from this project
                    </ContextMenu.Item>
                  </>
                )}

                {/* Delete */}
                <ContextMenu.Separator className="h-px bg-[var(--border-subtle)] my-1 mx-2" />
                <ContextMenu.Item
                  className={`flex items-center gap-3 px-3 py-2 text-sm mx-1 rounded-[var(--radius-sm)] transition-colors duration-75 ${
                    canDelete
                      ? 'text-red-400 cursor-pointer data-[highlighted]:bg-red-900/20'
                      : 'text-[var(--text-muted)] cursor-not-allowed opacity-50'
                  }`}
                  onSelect={canDelete ? actions.onDelete : undefined}
                  disabled={!canDelete}
                  title={!canDelete ? task.editPolicy.removalReason : undefined}
                >
                  <Trash2 size={15} />
                  {taskRemovalLabel(task.editPolicy)}
                  {canDelete ? (
                    <span className="ml-auto text-xs text-[var(--text-muted)]">Del</span>
                  ) : (
                    <span className="ml-auto text-xs text-[var(--text-muted)]">Disabled</span>
                  )}
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
        </ContextMenu.Content>
      </ContextMenu.Portal>
      </ContextMenu.Root>

      {/* Date picker dialog — outside ContextMenu.Root so DismissableLayer lifecycles don't overlap */}
      <Dialog.Root open={dateInputOpen} onOpenChange={setDateInputOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/40 animate-in fade-in-0" />
          <Dialog.Content
            aria-label="Pick a due date"
            className="fixed left-1/2 top-1/2 z-[101] -translate-x-1/2 -translate-y-1/2 bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] shadow-2xl p-4 animate-in fade-in-0 zoom-in-95 focus:outline-none"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
          <Dialog.Title className="text-sm font-medium text-[var(--text-primary)] mb-3">
            Pick a due date
          </Dialog.Title>
          <DayPicker
            mode="single"
            selected={(() => {
              const dateOnly = task.dueDate ? task.dueDate.slice(0, 10) : null;
              const parsed = dateOnly ? new Date(dateOnly + 'T00:00:00') : undefined;
              return parsed && !isNaN(parsed.getTime()) ? parsed : undefined;
            })()}
            onSelect={(day) => {
              if (day) {
                const yyyy = day.getFullYear();
                const mm = String(day.getMonth() + 1).padStart(2, '0');
                const dd = String(day.getDate()).padStart(2, '0');
                actions.onPickDate(`${yyyy}-${mm}-${dd}`);
              }
              setDateInputOpen(false);
            }}
            defaultMonth={(() => {
              const dateOnly = task.dueDate ? task.dueDate.slice(0, 10) : null;
              const parsed = dateOnly ? new Date(dateOnly + 'T00:00:00') : undefined;
              return parsed && !isNaN(parsed.getTime()) ? parsed : new Date();
            })()}
            showOutsideDays
            classNames={calendarClassNames}
          />
          {/* Footer: clear + today */}
          <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-1 py-2 mt-1">
            <button
              type="button"
              onClick={() => {
                actions.onClearDueDate?.();
                setDateInputOpen(false);
              }}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                const yyyy = now.getFullYear();
                const mm = String(now.getMonth() + 1).padStart(2, '0');
                const dd = String(now.getDate()).padStart(2, '0');
                actions.onPickDate(`${yyyy}-${mm}-${dd}`);
                setDateInputOpen(false);
              }}
              className="text-xs text-[var(--accent-400)] hover:text-[var(--accent-300)] transition-colors font-medium"
            >
              Today
            </button>
          </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

const RECENT_MOVE_TARGETS_KEY = 'mission-control:recent-move-targets';
const MAX_RECENT = 5;

function getRecentTargets(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_MOVE_TARGETS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

function saveRecentTarget(sourceId: string) {
  const recent = getRecentTargets().filter((id) => id !== sourceId);
  recent.unshift(sourceId);
  localStorage.setItem(RECENT_MOVE_TARGETS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

function MoveToListSearch({ sourceLists, listGroups = [], onSelect, onMoveToSource }: { sourceLists: SourceList[]; listGroups?: ListGroup[]; onSelect: (id: string) => void; onMoveToSource?: () => void }) {
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus the search input when submenu opens
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const recentIds = getRecentTargets();
  const isSearching = search.length > 0;
  const searchResults = isSearching
    ? sourceLists.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
    : [];

  // Default view: recent first, then rest grouped by list group
  const recentLists = !isSearching
    ? recentIds.map((id) => sourceLists.find((l) => l.sourceId === id)).filter(Boolean) as SourceList[]
    : [];
  const restLists = !isSearching
    ? sourceLists.filter((l) => !recentIds.includes(l.sourceId))
    : [];

  // Build grouped structure: groups sorted by sortOrder/name, lists within groups sorted by sortOrder/name
  const grouped = useMemo(() => {
    if (listGroups.length === 0) {
      // No groups defined — return flat sorted list
      return [{ group: null, lists: [...restLists].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name)) }];
    }
    const buckets = new Map<string | null, SourceList[]>();
    for (const list of restLists) {
      const key = list.groupId;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(list);
    }
    // Sort lists within each bucket
    for (const arr of buckets.values()) {
      arr.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name));
    }
    // Build ordered group entries: sorted groups first, ungrouped last
    const result: { group: ListGroup | null; lists: SourceList[] }[] = [];
    const sortedGroups = [...listGroups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const g of sortedGroups) {
      const lists = buckets.get(g.id);
      if (lists && lists.length > 0) {
        result.push({ group: g, lists });
      }
    }
    // Ungrouped lists
    const ungrouped = buckets.get(null);
    if (ungrouped && ungrouped.length > 0) {
      result.push({ group: null, lists: ungrouped });
    }
    return result;
  }, [restLists, listGroups]);

  function handleSelect(list: SourceList) {
    saveRecentTarget(list.sourceId);
    onSelect(list.id);
  }

  const ITEM_CLASS = "flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]";

  return (
    <>
      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
          <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search lists…"
            className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
      </div>
      {isSearching ? (
        <>
          {searchResults.map((list) => (
            <ContextMenu.Item
              key={list.id}
              className={ITEM_CLASS}
              onSelect={() => handleSelect(list)}
            >
              {list.name}
            </ContextMenu.Item>
          ))}
          {searchResults.length === 0 && (
            <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No lists found</div>
          )}
        </>
      ) : (
        <>
          {recentLists.length > 0 && (
            <>
              {recentLists.map((list) => (
                <ContextMenu.Item
                  key={list.id}
                  className={ITEM_CLASS}
                  onSelect={() => handleSelect(list)}
                >
                  <Clock size={11} className="shrink-0 text-[var(--text-muted)]" />
                  {list.name}
                </ContextMenu.Item>
              ))}
              <ContextMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
            </>
          )}
          {grouped.map(({ group, lists }) => (
            <React.Fragment key={group?.id ?? '__ungrouped'}>
              {group && (
                <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
                  {group.name}
                </div>
              )}
              {lists.map((list) => (
                <ContextMenu.Item
                  key={list.id}
                  className={group ? ITEM_CLASS.replace('px-3', 'pl-5 pr-3') : ITEM_CLASS}
                  onSelect={() => handleSelect(list)}
                >
                  {list.name}
                </ContextMenu.Item>
              ))}
            </React.Fragment>
          ))}
        </>
      )}
      {onMoveToSource && (
        <>
          <ContextMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
          <ContextMenu.Item
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-muted)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
            onSelect={() => onMoveToSource()}
          >
            <ArrowLeftRight size={12} className="shrink-0" />
            Move to another source…
          </ContextMenu.Item>
        </>
      )}
    </>
  );
}

// ─── Add to project MRU helpers ──────────────────────────────────────────────

const RECENT_PROJECT_TARGETS_KEY = 'mission-control:recent-project-targets';
const MAX_RECENT_PROJECTS = 5;

function getRecentProjectTargets(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_PROJECT_TARGETS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

function saveRecentProjectTarget(projectId: string) {
  const recent = getRecentProjectTargets().filter((id) => id !== projectId);
  recent.unshift(projectId);
  localStorage.setItem(RECENT_PROJECT_TARGETS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_PROJECTS)));
}

function AddToProjectMenu({
  projects,
  taskProjectIds = [],
  taskProjectPhaseMemberships = [],
  onSelect,
}: {
  projects: HubProject[];
  taskProjectIds?: string[];
  taskProjectPhaseMemberships?: TaskProjectPhaseMembership[];
  onSelect: (projectId: string, phaseId?: string | null) => void;
}) {
  const recentIds = getRecentProjectTargets();

  // Recent projects first, then the rest grouped by category
  const recentProjects = recentIds
    .map((id) => projects.find((p) => p.id === id))
    .filter(Boolean) as HubProject[];
  const restProjects = projects.filter((p) => !recentIds.includes(p.id));

  // Group remaining projects by category
  const grouped = new Map<string, HubProject[]>();
  for (const p of restProjects) {
    const cat = p.category || '';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(p);
  }
  // Sort categories alphabetically, uncategorized last
  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  function handleSelect(project: HubProject, phaseId?: string | null) {
    saveRecentProjectTarget(project.id);
    onSelect(project.id, phaseId);
  }

  function renderProjectIcon(project: HubProject) {
    if (project.icon) {
      return <IconRenderer value={project.icon} size={14} color={project.color} className="shrink-0" />;
    }
    return <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: project.color }} />;
  }

  function renderProject(project: HubProject, showRecent = false) {
    const phases = project.phases || [];
    const isMember = taskProjectIds.includes(project.id);
    const memberships = taskProjectPhaseMemberships.filter((membership) => membership.projectId === project.id);
    const selectedPhaseIds = new Set(memberships.map((membership) => membership.phaseId));
    const selectedPhaseNames = memberships
      .map((membership) => membership.phaseName)
      .filter((name): name is string => Boolean(name));
    const isUnphased = isMember && (memberships.length === 0 || selectedPhaseIds.has(null));
    if (phases.length === 0) {
      return (
        <ContextMenu.Item
          key={project.id}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
          onSelect={() => handleSelect(project)}
        >
          {showRecent && <Clock size={11} className="shrink-0 text-[var(--text-muted)]" />}
          {renderProjectIcon(project)}
          {project.name}
          {isMember && <Check size={14} className="ml-auto shrink-0 text-[var(--accent)]" />}
        </ContextMenu.Item>
      );
    }

    // Has phases — nested submenu
    return (
      <ContextMenu.Sub key={project.id}>
        <ContextMenu.SubTrigger className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]">
          {showRecent && <Clock size={11} className="shrink-0 text-[var(--text-muted)]" />}
          {renderProjectIcon(project)}
          {project.name}
          {selectedPhaseNames.length > 0 && (
            <span className="ml-auto max-w-24 truncate text-xs text-[var(--text-muted)]">
              {selectedPhaseNames.join(', ')}
            </span>
          )}
          {isMember && <Check size={14} className="shrink-0 text-[var(--accent)]" />}
          <ChevronRight size={13} className={selectedPhaseNames.length > 0 || isMember ? 'text-[var(--text-muted)]' : 'ml-auto text-[var(--text-muted)]'} />
        </ContextMenu.SubTrigger>
        <ContextMenu.Portal>
          <ContextMenu.SubContent
            className={`min-w-[160px] max-h-64 overflow-y-auto ${SUB_CONTENT_CLASS}`}
          >
            <ContextMenu.CheckboxItem
              checked={isUnphased}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-secondary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
              onSelect={() => handleSelect(project)}
            >
              No phase
              {isUnphased && <Check size={14} className="ml-auto shrink-0 text-[var(--accent)]" />}
            </ContextMenu.CheckboxItem>
            {phases.map((phase) => (
              <ContextMenu.CheckboxItem
                key={phase.id}
                checked={selectedPhaseIds.has(phase.id)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--surface-2)] transition-colors duration-75 mx-1 rounded-[var(--radius-sm)]"
                onSelect={() => handleSelect(project, phase.id)}
              >
                <Layers3 size={12} className="text-[var(--text-muted)]" />
                {phase.name}
                {selectedPhaseIds.has(phase.id) && <Check size={14} className="ml-auto shrink-0 text-[var(--accent)]" />}
              </ContextMenu.CheckboxItem>
            ))}
          </ContextMenu.SubContent>
        </ContextMenu.Portal>
      </ContextMenu.Sub>
    );
  }

  return (
    <>
      {recentProjects.length > 0 && (
        <>
          {recentProjects.map((p) => renderProject(p, true))}
          <ContextMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
        </>
      )}
      {sortedCategories.map((cat, idx) => (
        <React.Fragment key={cat || '__uncategorized'}>
          {idx > 0 && <ContextMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />}
          {cat && (
            <ContextMenu.Label className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              {cat}
            </ContextMenu.Label>
          )}
          {grouped.get(cat)!.map((p) => renderProject(p))}
        </React.Fragment>
      ))}
    </>
  );
}
