'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion } from 'motion/react';
import Image from 'next/image';
import { Calendar, Clock, GripVertical, Square, Minus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  DndContext, DragOverlay, pointerWithin,
  useDraggable, useDroppable, PointerSensor, KeyboardSensor,
  useSensor, useSensors, DragStartEvent, DragEndEvent, DragOverEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TaskTag {
  id: string;
  name: string;
  slug: string;
  type: string;
  color: string | null;
}

export interface MyDayItem {
  id: string;
  taskId: string;
  order: number;
  isAutoIncluded: boolean;
  addedAt: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  createdAt: string | null;
  tags: TaskTag[];
  metadata?: string | null;
}

export interface ScheduledTask {
  taskId: string;
  scheduledDate: string;
  scheduledTime: string | null;
  estimatedDuration: number | null;
  isTimeBlocked: boolean;
  title: string;
  status: string;
  priority: string;
  connectorType: string;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  startTime: string;
  endTime: string;
  duration: number;
  location?: string;
  isAllDay: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CONNECTOR_ICONS: Record<string, string> = {
  'local': LOCAL_CONNECTOR_ICON_PATH,
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'document-intelligence': '/icons/agents/owl.svg',
};

const SLOT_HEIGHT = 16; // px per 15-min slot
const SLOTS_PER_HOUR = 4;
const START_HOUR = 7;
const END_HOUR = 21;
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * SLOTS_PER_HOUR;
const MIN_DURATION = 15;
const MAX_DURATION = 240;
const DEFAULT_DURATION = 30;

const PRIORITY_BORDER: Record<string, string> = {
  critical: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-yellow-500',
  low: 'border-l-[var(--border)]',
  none: 'border-l-[var(--border)]',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function slotToTime(slot: number): string {
  const totalMinutes = (START_HOUR * 60) + (slot * 15);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

function timeToSlot(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return ((h - START_HOUR) * SLOTS_PER_HOUR) + Math.floor(m / 15);
}

function durationToSlots(minutes: number): number {
  return Math.round(minutes / 15);
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatTimeLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

// ─── Stacking Layout (multi-task per slot) ──────────────────────────────────

interface StackedLayout {
  taskId: string;
  column: number;
  totalColumns: number;
}

/**
 * Compute side-by-side column layout for overlapping scheduled tasks.
 * Uses a greedy interval-graph coloring approach.
 */
function computeStackedLayout(tasks: ScheduledTask[]): Map<string, StackedLayout> {
  const layoutMap = new Map<string, StackedLayout>();
  if (tasks.length === 0) return layoutMap;

  // Build intervals [startSlot, endSlot) for each task
  const intervals = tasks.map(t => {
    const start = t.scheduledTime ? timeToSlot(t.scheduledTime) : 0;
    const duration = t.estimatedDuration || DEFAULT_DURATION;
    const end = start + durationToSlots(duration);
    return { taskId: t.taskId, start, end, column: 0 };
  });

  // Sort by start, then by longer duration first (for stable layout)
  intervals.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  // Greedy column assignment: for each task, find the first column
  // where it doesn't overlap with any already-placed task
  const columns: { end: number }[][] = []; // columns[col] = list of intervals in that col

  for (const interval of intervals) {
    let placed = false;
    for (let col = 0; col < columns.length; col++) {
      const colIntervals = columns[col];
      const overlaps = colIntervals.some(ci => ci.end > interval.start);
      if (!overlaps) {
        interval.column = col;
        colIntervals.push({ end: interval.end });
        placed = true;
        break;
      }
    }
    if (!placed) {
      interval.column = columns.length;
      columns.push([{ end: interval.end }]);
    }
  }

  // For a more precise per-group column count, compute overlap groups
  const groups: typeof intervals[] = [];
  const visited = new Set<number>();

  for (let i = 0; i < intervals.length; i++) {
    if (visited.has(i)) continue;
    const group = [intervals[i]];
    visited.add(i);
    let groupEnd = intervals[i].end;

    for (let j = i + 1; j < intervals.length; j++) {
      if (visited.has(j)) continue;
      if (intervals[j].start < groupEnd) {
        group.push(intervals[j]);
        visited.add(j);
        groupEnd = Math.max(groupEnd, intervals[j].end);
      }
    }
    groups.push(group);
  }

  for (const group of groups) {
    const maxCol = Math.max(...group.map(g => g.column)) + 1;
    for (const interval of group) {
      layoutMap.set(interval.taskId, {
        taskId: interval.taskId,
        column: interval.column,
        totalColumns: maxCol,
      });
    }
  }

  return layoutMap;
}

function ConnectorIcon({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICONS[type];
  if (!src) return <Square size={size} className="text-[var(--text-muted)]" />;
  return <Image src={src} alt={type} width={size} height={size} className="shrink-0" />;
}

// ─── Droppable Timeline Slot ────────────────────────────────────────────────

function TimelineDropSlot({ slotIndex, isHighlighted }: { slotIndex: number; isHighlighted: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `timeline-slot-${slotIndex}`,
    data: { type: 'timeline-slot', slotIndex },
  });

  return (
    <div
      ref={setNodeRef}
      className={`absolute left-0 right-0 h-4 transition-colors duration-150 ${
        isOver ? 'bg-purple-500/20' : isHighlighted ? 'bg-purple-500/10' : ''
      }`}
      style={{ top: slotIndex * SLOT_HEIGHT }}
    />
  );
}

// ─── Draggable Unscheduled Task ─────────────────────────────────────────────

function DraggableUnscheduledTask({ item }: { item: MyDayItem }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `unscheduled-${item.taskId}`,
    data: { type: 'unscheduled-task', item },
  });

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface-1)] hover:bg-[var(--surface-0)] cursor-grab active:cursor-grabbing group transition-[background-color,box-shadow] duration-150 ${
        isDragging ? 'shadow-lg scale-[0.96]' : ''
      }`}
    >
      <GripVertical size={12} className="text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" />
      <ConnectorIcon type={item.connectorType} size={12} />
      <span className="text-xs text-[var(--text-primary)] truncate flex-1">{item.title}</span>
      <span className="text-xs text-[var(--text-muted)]">{DEFAULT_DURATION}m</span>
    </div>
  );
}

// ─── Draggable Scheduled Block ──────────────────────────────────────────────

function ScheduledBlock({
  task,
  onResize,
  onUnschedule,
  column = 0,
  totalColumns = 1,
}: {
  task: ScheduledTask;
  onResize: (taskId: string, newDuration: number) => void;
  onUnschedule: (taskId: string) => void;
  column?: number;
  totalColumns?: number;
}) {
  const slot = task.scheduledTime ? timeToSlot(task.scheduledTime) : 0;
  const duration = task.estimatedDuration || DEFAULT_DURATION;
  const heightSlots = durationToSlots(duration);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDuration, setResizeDuration] = useState(duration);
  const resizeStartRef = useRef<{ y: number; duration: number } | null>(null);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `scheduled-${task.taskId}`,
    data: { type: 'scheduled-task', task },
    disabled: isResizing,
  });

  const blockHeight = (isResizing ? durationToSlots(resizeDuration) : heightSlots) * SLOT_HEIGHT - 2;

  // Column-based positioning for stacked tasks
  const colWidthPercent = 100 / totalColumns;
  const leftPercent = column * colWidthPercent;

  const style: React.CSSProperties = {
    top: slot * SLOT_HEIGHT,
    height: Math.max(blockHeight, SLOT_HEIGHT - 2),
    left: totalColumns > 1 ? `calc(${leftPercent}% + 2px)` : '4px',
    right: totalColumns > 1 ? `calc(${100 - leftPercent - colWidthPercent}% + 2px)` : '4px',
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging || isResizing ? 20 : 10,
  };

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    const startY = e.clientY;
    const startDuration = duration;
    resizeStartRef.current = { y: startY, duration: startDuration };

    const handleResizeMove = (moveEvent: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const dy = moveEvent.clientY - resizeStartRef.current.y;
      const slotsDelta = Math.round(dy / SLOT_HEIGHT);
      const newDuration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, resizeStartRef.current.duration + slotsDelta * 15));
      setResizeDuration(newDuration);
    };

    const handleResizeEnd = () => {
      setIsResizing(false);
      if (resizeStartRef.current) {
        // Calculate final value from the ref instead of stale closure
        const el = document.querySelector(`[data-resize-duration="${task.taskId}"]`);
        const finalDuration = el ? parseInt(el.getAttribute('data-resize-value') || String(duration)) : resizeDuration;
        onResize(task.taskId, finalDuration);
      }
      resizeStartRef.current = null;
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
    };

    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
  }, [duration, resizeDuration, onResize, task.taskId]);

  // Sync resize duration with actual duration when not resizing
  useEffect(() => {
    if (!isResizing) setResizeDuration(duration);
  }, [duration, isResizing]);

  const priorityBorder = PRIORITY_BORDER[task.priority] || PRIORITY_BORDER.none;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-resize-duration={task.taskId}
      data-resize-value={resizeDuration}
      className={`absolute rounded-md border border-purple-800/40 border-l-2 bg-purple-900/30 transition-shadow duration-150 group/block flex cursor-grab flex-col overflow-hidden active:cursor-grabbing ${priorityBorder} ${
        isDragging ? 'shadow-xl' : 'shadow-sm hover:shadow-md'
      }`}
    >
      {/* Main content - draggable */}
      <div
        {...attributes}
        {...listeners}
        className="flex-1 px-2 py-1 min-h-0 overflow-hidden"
      >
        <div className="flex items-center gap-1.5">
          <ConnectorIcon type={task.connectorType} size={10} />
          <span className="text-xs font-medium text-purple-200 truncate">{task.title}</span>
        </div>
        {heightSlots >= 2 && (
          <div className="flex items-center gap-1 mt-0.5">
            <Clock size={8} className="text-purple-400" />
            <span className="text-[9px] tabular-nums text-purple-400">
              {task.scheduledTime} · {formatDuration(isResizing ? resizeDuration : duration)}
            </span>
          </div>
        )}
      </div>

      {/* Resize handle - bottom edge */}
      <div
        onMouseDown={handleResizeStart}
        className="flex h-[8px] min-h-[8px] touch-none items-center justify-center cursor-ns-resize opacity-0 transition-opacity group-hover/block:opacity-100 hover:bg-purple-500/20"
      >
        <Tooltip content="Drag to resize">
          <Minus size={10} className="text-purple-400" />
        </Tooltip>
      </div>

      {/* Real-time duration label while resizing */}
      {isResizing && (
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-purple-600 text-white text-xs px-2 py-0.5 rounded-md shadow-lg font-medium whitespace-nowrap z-30">
          {formatDuration(resizeDuration)}
        </div>
      )}

      {/* Unschedule button on hover */}
      <Tooltip content="Unschedule">
        <button
          onClick={(e) => { e.stopPropagation(); onUnschedule(task.taskId); }}
          className="absolute top-1 right-1 w-4 h-4 flex items-center justify-center rounded bg-red-900/60 text-red-300 text-[8px] opacity-0 group-hover/block:opacity-100 transition-opacity hover:bg-red-800/80"
        >
          <X size={8} />
        </button>
      </Tooltip>
    </div>
  );
}

// ─── Calendar Event Block ───────────────────────────────────────────────────

function CalendarEventBlock({ event }: { event: CalendarEvent }) {
  const slot = timeToSlot(event.startTime);
  const heightSlots = durationToSlots(event.duration);

  return (
    <div
      className="pointer-events-none absolute left-1 right-1 z-[5] overflow-hidden rounded-md border border-amber-800/30 bg-amber-900/20 px-2 py-1"
      style={{
        top: slot * SLOT_HEIGHT,
        height: Math.max(heightSlots * SLOT_HEIGHT - 2, SLOT_HEIGHT - 2),
      }}
    >
      <div className="flex items-center gap-1">
        <Calendar size={9} className="text-amber-400 shrink-0" />
        <span className="text-xs font-medium text-amber-200 truncate">{event.subject}</span>
      </div>
      {heightSlots >= 2 && (
        <span className="text-[9px] text-amber-500">
          {event.startTime}–{event.endTime}
        </span>
      )}
    </div>
  );
}

// ─── Unscheduled Drop Zone ──────────────────────────────────────────────────

function UnscheduledDropZone({
  items,
  isOver,
}: {
  items: MyDayItem[];
  isOver: boolean;
}) {
  const { setNodeRef } = useDroppable({
    id: 'unscheduled-zone',
    data: { type: 'unscheduled-zone' },
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-1.5 p-3 rounded-lg border-2 border-dashed transition-colors duration-200 min-h-[200px] ${
        isOver
          ? 'border-blue-500/60 bg-blue-900/10'
          : 'border-[var(--border)] bg-[var(--surface-0)]'
      }`}
    >
      <div className="text-xs text-[var(--text-muted)] uppercase font-semibold mb-1 flex items-center gap-1">
        <GripVertical size={10} /> Unscheduled — drag onto timeline
      </div>
      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-muted)]">
          All tasks scheduled!
        </div>
      ) : (
        items.map(item => (
          <DraggableUnscheduledTask key={item.taskId} item={item} />
        ))
      )}
      {isOver && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-xs text-blue-400 text-center py-2"
        >
          Drop here to unschedule
        </motion.div>
      )}
    </div>
  );
}

// ─── Ghost Preview Overlay ──────────────────────────────────────────────────

function DragGhostPreview({ item, task }: { item?: MyDayItem; task?: ScheduledTask }) {
  const title = item?.title || task?.title || '';
  const connector = item?.connectorType || task?.connectorType || '';

  return (
    <div className="px-3 py-2 rounded-md border border-purple-500/60 bg-purple-900/60 shadow-xl backdrop-blur-sm scale-[0.96] w-[200px] pointer-events-none">
      <div className="flex items-center gap-2">
        <ConnectorIcon type={connector} size={12} />
        <span className="text-xs text-purple-200 font-medium truncate">{title}</span>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface InteractiveTimelineProps {
  items: MyDayItem[];
  scheduled: ScheduledTask[];
  calendarEvents: CalendarEvent[];
  todayISO: string;
  onSchedule: (taskId: string, time: string, duration: number) => Promise<void>;
  onUnschedule: (taskId: string) => Promise<void>;
  onResize: (taskId: string, newDuration: number) => Promise<void>;
}

export function InteractiveTimeline({
  items,
  scheduled,
  calendarEvents,
  todayISO,
  onSchedule,
  onUnschedule,
  onResize,
}: InteractiveTimelineProps) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overSlot, setOverSlot] = useState<number | null>(null);
  const [overUnscheduled, setOverUnscheduled] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Separate unscheduled items (active tasks not on today's timeline)
  const scheduledTaskIds = new Set(
    scheduled
      .filter(s => s.status !== 'cancelled' && s.isTimeBlocked && s.scheduledTime)
      .map(s => s.taskId)
  );
  const unscheduledItems = items.filter(
    i => !isInactiveTaskStatus(i.status) && !scheduledTaskIds.has(i.taskId),
  );

  // Get dragged item data
  const activeData = activeId
    ? (String(activeId).startsWith('unscheduled-')
        ? { type: 'unscheduled' as const, item: unscheduledItems.find(i => `unscheduled-${i.taskId}` === activeId) }
        : String(activeId).startsWith('scheduled-')
          ? { type: 'scheduled' as const, task: scheduled.find(s => `scheduled-${s.taskId}` === activeId) }
          : null)
    : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id);
  }

  function handleDragOver(event: DragOverEvent) {
    const { over } = event;
    if (!over) {
      setOverSlot(null);
      setOverUnscheduled(false);
      return;
    }

    const overData = over.data.current;
    if (overData?.type === 'timeline-slot') {
      setOverSlot(overData.slotIndex as number);
      setOverUnscheduled(false);
    } else if (overData?.type === 'unscheduled-zone') {
      setOverSlot(null);
      setOverUnscheduled(true);
    } else {
      setOverSlot(null);
      setOverUnscheduled(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    setOverSlot(null);
    setOverUnscheduled(false);

    if (!over) return;

    const activeType = active.data.current?.type;
    const overData = over.data.current;

    // Drag unscheduled task → timeline slot
    if (activeType === 'unscheduled-task' && overData?.type === 'timeline-slot') {
      const item = active.data.current?.item as MyDayItem;
      const time = slotToTime(overData.slotIndex as number);
      await onSchedule(item.taskId, time, DEFAULT_DURATION);
      toast.success(`Scheduled "${item.title}" at ${time}`);
    }

    // Drag scheduled task → unscheduled zone
    if (activeType === 'scheduled-task' && overData?.type === 'unscheduled-zone') {
      const task = active.data.current?.task as ScheduledTask;
      await onUnschedule(task.taskId);
      toast.success(`Unscheduled "${task.title}"`);
    }

    // Drag scheduled task → different timeline slot (reschedule)
    if (activeType === 'scheduled-task' && overData?.type === 'timeline-slot') {
      const task = active.data.current?.task as ScheduledTask;
      const time = slotToTime(overData.slotIndex as number);
      await onSchedule(task.taskId, time, task.estimatedDuration || DEFAULT_DURATION);
      toast.success(`Moved "${task.title}" to ${time}`);
    }
  }

  async function handleResize(taskId: string, newDuration: number) {
    await onResize(taskId, newDuration);
  }

  async function handleUnschedule(taskId: string) {
    const task = scheduled.find(s => s.taskId === taskId);
    await onUnschedule(taskId);
    if (task) toast.success(`Unscheduled "${task.title}"`);
  }

  // Ghost preview size
  const ghostSlots = activeData?.type === 'scheduled'
    ? durationToSlots(activeData.task?.estimatedDuration || DEFAULT_DURATION)
    : durationToSlots(DEFAULT_DURATION);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 h-full min-h-0">
        {/* Left: Unscheduled tasks */}
        <div className="w-64 flex-shrink-0 overflow-y-auto">
          <UnscheduledDropZone items={unscheduledItems} isOver={overUnscheduled} />
        </div>

        {/* Right: Timeline grid */}
        <div className="flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <div
            ref={timelineRef}
            className="relative h-[916px]"
          >
            {/* Time labels + grid lines */}
            {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => {
              const hour = START_HOUR + i;
              return (
                <div key={hour}>
                  {/* Hour label */}
                  <div
                    className="absolute left-0 w-14 -translate-y-1/2 select-none pr-2 text-right text-xs tabular-nums text-[var(--text-muted)] pointer-events-none"
                    style={{ top: i * SLOTS_PER_HOUR * SLOT_HEIGHT }}
                  >
                    {formatTimeLabel(hour)}
                  </div>
                  {/* Hour line (solid) */}
                  <div
                    className="absolute left-14 right-0 border-t border-[var(--border-subtle)]"
                    style={{ top: i * SLOTS_PER_HOUR * SLOT_HEIGHT }}
                  />
                  {/* Half-hour line (dashed) */}
                  <div
                    className="absolute left-14 right-0 border-t border-dashed border-[var(--border-subtle)]/50"
                    style={{ top: (i * SLOTS_PER_HOUR + 2) * SLOT_HEIGHT }}
                  />
                </div>
              );
            })}

            {/* Droppable slots + content layer */}
            <div className="absolute left-14 right-0 top-0 bottom-0">
              {/* Drop slots */}
              {Array.from({ length: TOTAL_SLOTS }, (_, i) => (
                <TimelineDropSlot
                  key={i}
                  slotIndex={i}
                  isHighlighted={overSlot !== null && i >= overSlot && i < overSlot + ghostSlots}
                />
              ))}

              {/* Ghost preview on timeline during drag-over */}
              {overSlot !== null && activeData && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.15 }}
                  className={`pointer-events-none absolute left-1 right-1 z-[15] flex items-center justify-center rounded-md border-2 border-dashed ${
                    activeData.type === 'unscheduled'
                      ? 'border-purple-500/60 bg-purple-500/10'
                      : 'border-blue-500/60 bg-blue-500/10'
                  }`}
                  style={{
                    top: overSlot * SLOT_HEIGHT,
                    height: ghostSlots * SLOT_HEIGHT - 2,
                  }}
                >
                  <span className={`text-xs font-medium ${
                    activeData.type === 'unscheduled' ? 'text-purple-400' : 'text-blue-400'
                  }`}>
                    {slotToTime(overSlot)} · {formatDuration(
                      activeData.type === 'scheduled'
                        ? (activeData.task?.estimatedDuration || DEFAULT_DURATION)
                        : DEFAULT_DURATION
                    )}
                  </span>
                </motion.div>
              )}

              {/* Calendar events (non-interactive) */}
              {calendarEvents
                .filter(e => !e.isAllDay)
                .map(event => (
                  <CalendarEventBlock key={event.id} event={event} />
                ))}

              {/* Scheduled task blocks (with stacking layout) */}
              {(() => {
                const timeBlocked = scheduled.filter(
                  s => s.status !== 'cancelled' && s.isTimeBlocked && s.scheduledTime,
                );
                const layoutMap = computeStackedLayout(timeBlocked);
                return timeBlocked.map(task => {
                  const layout = layoutMap.get(task.taskId);
                  return (
                    <ScheduledBlock
                      key={task.taskId}
                      task={task}
                      onResize={handleResize}
                      onUnschedule={handleUnschedule}
                      column={layout?.column ?? 0}
                      totalColumns={layout?.totalColumns ?? 1}
                    />
                  );
                });
              })()}
            </div>

            {/* Current time indicator */}
            <CurrentTimeIndicator />
          </div>
        </div>
      </div>

      {/* Drag overlay (ghost that follows cursor) */}
      <DragOverlay dropAnimation={null}>
        {activeId && activeData ? (
          <DragGhostPreview
            item={activeData.type === 'unscheduled' ? activeData.item : undefined}
            task={activeData.type === 'scheduled' ? activeData.task : undefined}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// ─── Current Time Indicator ─────────────────────────────────────────────────

function CurrentTimeIndicator() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const hours = now.getHours();
  const minutes = now.getMinutes();

  if (hours < START_HOUR || hours >= END_HOUR) return null;

  const totalMinFromStart = (hours - START_HOUR) * 60 + minutes;
  const top = (totalMinFromStart / 15) * SLOT_HEIGHT;

  return (
    <div className="absolute left-14 right-0 pointer-events-none z-30" style={{ top }}>
      <div className="flex items-center">
        <div className="w-2 h-2 rounded-full bg-red-500 -ml-1" />
        <div className="flex-1 h-px bg-red-500/60" />
      </div>
    </div>
  );
}