'use client';

import Image from 'next/image';
import { Clock, GripVertical, Repeat, RotateCcw, Square, Sun, Target } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion, useMotionValue, useTransform, type PanInfo } from 'motion/react';
import { TaskContextMenu, type TaskContextMenuActions, type HubProject } from '@/components/task-list/TaskContextMenu';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import { SubtaskPill } from '@/components/ui/SubtaskPill';
import { Tooltip } from '@/components/ui/Tooltip';
import { TaskRowActions } from '@/components/task-row/TaskRowActions';
import { TaskBlockedBadge, TaskStatusIndicator, isTaskBlocked } from '@/components/task-list/TaskStatusIndicator';
import { MicroStatusIcon } from '@/components/task-list/MicroStatusIcon';
import { getTagPillStyle } from '@/lib/constants/colors';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { extractRecurrenceFromMetadata } from '@/lib/utils/recurrence';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { CONNECTOR_ICONS } from '@/types/dashboard';
import type { ListGroup } from '@/types/dashboard';
import { MICRO_STATUS_CONFIG } from '@/types';
import type { MicroStatus } from '@/types';
import type { MyDayItem, ScheduledTask, SourceList } from './types';

export function ConnectorIcon({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICONS[type];
  if (!src) return <Square size={size} className="text-[var(--text-muted)]" />;
  return <Image src={src} alt={type} width={size} height={size} className="shrink-0" />;
}

interface SortableTaskRowProps {
  item: MyDayItem;
  taskSchedule?: ScheduledTask;
  onComplete: (taskId: string) => void;
  onFocus: (item: MyDayItem) => void;
  onSchedule: (taskId: string) => void;
  onRemove: (taskId: string) => void;
  onSelect: (taskId: string) => void;
  onDoubleClick?: (taskId: string) => void;
  onModifierClick?: (taskId: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
  isSelected: boolean;
  isCompleting?: boolean;
  bulkMode?: boolean;
  bulkSelected?: boolean;
  onBulkToggle?: () => void;
  contextMenuActions?: TaskContextMenuActions;
  sourceLists?: SourceList[];
  listGroups?: ListGroup[];
  projects?: HubProject[];
  onSetDueDate: (date: string | null) => void | Promise<void>;
  onSetPriority: (priority: string) => void | Promise<void>;
  onSetStatus: (status: string) => void | Promise<void>;
  onFilterPriority?: (priority: string) => void;
  onFilterStatus?: (status: string) => void;
  onOpenNotes: (mode: 'read' | 'edit') => void;
  compact?: boolean;
  draggable?: boolean;
  sortableId?: string;
  activeTagFilters?: string[];
  onToggleTagFilter?: (tagSlug: string) => void;
}

export function SortableTaskRow({
  item,
  taskSchedule,
  onComplete,
  onFocus,
  onSchedule,
  onRemove,
  onSelect,
  onDoubleClick,
  onModifierClick,
  isSelected,
  isCompleting = false,
  bulkMode = false,
  bulkSelected = false,
  onBulkToggle,
  contextMenuActions,
  sourceLists,
  listGroups,
  projects,
  onSetDueDate,
  onSetPriority,
  onSetStatus,
  onFilterPriority,
  onFilterStatus,
  onOpenNotes,
  compact = false,
  draggable = true,
  sortableId,
  activeTagFilters,
  onToggleTagFilter,
}: SortableTaskRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId ?? item.id,
    disabled: !draggable,
  });
  const { tagFilter, setTagFilter } = useDashboardViewStore();
  const selectedTagFilters = activeTagFilters ?? tagFilter;
  const isMobile = useIsMobile();
  const taskMeta = item.metadata ? (() => { try { return JSON.parse(item.metadata); } catch { return null; } })() : null;
  const recurrence = taskMeta?.recurrence;
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging || isCompleting || isInactiveTaskStatus(item.status) ? 0.5 : 1,
  };

  // Swipe gestures (mobile only)
  const swipeX = useMotionValue(0);
  const swipeBg = useTransform(swipeX, (x) => x >= 0
    ? `rgba(34,197,94,${Math.min(Math.abs(x) / 500, 0.2)})`
    : `rgba(245,158,11,${Math.min(Math.abs(x) / 500, 0.2)})`
  );
  const swipeCheckOpacity = useTransform(swipeX, [0, 60, 100], [0, 0.5, 1]);
  const swipeDeferOpacity = useTransform(swipeX, [-100, -60, 0], [1, 0.5, 0]);

  function handleSwipeDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.x > 100) {
      onComplete(item.taskId);
      if (navigator.vibrate) navigator.vibrate(10);
    } else if (info.offset.x < -100) {
      onRemove(item.taskId);
      if (navigator.vibrate) navigator.vibrate(10);
    }
  }

  const rowContent = (
    <div
      ref={setNodeRef}
      style={style}
      className={`@container px-4 ${compact ? 'py-1.5' : 'py-3 md:py-3'} flex items-center gap-3 hover:bg-[var(--surface-0)] group cursor-pointer transition-[background-color,opacity] duration-300 relative ${compact ? 'min-h-[40px]' : 'min-h-[48px] md:min-h-0'} ${isCompleting ? 'bg-green-900/10' : ''} ${bulkSelected ? 'bg-blue-900/20' : ''} ${isSelected ? 'ring-1 ring-inset ring-[var(--accent-400)] bg-[var(--accent-500)]/8 rounded-sm' : ''}`}
      onMouseDown={(e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
      }}
      onClick={(e) => {
        if ((e.shiftKey || e.ctrlKey || e.metaKey) && onModifierClick) {
          e.preventDefault();
          onModifierClick(item.taskId, e);
        } else if (bulkMode && onBulkToggle) {
          onBulkToggle();
        } else {
          onSelect(item.taskId);
        }
      }}
      onDoubleClick={() => !bulkMode && onDoubleClick?.(item.taskId)}
    >
      {bulkMode ? (
        <label className="min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center flex-shrink-0 cursor-pointer">
          <input
            type="checkbox"
            checked={bulkSelected}
            onChange={onBulkToggle}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${item.title}`}
            className="w-5 h-5 md:w-4 md:h-4 rounded border-[var(--border-strong)] accent-[var(--accent-500)] cursor-pointer"
          />
        </label>
      ) : draggable ? (
        <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity -ml-1 p-2 md:p-0 touch-none">
          <GripVertical size={isMobile ? 18 : 14} />
        </button>
      ) : null}
      <CompletionBurst celebrating={isCompleting}>
        <button
          onClick={(e) => { e.stopPropagation(); onComplete(item.taskId); }}
          disabled={isCompleting}
          className="group/status flex h-6 w-6 shrink-0 items-center justify-center md:h-5 md:w-5"
          aria-label={`Complete ${item.title}`}
        >
          <TaskStatusIndicator
            status={item.status}
            microStatus={item.microStatus}
            isCompleting={isCompleting}
            size={isMobile ? 'lg' : 'md'}
          />
        </button>
      </CompletionBurst>
      <span className="flex-shrink-0"><ConnectorIcon type={item.connectorType} size={isMobile ? 16 : 14} /></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className={`text-[15px] md:text-sm font-medium truncate transition-[color,text-decoration] duration-200 ${isCompleting ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{item.title}</p>
          {(() => {
            const displayId = getTaskDisplayId(item.connectorType, item.metadata, item.sourceId);
            return displayId ? (
              <span className="text-xs text-[var(--text-muted)] flex-shrink-0 font-mono tabular-nums">{displayId}</span>
            ) : null;
          })()}
          {item.microStatus && isTaskBlocked(item.status, item.microStatus) ? (
            <TaskBlockedBadge status={item.status} microStatus={item.microStatus} />
          ) : item.microStatus && MICRO_STATUS_CONFIG[item.microStatus as MicroStatus] && (
            <span
              className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs font-medium"
              style={{
                backgroundColor: `${MICRO_STATUS_CONFIG[item.microStatus as MicroStatus].color}20`,
                color: MICRO_STATUS_CONFIG[item.microStatus as MicroStatus].color,
              }}
              title={MICRO_STATUS_CONFIG[item.microStatus as MicroStatus].description}
            >
              <MicroStatusIcon status={item.microStatus as MicroStatus} size={11} />
              {MICRO_STATUS_CONFIG[item.microStatus as MicroStatus].label}
            </span>
          )}
          <SubtaskPill done={item.subtaskDone ?? 0} total={item.subtaskTotal ?? 0} />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden">
          {item.sourceListName && (
            <span className="max-w-[120px] min-w-0 truncate text-xs text-[var(--text-muted)]">{item.sourceListName}</span>
          )}
          {taskSchedule?.scheduledTime && (
            <span className="text-xs text-purple-400 bg-purple-900/30 px-1.5 py-0.5 rounded flex items-center gap-0.5">
              <Clock size={9} /> {taskSchedule.scheduledTime} ({taskSchedule.estimatedDuration || 30}m)
            </span>
          )}
          {item.tags?.filter(tag => !isSyntheticTag(tag.name)).map((tag) => (
            <button
              key={tag.id}
              onClick={(e) => {
                e.stopPropagation();
                if (onToggleTagFilter) {
                  onToggleTagFilter(tag.slug);
                } else {
                  setTagFilter(
                    tagFilter.includes(tag.slug)
                      ? tagFilter.filter((t) => t !== tag.slug)
                      : [...tagFilter, tag.slug]
                  );
                }
              }}
              className={`text-xs px-2 py-1 md:px-1.5 md:py-0 rounded-full cursor-pointer hover:opacity-80 transition-colors ${
                selectedTagFilters.includes(tag.slug) ? 'ring-2 ring-[var(--accent)] border border-[var(--accent)]' : ''
              }`}
              style={getTagPillStyle(tag.color)}
              title={`Filter by "${tag.name}"`}
            >
              {tag.name}
            </button>
          ))}
          {(item.pushCount ?? 0) >= 2 && (
            <span
              className="hidden flex-shrink-0 items-center gap-0.5 rounded border border-amber-800/30 bg-amber-900/20 px-1.5 py-0.5 text-xs text-amber-400 @min-[640px]:flex"
              title={`Rescheduled ${item.pushCount ?? 0} times`}
            >
              <RotateCcw size={10} aria-hidden="true" /> {item.pushCount ?? 0}
            </span>
          )}
          {item.estimatedDuration && !taskSchedule?.scheduledTime && (
            <span
              className="hidden flex-shrink-0 items-center gap-0.5 rounded border border-blue-800/30 bg-blue-900/20 px-1.5 py-0.5 text-xs text-blue-400 tabular-nums @min-[640px]:flex"
              title={`Estimated: ${item.estimatedDuration}min`}
            >
              ⏱ {item.estimatedDuration >= 60 ? `${Math.floor(item.estimatedDuration / 60)}h${item.estimatedDuration % 60 ? ` ${item.estimatedDuration % 60}m` : ''}` : `${item.estimatedDuration}m`}
            </span>
          )}
          {recurrence && (
            <Tooltip content={`Repeats: ${recurrence}`}>
              <span className="hidden flex-shrink-0 items-center text-xs text-blue-400 @min-[640px]:flex">
                <Repeat size={10} />
              </span>
            </Tooltip>
          )}
        </div>
      </div>
      <TaskRowActions
        smartScore={item.smartScore}
        scoreBreakdown={item.scoreBreakdown ?? undefined}
        planningHorizon={item.planningHorizon}
        effort={item.effort}
        dueDate={item.dueDate}
        hasDescription={item.hasDescription}
        isInMyDay
        priority={item.priority}
        status={item.status}
        editPolicy={item.editPolicy}
        surface="my-day"
        onSetDueDate={onSetDueDate}
        onSetPriority={onSetPriority}
        onSetStatus={onSetStatus}
        onFilterPriority={onFilterPriority}
        onFilterStatus={onFilterStatus}
        onToggleMyDay={() => onRemove(item.taskId)}
        onOpenNotes={onOpenNotes}
        showMoreActions={Boolean(contextMenuActions)}
        surfaceActions={(
          <>
            <Tooltip content="Focus on this" subtitle="Enter focus mode with a timer">
              <button onClick={(e) => { e.stopPropagation(); onFocus(item); }} className="p-1.5 text-purple-400 hover:bg-purple-900/30 rounded-md"><Target size={14} /></button>
            </Tooltip>
            <Tooltip content="Time-block" subtitle="Schedule a time block for this task">
              <button onClick={(e) => { e.stopPropagation(); onSchedule(item.taskId); }} className="p-1.5 text-blue-400 hover:bg-blue-900/30 rounded-md"><Clock size={14} /></button>
            </Tooltip>
          </>
        )}
      />
    </div>
  );

  // Wrap in swipe gestures on mobile (right=complete, left=defer)
  const swipeWrappedContent = isMobile ? (
    <motion.div
      className="relative overflow-hidden"
      style={{ background: swipeBg }}
    >
      {/* Right swipe indicator (complete) */}
      <motion.div
        className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-2 text-green-400 pointer-events-none"
        style={{ opacity: swipeCheckOpacity }}
      >
        <span className="text-lg">✓</span>
        <span className="text-xs font-medium">Complete</span>
      </motion.div>
      {/* Left swipe indicator (defer/remove) */}
      <motion.div
        className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2 text-amber-400 pointer-events-none"
        style={{ opacity: swipeDeferOpacity }}
      >
        <span className="text-xs font-medium">Remove</span>
        <Sun size={16} />
      </motion.div>
      <motion.div
        drag="x"
        dragConstraints={{ left: -150, right: 150 }}
        dragElastic={0.1}
        dragSnapToOrigin
        onDragEnd={handleSwipeDragEnd}
        style={{ x: swipeX }}
      >
        {rowContent}
      </motion.div>
    </motion.div>
  ) : rowContent;

  if (!contextMenuActions) return swipeWrappedContent;

  return (
    <TaskContextMenu
      task={{
        id: item.taskId,
        title: item.title,
        status: item.status || 'todo',
        priority: item.priority || 'none',
        connectorType: item.connectorType || 'microsoft-todo',
        connectorInstanceId: item.connectorInstanceId,
        sourceId: item.sourceId,
        dueDate: item.dueDate || null,
        recurrence: extractRecurrenceFromMetadata(item.metadata),
        localDisposition: item.localDisposition,
        taskSourceModel: item.taskSourceModel,
        editPolicy: item.editPolicy,
      }}
      isInMyDay
      actions={contextMenuActions}
      sourceLists={sourceLists}
      listGroups={listGroups}
      projects={projects}
      taskProjectIds={item.hubProjectIds}
      taskProjectPhaseMemberships={item.projectPhaseMemberships}
    >
      {swipeWrappedContent}
    </TaskContextMenu>
  );
}
