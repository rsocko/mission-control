'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Maximize2, Minimize2, Search, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import {
  markerDiameter,
  markerDensityScale,
  priorityLabel,
  urgencyScore,
  type MatrixAxisMode,
  type MatrixColorMode,
  type MatrixSizeMode,
} from '@/lib/matrix/scales';
import {
  createMatrixMarks,
  projectTasks,
  type MatrixClusterMark,
  type ProjectedMatrixTask,
} from '@/lib/matrix/projection';
import { cn } from '@/lib/utils';
import { getLocalToday } from '@/lib/utils/client-date';
import { getTaskPriorityVisual, getTaskStatusVisual } from '@/lib/constants/task-formatting';
import type {
  DashboardProjectViewModel as HubProject,
  DashboardTaskViewModel as Task,
} from '@/types/dashboard';

interface MatrixScatterProps {
  tasks: Task[];
  projects: HubProject[];
  onSelectTask: (task: Task) => void;
  loading?: boolean;
}

const QUADRANTS: Record<MatrixAxisMode, [string, string, string, string]> = {
  'priority-urgency': ['Schedule', 'Do first', 'Eliminate', 'Delegate'],
  'priority-effort': ['Quick wins', 'Strategic', 'Fill work', 'Reconsider'],
};

const QUADRANT_COLORS: Record<MatrixAxisMode, Array<{ background: string; text: string }>> = {
  'priority-urgency': [
    { background: 'rgba(59, 130, 246, 0.07)', text: '#93c5fd' },
    { background: 'rgba(239, 68, 68, 0.07)', text: '#fca5a5' },
    { background: 'rgba(100, 116, 139, 0.04)', text: '#94a3b8' },
    { background: 'rgba(245, 158, 11, 0.06)', text: '#fcd34d' },
  ],
  'priority-effort': [
    { background: 'rgba(16, 185, 129, 0.07)', text: '#6ee7b7' },
    { background: 'rgba(139, 92, 246, 0.07)', text: '#c4b5fd' },
    { background: 'rgba(100, 116, 139, 0.04)', text: '#94a3b8' },
    { background: 'rgba(245, 158, 11, 0.06)', text: '#fcd34d' },
  ],
};

const PRIORITY_RANK: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function urgencyColor(urgency: number | null): string {
  if (urgency === null) return '#64748b';
  if (urgency >= 95) return '#ef4444';
  if (urgency >= 65) return '#f97316';
  if (urgency >= 50) return '#f59e0b';
  if (urgency >= 20) return '#3b82f6';
  return '#64748b';
}

function projectIds(task: Task): string[] {
  return [...new Set([
    ...(task.hubProjectIds ?? []),
    ...(task.projectPhaseMemberships ?? []).map((membership) => membership.projectId),
  ])].sort();
}

function projectColors(task: Task, projects: Map<string, HubProject>): string[] {
  const colors = projectIds(task)
    .map((id) => projects.get(id)?.color)
    .filter((color): color is string => Boolean(color));
  if (colors.length <= 4) return colors;
  return [...colors.slice(0, 3), '#64748b'];
}

function projectNames(task: Task, projects: Map<string, HubProject>): string[] {
  return projectIds(task)
    .map((id) => projects.get(id)?.name)
    .filter((name): name is string => Boolean(name));
}

function pieSlicePath(radius: number, start: number, end: number): string {
  const startPoint = {
    x: radius + radius * Math.cos(start),
    y: radius + radius * Math.sin(start),
  };
  const endPoint = {
    x: radius + radius * Math.cos(end),
    y: radius + radius * Math.sin(end),
  };
  return [
    `M ${radius} ${radius}`,
    `L ${startPoint.x} ${startPoint.y}`,
    `A ${radius} ${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${endPoint.x} ${endPoint.y}`,
    'Z',
  ].join(' ');
}

function taskColor(
  item: ProjectedMatrixTask,
  mode: MatrixColorMode,
  projects: Map<string, HubProject>,
): string {
  if (mode === 'urgency') return urgencyColor(item.urgency);
  if (mode === 'status') return item.task.status === 'waiting' ? '#f59e0b' : getTaskStatusVisual(item.task.status).color;
  if (mode === 'priority') return getTaskPriorityVisual(item.task.priority).color;
  return projectColors(item.task, projects)[0] ?? '#64748b';
}

function formatDueDate(item: ProjectedMatrixTask): string {
  if (item.urgencyState === 'invalid') return 'Invalid due date';
  if (item.urgencyState === 'none') return 'No due date';
  if (item.urgencyState === 'overdue') return `${Math.abs(item.daysUntilDue ?? 0)}d overdue`;
  if (item.urgencyState === 'today') return 'Due today';
  return `Due in ${item.daysUntilDue}d`;
}

function shortTaskTitle(title: string): string {
  return title.length > 24 ? `${title.slice(0, 23)}…` : title;
}

function Mark({
  item,
  x,
  y,
  sizeMode,
  colorMode,
  projects,
  densityScale,
  showLabel,
  labelOnLeft,
  onActivate,
  onHover,
}: {
  item: ProjectedMatrixTask;
  x: number;
  y: number;
  sizeMode: MatrixSizeMode;
  colorMode: MatrixColorMode;
  projects: Map<string, HubProject>;
  densityScale: number;
  showLabel: boolean;
  labelOnLeft: boolean;
  onActivate: () => void;
  onHover: (item: ProjectedMatrixTask | null) => void;
}) {
  const { diameter, missing } = markerDiameter(item.task, item.urgency, sizeMode);
  const missingEncoding = missing || (colorMode === 'urgency' && item.urgency === null);
  const radius = (diameter * densityScale) / 2;
  const colors = colorMode === 'project' ? projectColors(item.task, projects) : [];
  const names = projectNames(item.task, projects);
  const accessibleName = [
    item.task.title,
    `${priorityLabel(item.task.priority)} priority`,
    formatDueDate(item),
    `Effort ${item.task.effort ?? 'needs data'}`,
    `Smart Score ${item.task.smartScore ?? 'needs data'}`,
    `Status ${item.task.status.replaceAll('_', ' ')}`,
    names.length ? `Projects ${names.join(', ')}` : 'No project',
  ].join(', ');

  const activateFromKeyboard = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate();
    }
  };

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={accessibleName}
      transform={`translate(${x} ${y})`}
      className="cursor-pointer outline-none focus-visible:[&_circle:last-child]:stroke-[var(--accent-300)]"
      onClick={onActivate}
      onKeyDown={activateFromKeyboard}
      onMouseEnter={() => onHover(item)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(item)}
      onBlur={() => onHover(null)}
    >
      <circle r={Math.max(12, radius)} fill="transparent" />
      {colors.length > 1 ? (
        <g transform={`translate(${-radius} ${-radius})`}>
          {colors.map((color, index) => (
            <path
              key={`${color}-${index}`}
              d={pieSlicePath(
                radius,
                -Math.PI / 2 + (index / colors.length) * Math.PI * 2,
                -Math.PI / 2 + ((index + 1) / colors.length) * Math.PI * 2,
              )}
              fill={color}
            />
          ))}
        </g>
      ) : (
        <circle r={radius} fill={taskColor(item, colorMode, projects)} />
      )}
      {item.urgencyState === 'overdue' && (
        <circle r={radius + 2} fill="none" stroke="#ef4444" strokeWidth={1.5} />
      )}
      <circle
        r={radius}
        fill="none"
        stroke={missingEncoding ? '#f59e0b' : 'var(--surface-0)'}
        strokeWidth={missingEncoding ? 2 : 1}
        strokeDasharray={missingEncoding ? '2 2' : undefined}
      />
      {showLabel && (
        <text
          x={labelOnLeft ? -radius - 6 : radius + 6}
          y="1"
          textAnchor={labelOnLeft ? 'end' : 'start'}
          dominantBaseline="central"
          fill="var(--text-secondary)"
          fontSize="11"
          fontWeight="600"
          paintOrder="stroke"
          stroke="var(--surface-1)"
          strokeWidth="4"
          strokeLinejoin="round"
          style={{ pointerEvents: 'none' }}
        >
          {shortTaskTitle(item.task.title)}
        </text>
      )}
    </g>
  );
}

function TaskTable({
  tasks,
  today,
  projects,
  onSelectTask,
}: {
  tasks: Task[];
  today: string;
  projects: Map<string, HubProject>;
  onSelectTask: (task: Task) => void;
}) {
  type SortKey = 'title' | 'priority' | 'urgency' | 'dueDate' | 'effort' | 'smartScore' | 'project' | 'status';
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({
    key: 'smartScore',
    direction: 'desc',
  });
  const [page, setPage] = useState(0);
  const sortedTasks = useMemo(() => {
    const valueFor = (task: Task, key: SortKey): string | number => {
      if (key === 'title') return task.title.toLocaleLowerCase();
      if (key === 'priority') return PRIORITY_RANK[task.priority] ?? -1;
      if (key === 'urgency') return urgencyScore(task.dueDate, today).value ?? -1;
      if (key === 'dueDate') return task.dueDate ?? '9999-12-31';
      if (key === 'effort') return task.effort ?? -1;
      if (key === 'smartScore') return task.smartScore ?? -1;
      if (key === 'project') return projectNames(task, projects).join(', ').toLocaleLowerCase();
      return task.status.toLocaleLowerCase();
    };
    return [...tasks].sort((left, right) => {
      const leftValue = valueFor(left, sort.key);
      const rightValue = valueFor(right, sort.key);
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [projects, sort, tasks, today]);
  const headers: Array<{ key: SortKey; label: string }> = [
    { key: 'title', label: 'Task' },
    { key: 'priority', label: 'Priority' },
    { key: 'urgency', label: 'Urgency' },
    { key: 'dueDate', label: 'Due date' },
    { key: 'effort', label: 'Effort' },
    { key: 'smartScore', label: 'Smart score' },
    { key: 'project', label: 'Project' },
    { key: 'status', label: 'Status' },
  ];
  const pageCount = Math.max(1, Math.ceil(sortedTasks.length / 100));
  const currentPage = Math.min(page, pageCount - 1);
  const pageTasks = sortedTasks.slice(currentPage * 100, (currentPage + 1) * 100);

  const changeSort = (key: SortKey) => {
    setPage(0);
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  return (
    <div className="overflow-auto rounded-[var(--radius-lg)] border border-[var(--border)]">
      <table className="w-full min-w-[940px] text-left text-sm">
        <thead className="sticky top-0 bg-[var(--surface-2)] text-xs uppercase tracking-wide text-[var(--text-tertiary)]">
          <tr>
            {headers.map((header) => (
              <th key={header.key} className="px-3 py-2 font-medium" aria-sort={sort.key === header.key ? `${sort.direction}ending` : 'none'}>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
                  onClick={() => changeSort(header.key)}
                >
                  {header.label}
                  {sort.key === header.key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {pageTasks.map((task) => {
            const urgency = urgencyScore(task.dueDate, today).value;
            const names = projectNames(task, projects);
            return (
              <tr key={task.id} className="bg-[var(--surface-1)] hover:bg-[var(--surface-2)]">
                <td className="max-w-[360px] px-3 py-2 font-medium text-[var(--text-primary)]">
                  <button
                    type="button"
                    className="block max-w-[340px] truncate text-left hover:text-[var(--accent-300)]"
                    onClick={() => onSelectTask(task)}
                  >
                    {task.title}
                  </button>
                </td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">{priorityLabel(task.priority)}</td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">{urgency ?? 'Needs data'}</td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">{task.dueDate ?? 'No due date'}</td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">{task.effort ?? 'Needs data'}</td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">{task.smartScore ?? 'Needs data'}</td>
                <td className="max-w-40 truncate px-3 py-2 text-[var(--text-secondary)]">{names.join(', ') || 'No project'}</td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">{task.status.replaceAll('_', ' ')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div className="sticky bottom-0 flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-secondary)]">
          <span>
            {currentPage * 100 + 1}-{Math.min((currentPage + 1) * 100, sortedTasks.length)} of {sortedTasks.length}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MatrixScatter({
  tasks,
  projects,
  onSelectTask,
  loading = false,
}: MatrixScatterProps) {
  const {
    matrixAxisMode,
    matrixSizeMode,
    matrixColorMode,
    matrixMobileView,
    setMatrixAxisMode,
    setMatrixSizeMode,
    setMatrixColorMode,
    setMatrixMobileView,
  } = useDashboardViewStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 560 });
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<ProjectedMatrixTask | null>(null);
  const [cluster, setCluster] = useState<MatrixClusterMark | null>(null);
  const [inspectAllCluster, setInspectAllCluster] = useState<MatrixClusterMark | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [today, setToday] = useState(getLocalToday);
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const projection = useMemo(
    () => projectTasks(tasks, matrixAxisMode, today),
    [matrixAxisMode, tasks, today],
  );
  const marks = useMemo(
    () => createMatrixMarks(projection.tasks, dimensions.width, dimensions.height, zoom, matrixAxisMode),
    [dimensions, matrixAxisMode, projection.tasks, zoom],
  );
  const densityScale = useMemo(
    () => markerDensityScale(projection.tasks.length, dimensions.width, dimensions.height),
    [dimensions, projection.tasks.length],
  );
  const labeledTaskIds = useMemo(() => {
    if (projection.tasks.length === 0 || projection.tasks.length > 20) return new Set<string>();
    const taskMarks = marks.filter((mark) => mark.kind === 'task');
    const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    const labeled = new Set<string>();

    for (const mark of taskMarks) {
      const x = Math.max(14, Math.min(dimensions.width - 14, (mark.x / 100) * dimensions.width));
      const y = Math.max(14, Math.min(dimensions.height - 14, ((100 - mark.y) / 100) * dimensions.height));
      const titleWidth = shortTaskTitle(mark.item.task.title).length * 6.4;
      const markerRadius = 9 * densityScale;
      const labelOnLeft = x > dimensions.width - 180;
      const labelBounds = {
        left: labelOnLeft ? x - markerRadius - 6 - titleWidth : x + markerRadius + 6,
        right: labelOnLeft ? x - markerRadius - 6 : x + markerRadius + 6 + titleWidth,
        top: y - 8,
        bottom: y + 8,
      };
      const intersectsLabel = occupied.some((bounds) => (
        labelBounds.left < bounds.right
        && labelBounds.right > bounds.left
        && labelBounds.top < bounds.bottom
        && labelBounds.bottom > bounds.top
      ));
      const coversAnotherMark = taskMarks.some((other) => {
        if (other.item.task.id === mark.item.task.id) return false;
        const otherX = Math.max(14, Math.min(dimensions.width - 14, (other.x / 100) * dimensions.width));
        const otherY = Math.max(
          14,
          Math.min(dimensions.height - 14, ((100 - other.y) / 100) * dimensions.height),
        );
        return (
          otherX >= labelBounds.left - markerRadius
          && otherX <= labelBounds.right + markerRadius
          && otherY >= labelBounds.top - markerRadius
          && otherY <= labelBounds.bottom + markerRadius
        );
      });
      if (intersectsLabel || coversAnotherMark) continue;
      occupied.push(labelBounds);
      labeled.add(mark.item.task.id);
    }
    return labeled;
  }, [densityScale, dimensions, marks, projection.tasks.length]);
  const needsDataTasks = useMemo(
    () => [...new Map([
      ...projection.needsData.missingPriority,
      ...projection.needsData.missingEffort,
      ...projection.needsData.missingDueDate,
      ...projection.needsData.invalidDueDate,
    ].map((task) => [task.id, task])).values()],
    [projection.needsData],
  );
  const [upperLeft, upperRight, lowerLeft, lowerRight] = QUADRANTS[matrixAxisMode];
  const quadrantColors = QUADRANT_COLORS[matrixAxisMode];
  const xThreshold = matrixAxisMode === 'priority-effort' ? 62.5 : 50;
  const showTable = isMobile && matrixMobileView === 'table' && !fullscreen;

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let timer: number;
    const scheduleMidnightRefresh = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(() => {
        setToday(getLocalToday());
        scheduleMidnightRefresh();
      }, nextMidnight.getTime() - now.getTime() + 1_000);
    };
    scheduleMidnightRefresh();
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setDimensions({
        width: Math.max(320, Math.round(entry.contentRect.width)),
        height: Math.max(420, Math.round(entry.contentRect.height)),
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [showTable, fullscreen]);

  const handleCluster = (selectedCluster: MatrixClusterMark) => {
    setCluster(selectedCluster);
    setZoom((value) => Math.min(4, value + 1));
  };

  return (
    <section
      aria-label="Task priority matrix"
      className={cn(
        'space-y-3',
        fullscreen && 'fixed inset-0 z-50 overflow-auto bg-[var(--surface-0)] p-3',
      )}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-[var(--text-tertiary)]">
          <span className="block">Axes</span>
          <Select
            value={matrixAxisMode}
            onValueChange={(value) => {
              setMatrixAxisMode(value as MatrixAxisMode);
              setCluster(null);
            }}
          >
            <SelectTrigger aria-label="Axes" className="h-9 min-h-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="priority-urgency">Priority x Urgency</SelectItem>
              <SelectItem value="priority-effort">Priority x Effort</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-xs text-[var(--text-tertiary)]">
          <span className="block">Size</span>
          <Select
            value={matrixSizeMode}
            onValueChange={(value) => setMatrixSizeMode(value as MatrixSizeMode)}
          >
            <SelectTrigger aria-label="Size" className="h-9 min-h-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smart-score">Smart score</SelectItem>
              <SelectItem value="effort">Effort</SelectItem>
              <SelectItem value="urgency">Urgency</SelectItem>
              <SelectItem value="uniform">Uniform</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-xs text-[var(--text-tertiary)]">
          <span className="block">Color</span>
          <Select
            value={matrixColorMode}
            onValueChange={(value) => setMatrixColorMode(value as MatrixColorMode)}
          >
            <SelectTrigger aria-label="Color" className="h-9 min-h-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">Project</SelectItem>
              <SelectItem value="urgency">Urgency</SelectItem>
              <SelectItem value="status">Status</SelectItem>
              <SelectItem value="priority">Priority</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {!showTable && (
          <label className="ml-auto min-w-40 space-y-1 text-xs text-[var(--text-tertiary)]">
            <span className="flex justify-between"><span>Zoom</span><span>{zoom.toFixed(1)}x</span></span>
            <input
              aria-label="Matrix zoom"
              type="range"
              min="1"
              max="4"
              step="0.5"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="block w-full accent-[var(--accent-500)]"
            />
          </label>
        )}
        {isMobile && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMatrixMobileView(showTable ? 'matrix' : 'table')}
            >
              {showTable ? <Search /> : <Table2 />}
              {showTable ? 'Matrix' : 'Table'}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={fullscreen ? 'Exit full screen matrix' : 'Open full screen matrix'}
              onClick={() => setFullscreen((value) => !value)}
            >
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-tertiary)]">
        <span className="font-medium text-[var(--text-secondary)]">{projection.tasks.length} plotted</span>
        {projection.needsData.missingPriority.length > 0 && (
          <span>{projection.needsData.missingPriority.length} missing priority</span>
        )}
        {projection.needsData.missingEffort.length > 0 && (
          <span>{projection.needsData.missingEffort.length} missing effort</span>
        )}
        {projection.needsData.missingDueDate.length > 0 && (
          <span>{projection.needsData.missingDueDate.length} missing due date</span>
        )}
        {projection.needsData.invalidDueDate.length > 0 && (
          <span>{projection.needsData.invalidDueDate.length} invalid due date</span>
        )}
        {densityScale > 1.05 && (
          <span className="rounded-full bg-[var(--accent-500)]/10 px-2 py-0.5 text-[var(--accent-300)]">
            Expanded marks for this filter
          </span>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {projection.tasks.length} {projection.tasks.length === 1 ? 'task' : 'tasks'} plotted.{' '}
        {needsDataTasks.length} {needsDataTasks.length === 1 ? 'task has' : 'tasks have'} one or more data gaps.
      </p>

      {showTable ? (
        <TaskTable tasks={tasks} today={today} projects={projectMap} onSelectTask={onSelectTask} />
      ) : (
        <div className="flex min-w-0 gap-3">
          <div className="min-w-0 flex-1">
            <div
              ref={containerRef}
              className="relative h-[clamp(420px,62vh,720px)] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-strong)] bg-[var(--surface-1)]"
            >
              <div
                className="pointer-events-none absolute left-0 top-0"
                style={{
                  width: `${xThreshold}%`,
                  height: '37.5%',
                  background: quadrantColors[0].background,
                }}
              />
              <div
                className="pointer-events-none absolute right-0 top-0"
                style={{
                  width: `${100 - xThreshold}%`,
                  height: '37.5%',
                  background: quadrantColors[1].background,
                }}
              />
              <div
                className="pointer-events-none absolute bottom-0 left-0"
                style={{
                  width: `${xThreshold}%`,
                  height: '62.5%',
                  background: quadrantColors[2].background,
                }}
              />
              <div
                className="pointer-events-none absolute bottom-0 right-0"
                style={{
                  width: `${100 - xThreshold}%`,
                  height: '62.5%',
                  background: quadrantColors[3].background,
                }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 border-l border-dashed border-[var(--border-strong)]"
                style={{ left: `${xThreshold}%` }}
              />
              <div className="pointer-events-none absolute inset-x-0 top-[37.5%] border-t border-dashed border-[var(--border-strong)]" />
              {[
                [upperLeft, 'left-12 top-2', quadrantColors[0].text],
                [upperRight, 'right-3 top-2', quadrantColors[1].text],
                [lowerLeft, 'bottom-7 left-3', quadrantColors[2].text],
                [lowerRight, 'bottom-7 right-3', quadrantColors[3].text],
              ].map(([label, position, color]) => (
                <span
                  key={label}
                  className={`pointer-events-none absolute z-10 rounded-md bg-[var(--surface-0)]/80 px-2 py-1 text-xs font-semibold shadow-sm ${position}`}
                  style={{ color }}
                >
                  {label}
                </span>
              ))}
              <span className="absolute left-2 top-1/2 z-10 -translate-y-1/2 -rotate-90 text-[10px] uppercase tracking-widest text-[var(--text-tertiary)]">Priority</span>
              <span className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 text-[10px] uppercase tracking-widest text-[var(--text-tertiary)]">
                {matrixAxisMode === 'priority-effort' ? 'Effort' : 'Urgency'}
              </span>
              <svg
                role="group"
                aria-label={`${matrixAxisMode === 'priority-effort' ? 'Priority by effort' : 'Priority by urgency'} scatter plot`}
                viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
                className="absolute inset-0 h-full w-full overflow-visible"
              >
                {[25, 50, 75, 100].map((priority) => {
                  const y = ((100 - priority) / 100) * dimensions.height;
                  const label = priority === 100
                    ? 'Critical'
                    : priority === 75
                      ? 'High'
                      : priority === 50
                        ? 'Medium'
                        : 'Low';
                  return (
                    <g key={priority} aria-hidden="true">
                      <line
                        x1="0"
                        x2={dimensions.width}
                        y1={y}
                        y2={y}
                        stroke="var(--border)"
                        strokeWidth="1"
                        opacity="0.45"
                      />
                      <text
                        x="22"
                        y={Math.max(14, y - 5)}
                        fill="var(--text-tertiary)"
                        fontSize="10"
                      >
                        {label}
                      </text>
                    </g>
                  );
                })}
                {marks.map((mark) => {
                  const rawX = (mark.x / 100) * dimensions.width;
                  const rawY = ((100 - mark.y) / 100) * dimensions.height;
                  if (mark.kind === 'cluster') {
                    const radius = Math.min(28, 12 + Math.sqrt(mark.items.length) * 1.4);
                    const x = Math.max(radius + 2, Math.min(dimensions.width - radius - 2, rawX));
                    const y = Math.max(radius + 2, Math.min(dimensions.height - radius - 2, rawY));
                    return (
                      <g
                        key={`cluster-${mark.id}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${mark.items.length} tasks. Inspect cluster.`}
                        transform={`translate(${x} ${y})`}
                        className="cursor-pointer outline-none"
                        onClick={() => handleCluster(mark)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleCluster(mark);
                          }
                        }}
                      >
                        <circle r={radius + 1.1} fill="var(--accent-500)" opacity="0.18" />
                        <circle r={radius} fill="var(--accent-600)" stroke="var(--surface-0)" strokeWidth="0.5" />
                        <text
                          textAnchor="middle"
                          dominantBaseline="central"
                          fill="white"
                          fontSize={Math.max(11, radius * 0.85)}
                          fontWeight="700"
                          style={{ pointerEvents: 'none' }}
                        >
                          {mark.items.length}
                        </text>
                      </g>
                    );
                  }
                  const x = Math.max(14, Math.min(dimensions.width - 14, rawX));
                  const y = Math.max(14, Math.min(dimensions.height - 14, rawY));
                  return (
                    <Mark
                      key={mark.item.task.id}
                      item={mark.item}
                      x={x}
                      y={y}
                      sizeMode={matrixSizeMode}
                      colorMode={matrixColorMode}
                      projects={projectMap}
                      densityScale={densityScale}
                      showLabel={labeledTaskIds.has(mark.item.task.id)}
                      labelOnLeft={x > dimensions.width - 180}
                      onActivate={() => onSelectTask(mark.item.task)}
                      onHover={setHovered}
                    />
                  );
                })}
              </svg>
              {hovered && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute z-20 w-56 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-3)] p-2 text-xs shadow-[var(--shadow-lg)]"
                  style={{
                    left: `${Math.min(76, hovered.x + 2)}%`,
                    top: `${Math.min(82, Math.max(3, 100 - hovered.y))}%`,
                  }}
                >
                  <p className="truncate font-semibold text-[var(--text-primary)]">{hovered.task.title}</p>
                  <p className="mt-1 text-[var(--text-secondary)]">
                    {priorityLabel(hovered.task.priority)} · {formatDueDate(hovered)} · Effort {hovered.task.effort ?? '—'}
                  </p>
                  <p className="mt-1 truncate text-[var(--text-tertiary)]">
                    {projectNames(hovered.task, projectMap).join(', ') || 'No project'} · Score {hovered.task.smartScore ?? '—'} · {hovered.task.status.replaceAll('_', ' ')}
                  </p>
                </div>
              )}
              {loading && (
                <div className="absolute inset-0 grid place-items-center bg-[var(--surface-1)]/70 text-sm text-[var(--text-secondary)]">
                  Loading tasks...
                </div>
              )}
              {!loading && !projection.tasks.length && (
                <div className="absolute inset-0 grid place-items-center text-sm text-[var(--text-secondary)]">
                  No tasks have enough data for this view.
                </div>
              )}
            </div>
          </div>

          {cluster && (
            <aside className="fixed inset-x-3 bottom-3 z-40 max-h-[60vh] shrink-0 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-3 shadow-[var(--shadow-xl)] md:static md:z-auto md:block md:max-h-none md:w-72 md:shadow-none">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-[var(--text-primary)]">{cluster.items.length} tasks</p>
                  <p className="text-xs text-[var(--text-tertiary)]">
                    Top {Math.min(100, cluster.items.length)} by Smart Score
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setCluster(null)}>Close</Button>
              </div>
              <div className="mt-3 max-h-[calc(60vh-72px)] space-y-1 overflow-auto md:max-h-[480px]">
                {[...cluster.items]
                  .sort((a, b) => (b.task.smartScore ?? 0) - (a.task.smartScore ?? 0))
                  .slice(0, 100)
                  .map((item) => (
                    <button
                      key={item.task.id}
                      type="button"
                      className="block w-full rounded-[var(--radius-sm)] px-2 py-2 text-left hover:bg-[var(--surface-2)]"
                      onClick={() => onSelectTask(item.task)}
                    >
                      <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{item.task.title}</span>
                      <span className="text-xs text-[var(--text-tertiary)]">
                        Score {item.task.smartScore ?? '—'} · {formatDueDate(item)}
                      </span>
                    </button>
                  ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                onClick={() => setInspectAllCluster(cluster)}
              >
                Inspect all {cluster.items.length} tasks
              </Button>
            </aside>
          )}
        </div>
      )}

      <Dialog.Root
        open={inspectAllCluster !== null}
        onOpenChange={(open) => {
          if (!open) setInspectAllCluster(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-strong)] bg-[var(--surface-0)] p-4 shadow-[var(--shadow-xl)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <Dialog.Title className="font-semibold text-[var(--text-primary)]">
                  Cluster tasks
                </Dialog.Title>
                <Dialog.Description className="text-xs text-[var(--text-tertiary)]">
                  All {inspectAllCluster?.items.length ?? 0} tasks in the selected cluster.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button variant="outline" size="sm">Close</Button>
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {inspectAllCluster && (
                <TaskTable
                  key={inspectAllCluster.id}
                  tasks={inspectAllCluster.items.map((item) => item.task)}
                  today={today}
                  projects={projectMap}
                  onSelectTask={(task) => {
                    setInspectAllCluster(null);
                    onSelectTask(task);
                  }}
                />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {needsDataTasks.length > 0 && (
        <details className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)]">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-[var(--text-secondary)]">
            Needs data ({needsDataTasks.length})
          </summary>
          <div className="grid gap-3 border-t border-[var(--border)] p-3 md:grid-cols-3">
            {([
              ['Missing priority', projection.needsData.missingPriority],
              ['Missing effort', projection.needsData.missingEffort],
              ['Missing due date', projection.needsData.missingDueDate],
              ['Invalid due date', projection.needsData.invalidDueDate],
            ] satisfies Array<[string, Task[]]>).map(([label, groupTasks]) => {
              if (!groupTasks.length) return null;
              return (
                <div key={label} className="min-w-0">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                    {label} ({groupTasks.length})
                  </p>
                  {groupTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      className="block w-full truncate rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                      onClick={() => onSelectTask(task)}
                    >
                      {task.title}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </details>
      )}
    </section>
  );
}
