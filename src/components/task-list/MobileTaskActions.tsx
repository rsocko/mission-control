'use client';

import React, { useState } from 'react';
import {
  Archive, CheckCircle2, Sun, Calendar, ArrowRight, Trash2, FolderMinus,
  Clock, CalendarClock, CalendarPlus, Flag, FastForward, FileText, XCircle, CircleDot, Layers3,
  FolderPlus, Check, ChevronRight, ChevronLeft, ArrowLeftRight,
} from 'lucide-react';
import Image from 'next/image';
import { DayPicker } from 'react-day-picker';
import { MobileSheet } from '@/components/ui/MobileSheet';
import { getLocalToday } from '@/lib/utils/client-date';
import { getNextRecurringDate } from '@/lib/utils/recurrence';
import { getDeepLinkInfo } from '@/lib/utils/deep-links';
import { calendarClassNames } from '@/components/ui/calendar-classes';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { triggerHapticFeedback } from '@/lib/utils/haptics';
import type { TaskContextMenuActions, HubProject, TaskProjectPhaseMembership } from './TaskContextMenu';
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

interface SourceList {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  name: string;
  taskCount: number;
  groupId: string | null;
  sortOrder?: number;
}

interface MobileTaskActionsProps {
  isOpen: boolean;
  onClose: () => void;
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

type SubView = 'main' | 'priority' | 'status' | 'disposition' | 'date-picker' | 'move-list' | 'move-phase' | 'add-project';

const ITEM_CLASS = 'flex items-center gap-3 px-4 py-3 text-sm text-[var(--text-primary)] active:bg-[var(--surface-2)] transition-colors min-h-[44px]';
const SEPARATOR_CLASS = 'h-px bg-[var(--border-subtle)] my-1 mx-4';

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

/**
 * Mobile action sheet for task operations.
 * Replaces the desktop right-click context menu on touch devices.
 */
export function MobileTaskActions({
  isOpen,
  onClose,
  task,
  actions,
  sourceLists = [],
  listGroups = [],
  projectPhases = [],
  projects = [],
  taskProjectIds = [],
  taskProjectPhaseMemberships = [],
  isInMyDay = false,
}: MobileTaskActionsProps) {
  const [subView, setSubView] = useState<SubView>('main');
  const canEdit = (field: TaskField) => canEditTaskField(task.editPolicy, field);
  const blockedReason = (field: TaskField) => taskFieldBlockedReason(task.editPolicy, field);
  const canDelete = canRemoveTask(task.editPolicy);
  const canMoveWithinSource = task.editPolicy.sourceMoveSupported;
  const dispositionOptions = TASK_DISPOSITION_OPTIONS.filter((option) => (
    option.value !== task.localDisposition
    && canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, option.value)
  ));

  const sameSourceLists = task.connectorInstanceId
    ? sourceLists.filter((l) => l.connectorInstanceId === task.connectorInstanceId)
    : sourceLists;
  const hasSameSourceLists = sameSourceLists.length > 0 && !!actions.onMoveToList;
  const deepLink = task.sourceId ? getDeepLinkInfo(task.connectorType, task.sourceId) : null;

  const today = getLocalToday();
  const dueDateStr = task.dueDate?.split('T')[0] ?? null;
  const isOverdue = !!dueDateStr && dueDateStr < today;
  const showSkipToCurrent = isOverdue && !!task.recurrence && !!actions.onSkipToCurrent;
  const nextRecurringDate = showSkipToCurrent
    ? getNextRecurringDate(dueDateStr!, task.recurrence!, today)
    : null;

  function handleClose() {
    setSubView('main');
    onClose();
  }

  function selectAndClose(fn?: () => void) {
    fn?.();
    handleClose();
  }

  // Render based on current sub-view
  function renderContent() {
    switch (subView) {
      case 'priority':
        return (
          <div>
            <button onClick={() => setSubView('main')} className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--text-muted)]">
              <ChevronLeft size={14} /> Back
            </button>
            <div className={SEPARATOR_CLASS} />
            {PRIORITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`${ITEM_CLASS} ${opt.color} ${task.priority === opt.value ? 'font-semibold' : ''} w-full`}
                onClick={() => {
                  triggerHapticFeedback('priority');
                  actions.onSetPriority(opt.value);
                  handleClose();
                }}
              >
                {task.priority === opt.value && <Check size={14} />}
                {opt.label}
              </button>
            ))}
          </div>
        );

      case 'status':
        return (
          <div>
            <button onClick={() => setSubView('main')} className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--text-muted)]">
              <ChevronLeft size={14} /> Back
            </button>
            <div className={SEPARATOR_CLASS} />
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`${ITEM_CLASS} ${opt.color} ${task.status === opt.value ? 'font-semibold' : ''} w-full`}
                onClick={() => { actions.onSetStatus?.(opt.value); handleClose(); }}
              >
                {task.status === opt.value && <Check size={14} />}
                {opt.label}
              </button>
            ))}
          </div>
        );

      case 'disposition':
        return (
          <div>
            <button onClick={() => setSubView('main')} className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--text-muted)]">
              <ChevronLeft size={14} /> Back
            </button>
            <p className="px-4 pb-2 text-xs text-[var(--text-muted)]">
              Mission Control only. The upstream task is unchanged.
            </p>
            <div className={SEPARATOR_CLASS} />
            {dispositionOptions.map((option) => (
              <button
                key={option.value}
                className={`${ITEM_CLASS} w-full items-start`}
                aria-label={`${option.label}. ${option.detail}`}
                onClick={() => {
                  actions.onSetLocalDisposition?.(option.value);
                  handleClose();
                }}
              >
                <Archive size={16} className="mt-0.5 text-emerald-400" />
                <span className="text-left">
                  <span className="block">{option.label}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{option.detail}</span>
                </span>
              </button>
            ))}
          </div>
        );

      case 'date-picker':
        return (
          <div className="px-4 py-3">
            <button onClick={() => setSubView('main')} className="flex items-center gap-2 mb-3 text-sm text-[var(--text-muted)]">
              <ChevronLeft size={14} /> Back
            </button>
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
                handleClose();
              }}
              defaultMonth={(() => {
                const dateOnly = task.dueDate ? task.dueDate.slice(0, 10) : null;
                const parsed = dateOnly ? new Date(dateOnly + 'T00:00:00') : undefined;
                return parsed && !isNaN(parsed.getTime()) ? parsed : new Date();
              })()}
              showOutsideDays
              classNames={calendarClassNames}
            />
            <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-1 py-2 mt-1">
              <button
                type="button"
                onClick={() => { actions.onClearDueDate?.(); handleClose(); }}
                className="text-xs text-[var(--text-muted)]"
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
                  handleClose();
                }}
                className="text-xs text-[var(--accent-400)] font-medium"
              >
                Today
              </button>
            </div>
          </div>
        );

      case 'move-phase':
        return (
          <div>
            <button onClick={() => setSubView('main')} className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--text-muted)]">
              <ChevronLeft size={14} /> Back
            </button>
            <div className={SEPARATOR_CLASS} />
            <button
              className={`${ITEM_CLASS} w-full text-[var(--text-secondary)]`}
              onClick={() => { actions.onMoveToPhase?.(null); handleClose(); }}
            >
              <XCircle size={14} className="text-[var(--text-muted)]" />
              No phase
            </button>
            {projectPhases.map((phase) => (
              <button
                key={phase.id}
                className={`${ITEM_CLASS} w-full`}
                onClick={() => { actions.onMoveToPhase?.(phase.id); handleClose(); }}
              >
                <Layers3 size={14} className="text-[var(--text-muted)]" />
                {phase.name}
              </button>
            ))}
          </div>
        );

      case 'move-list': {
        const listsToShow = canMoveWithinSource ? sameSourceLists : [];
        const hasGroups = listGroups.length > 0;
        let groupedLists: { group: ListGroup | null; lists: SourceList[] }[];
        if (!hasGroups) {
          groupedLists = [{ group: null, lists: [...listsToShow].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name)) }];
        } else {
          const buckets = new Map<string | null, SourceList[]>();
          for (const list of listsToShow) {
            const key = list.groupId;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key)!.push(list);
          }
          for (const arr of buckets.values()) {
            arr.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name));
          }
          groupedLists = [];
          const sortedGroups = [...listGroups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
          for (const g of sortedGroups) {
            const lists = buckets.get(g.id);
            if (lists && lists.length > 0) groupedLists.push({ group: g, lists });
          }
          const ungrouped = buckets.get(null);
          if (ungrouped && ungrouped.length > 0) groupedLists.push({ group: null, lists: ungrouped });
        }
        return (
          <div>
            <button onClick={() => setSubView('main')} className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--text-muted)]">
              <ChevronLeft size={14} /> Back
            </button>
            <div className={SEPARATOR_CLASS} />
            {groupedLists.map(({ group, lists }) => (
              <React.Fragment key={group?.id ?? '__ungrouped'}>
                {group && (
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
                    {group.name}
                  </div>
                )}
                {lists.map((list) => (
                  <button
                    key={list.id}
                    className={`${ITEM_CLASS} w-full ${group ? 'pl-8' : ''}`}
                    onClick={() => { actions.onMoveToList?.(list.id); handleClose(); }}
                  >
                    {list.name}
                  </button>
                ))}
              </React.Fragment>
            ))}
            {actions.onMoveToSource && (
              <>
                <div className={SEPARATOR_CLASS} />
                <button
                  className={`${ITEM_CLASS} w-full text-[var(--text-muted)]`}
                  onClick={() => { actions.onMoveToSource?.(); handleClose(); }}
                >
                  <ArrowLeftRight size={16} className="shrink-0" />
                  Move to another source…
                </button>
              </>
            )}
          </div>
        );
      }

      case 'add-project':
        return (
          <div>
            <button onClick={() => setSubView('main')} className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--text-muted)]">
              <ChevronLeft size={14} /> Back
            </button>
            <div className={SEPARATOR_CLASS} />
            {projects.map((project) => {
              const memberships = taskProjectPhaseMemberships.filter((membership) => membership.projectId === project.id);
              const selectedPhaseIds = new Set(memberships.map((membership) => membership.phaseId));
              const isMember = taskProjectIds.includes(project.id);
              const isUnphased = isMember && (memberships.length === 0 || selectedPhaseIds.has(null));
              const phases = project.phases || [];

              if (phases.length === 0) {
                return (
                  <button
                    key={project.id}
                    className={`${ITEM_CLASS} w-full`}
                    aria-pressed={isMember}
                    onClick={() => { actions.onAddToProject?.(project.id, null); handleClose(); }}
                  >
                    {project.icon && <IconRenderer value={project.icon} size={14} />}
                    <span style={{ color: project.color }}>{project.name}</span>
                    {isMember && <Check size={12} className="ml-auto text-green-400" />}
                  </button>
                );
              }

              return (
                <div key={project.id}>
                  <div className={`${ITEM_CLASS} min-h-0 pb-1 text-xs font-medium`} style={{ color: project.color }}>
                    {project.icon && <IconRenderer value={project.icon} size={14} />}
                    {project.name}
                  </div>
                  <button
                    className={`${ITEM_CLASS} w-full pl-10`}
                    aria-pressed={isUnphased}
                    onClick={() => { actions.onAddToProject?.(project.id, null); handleClose(); }}
                  >
                    No phase
                    {isUnphased && <Check size={12} className="ml-auto text-green-400" />}
                  </button>
                  {phases.map((phase) => (
                    <button
                      key={phase.id}
                      className={`${ITEM_CLASS} w-full pl-10`}
                      aria-pressed={selectedPhaseIds.has(phase.id)}
                      onClick={() => { actions.onAddToProject?.(project.id, phase.id); handleClose(); }}
                    >
                      <Layers3 size={14} className="text-[var(--text-muted)]" />
                      {phase.name}
                      {selectedPhaseIds.has(phase.id) && <Check size={12} className="ml-auto text-green-400" />}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        );

      default:
        return renderMainView();
    }
  }

  function renderMainView() {
    return (
      <div>
        {/* Task title */}
        <div className="px-4 py-2 text-xs font-medium text-[var(--text-muted)] truncate">
          {task.title}
        </div>
        <div className={SEPARATOR_CLASS} />

        {/* My Day */}
        <button className={`${ITEM_CLASS} w-full`} onClick={() => selectAndClose(isInMyDay ? actions.onRemoveFromMyDay : actions.onAddToMyDay)}>
          <Sun size={16} className="text-amber-400" />
          {isInMyDay ? 'Remove from My Day' : 'Add to My Day'}
        </button>

        {/* Priority */}
        <button className={`${ITEM_CLASS} w-full ${!canEdit('priority') ? 'opacity-50' : ''}`} disabled={!canEdit('priority')} title={!canEdit('priority') ? blockedReason('priority') : undefined} onClick={() => setSubView('priority')}>
          <Flag size={16} className="text-orange-400" />
          Set priority
          <span className="ml-auto flex items-center gap-1">
            <span className={`text-xs ${PRIORITY_OPTIONS.find(p => p.value === task.priority)?.color || ''}`}>
              {task.priority !== 'none' ? task.priority : ''}
            </span>
            <ChevronRight size={14} className="text-[var(--text-muted)]" />
          </span>
        </button>

        {/* Status */}
        {actions.onSetStatus && (
          <button className={`${ITEM_CLASS} w-full ${!canEdit('status') ? 'opacity-50' : ''}`} disabled={!canEdit('status')} title={!canEdit('status') ? blockedReason('status') : undefined} onClick={() => setSubView('status')}>
            <CircleDot size={16} className="text-purple-400" />
            Status
            <span className="ml-auto flex items-center gap-1">
              <span className={`text-xs ${STATUS_OPTIONS.find(s => s.value === task.status)?.color || ''}`}>
                {STATUS_OPTIONS.find(s => s.value === task.status)?.label || ''}
              </span>
              <ChevronRight size={14} className="text-[var(--text-muted)]" />
            </span>
          </button>
        )}

        <div className={SEPARATOR_CLASS} />

        {/* Complete */}
        <button
          className={`${ITEM_CLASS} w-full ${!canEdit('status') ? 'opacity-50' : ''}`}
          disabled={!canEdit('status')}
          title={!canEdit('status') ? blockedReason('status') : undefined}
          onClick={() => {
            triggerHapticFeedback('taskComplete');
            selectAndClose(actions.onComplete);
          }}
        >
          <CheckCircle2 size={16} className="text-green-400" />
          Mark as completed
        </button>

        {actions.onSetLocalDisposition && dispositionOptions.length > 0 && (
          <button className={`${ITEM_CLASS} w-full text-emerald-300`} onClick={() => setSubView('disposition')}>
            <Archive size={16} />
            Mission Control state
            <ChevronRight size={14} className="ml-auto text-[var(--text-muted)]" />
          </button>
        )}

        <div className={SEPARATOR_CLASS} />

        {/* Due date shortcuts */}
        <button className={`${ITEM_CLASS} w-full ${!canEdit('dueDate') ? 'opacity-50' : ''}`} disabled={!canEdit('dueDate')} title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined} onClick={() => selectAndClose(actions.onDueToday)}>
          <Calendar size={16} className="text-blue-400" />
          Due today
        </button>
        <button className={`${ITEM_CLASS} w-full ${!canEdit('dueDate') ? 'opacity-50' : ''}`} disabled={!canEdit('dueDate')} title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined} onClick={() => selectAndClose(actions.onDueTomorrow)}>
          <CalendarClock size={16} className="text-orange-400" />
          Due tomorrow
        </button>
        <button className={`${ITEM_CLASS} w-full ${!canEdit('dueDate') ? 'opacity-50' : ''}`} disabled={!canEdit('dueDate')} title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined} onClick={() => setSubView('date-picker')}>
          <CalendarPlus size={16} className="text-purple-400" />
          Pick a date…
        </button>

        {/* Clear due date */}
        {task.dueDate && actions.onClearDueDate && (
          <button className={`${ITEM_CLASS} w-full ${!canEdit('dueDate') ? 'opacity-50' : ''}`} disabled={!canEdit('dueDate')} title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined} onClick={() => selectAndClose(actions.onClearDueDate)}>
            <XCircle size={16} className="text-[var(--text-muted)]" />
            Clear due date
          </button>
        )}

        {/* Skip to current */}
        {showSkipToCurrent && (
          <button className={`${ITEM_CLASS} w-full ${!canEdit('dueDate') ? 'opacity-50' : ''}`} disabled={!canEdit('dueDate')} title={!canEdit('dueDate') ? blockedReason('dueDate') : undefined} onClick={() => selectAndClose(actions.onSkipToCurrent)}>
            <FastForward size={16} className="text-blue-400" />
            Skip to current
            {nextRecurringDate && <span className="ml-auto text-xs text-[var(--text-muted)]">{nextRecurringDate}</span>}
          </button>
        )}

        <div className={SEPARATOR_CLASS} />

        {/* Add to project */}
        {actions.onAddToProject && projects.length > 0 && (
          <button className={`${ITEM_CLASS} w-full ${!canEdit('projects') ? 'opacity-50' : ''}`} disabled={!canEdit('projects')} title={!canEdit('projects') ? blockedReason('projects') : undefined} onClick={() => setSubView('add-project')}>
            <FolderPlus size={16} className="text-blue-400" />
            Add to project…
            <ChevronRight size={14} className="ml-auto text-[var(--text-muted)]" />
          </button>
        )}

        {/* Move to phase */}
        {actions.onMoveToPhase && projectPhases.length > 0 && canEdit('phases') && (
          <button className={`${ITEM_CLASS} w-full`} onClick={() => setSubView('move-phase')}>
            <Layers3 size={16} className="text-[var(--text-muted)]" />
            Move to phase…
            <ChevronRight size={14} className="ml-auto text-[var(--text-muted)]" />
          </button>
        )}

        {/* Move to list */}
        {(hasSameSourceLists && canMoveWithinSource || !!actions.onMoveToSource) && (
          <button className={`${ITEM_CLASS} w-full`} onClick={() => setSubView('move-list')}>
            <ArrowRight size={16} className="text-[var(--text-muted)]" />
            Move task to…
            <ChevronRight size={14} className="ml-auto text-[var(--text-muted)]" />
          </button>
        )}

        {/* Save as template */}
        {actions.onSaveAsTemplate && (
          <button className={`${ITEM_CLASS} w-full`} onClick={() => selectAndClose(actions.onSaveAsTemplate)}>
            <FileText size={16} className="text-teal-400" />
            Save as template…
          </button>
        )}

        {/* Open in source */}
        {deepLink && (
          <button
            className={`${ITEM_CLASS} w-full`}
            onClick={() => {
              const url = deepLink.url;
              if (url.startsWith('https://') || url.startsWith('http://')) {
                window.open(url, '_blank', 'noopener,noreferrer');
              }
              handleClose();
            }}
          >
            <Image src={deepLink.icon} alt={deepLink.label} width={16} height={16} className="flex-shrink-0" />
            Open in {deepLink.label}
          </button>
        )}

        {/* Remove from project */}
        {actions.onRemoveFromProject && (
          <>
            <div className={SEPARATOR_CLASS} />
            <button className={`${ITEM_CLASS} w-full text-orange-400`} onClick={() => selectAndClose(actions.onRemoveFromProject)}>
              <FolderMinus size={16} />
              Remove from this project
            </button>
          </>
        )}

        {/* Delete */}
        <div className={SEPARATOR_CLASS} />
        <button
          className={`${ITEM_CLASS} w-full ${canDelete ? 'text-red-400' : 'text-[var(--text-muted)] opacity-50'}`}
          disabled={!canDelete}
          title={!canDelete ? task.editPolicy.removalReason : undefined}
          onClick={() => {
            triggerHapticFeedback('delete');
            selectAndClose(actions.onDelete);
          }}
        >
          <Trash2 size={16} />
          {taskRemovalLabel(task.editPolicy)}
        </button>
      </div>
    );
  }

  return (
    <MobileSheet
      isOpen={isOpen}
      onClose={handleClose}
      title="Task Actions"
      height="auto"
    >
      <div className="max-h-[70vh] overflow-y-auto pb-safe">
        {renderContent()}
      </div>
    </MobileSheet>
  );
}
