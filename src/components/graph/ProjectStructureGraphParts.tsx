'use client';

import {
  AlertTriangle,
  ChevronDown,
  Cloud,
  CloudOff,
  Link2,
  LoaderCircle,
  Trash2,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { GraphLayoutDirection } from '@/lib/graph/layout';
import type {
  ProjectGraphLineStyle,
  ProjectGraphNodeVisibility,
} from '@/lib/graph/project-structure-layout';
import type { GraphEdge, GraphNode, GraphNodeKind } from '@/lib/graph/types';
import styles from './ProjectStructureGraph.module.css';
import type { ProjectGraphLoadingStage } from './useProjectStructureGraphData';

const GRAPH_MENU_CLASS = 'z-[1100]';

export function GraphLoadingState({ stage }: { stage: ProjectGraphLoadingStage }) {
  const message = stage === 'fetching' ? 'Loading project data...' : 'Arranging project graph...';
  return (
    <div
      className="relative h-full min-h-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-0)]"
      aria-busy="true"
    >
      <div className="absolute inset-0 animate-pulse p-10 opacity-45 motion-reduce:animate-none" aria-hidden="true">
        <div className="mx-auto mt-14 h-16 w-44 rounded-xl bg-[var(--surface-2)]" />
        <div className="mx-auto mt-14 flex max-w-3xl justify-around gap-10">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="h-20 w-52 rounded-xl bg-[var(--surface-2)]" />
          ))}
        </div>
        <div className="mx-auto mt-14 flex max-w-4xl justify-around gap-6">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-16 w-36 rounded-xl bg-[var(--surface-1)]" />
          ))}
        </div>
      </div>
      <div className="absolute inset-x-0 top-1/2 mx-auto w-72 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)]/95 p-5 shadow-lg">
        <div className="flex items-center gap-3 text-sm font-medium text-[var(--text-primary)]">
          <LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent-400)] motion-reduce:animate-none" aria-hidden="true" />
          <span role="status">{message}</span>
        </div>
        <div
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]"
          role="progressbar"
          aria-label="Project graph loading progress"
        >
          <div className={cn(styles.loadingProgress, 'h-full w-2/5 rounded-full bg-[var(--accent-400)]')} />
        </div>
      </div>
    </div>
  );
}

interface ProjectGraphDisplayControlsProps {
  direction: GraphLayoutDirection;
  lineStyle: ProjectGraphLineStyle;
  showDependencies: boolean;
  visibleKinds: ProjectGraphNodeVisibility;
  onDirectionChange: (direction: GraphLayoutDirection) => void;
  onLineStyleChange: (lineStyle: ProjectGraphLineStyle) => void;
  onToggleDependencies: () => void;
  onToggleNodeKind: (kind: GraphNodeKind) => void;
}

export function ProjectGraphDisplayControls({
  direction,
  lineStyle,
  showDependencies,
  visibleKinds,
  onDirectionChange,
  onLineStyleChange,
  onToggleDependencies,
  onToggleNodeKind,
}: ProjectGraphDisplayControlsProps) {
  return (
    <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]/95 p-1.5 shadow-[var(--shadow-md)]">
      <span
        className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-secondary)]"
        title="Dragging a node only adjusts this temporary graph layout. Reorder phases and tasks in Plan list or assign view."
      >
        Node drag: layout only
      </span>
      <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />
      <label htmlFor="graph-layout-direction" className="sr-only">Graph layout direction</label>
      <Select value={direction} onValueChange={(value) => onDirectionChange(value as GraphLayoutDirection)}>
        <SelectTrigger id="graph-layout-direction" variant="inline" className="h-7 min-w-24 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]" title="Graph layout direction">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={GRAPH_MENU_CLASS}>
          <SelectItem value="horizontal">Horizontal</SelectItem>
          <SelectItem value="vertical">Vertical</SelectItem>
        </SelectContent>
      </Select>
      <label htmlFor="graph-line-style" className="sr-only">Connection line style</label>
      <Select value={lineStyle} onValueChange={(value) => onLineStyleChange(value as ProjectGraphLineStyle)}>
        <SelectTrigger id="graph-line-style" variant="inline" className="h-7 min-w-28 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]" title="Connection line style">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={GRAPH_MENU_CLASS}>
          <SelectItem value="orthogonal">Elbow lines</SelectItem>
          <SelectItem value="curved">Curved lines</SelectItem>
        </SelectContent>
      </Select>
      <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />
      <button
        type="button"
        aria-pressed={showDependencies}
        onClick={onToggleDependencies}
        className={cn(
          'h-7 rounded-md border px-2 text-xs font-medium transition-colors',
          showDependencies
            ? 'border-[var(--accent-400)]/60 bg-[var(--accent-500)]/15 text-[var(--accent-300)]'
            : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-tertiary)]',
        )}
        title="Show or hide blocking and related-task lines"
      >
        Dependencies
      </button>
      {(['project', 'phase', 'task'] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={visibleKinds[kind]}
          onClick={() => onToggleNodeKind(kind)}
          className={cn(
            'h-7 rounded-md border px-2 text-xs font-medium capitalize transition-colors',
            visibleKinds[kind]
              ? 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-primary)]'
              : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through',
          )}
          title={`${visibleKinds[kind] ? 'Hide' : 'Show'} ${kind} nodes`}
        >
          {kind}
        </button>
      ))}
    </div>
  );
}

interface ProjectGraphDependencyCreatorProps {
  open: boolean;
  type: 'blocks' | 'related';
  direction: GraphLayoutDirection;
  sourceId: string;
  targetId: string;
  tasks: Array<{ id: string; label: string }>;
  onOpenChange: (open: boolean) => void;
  onTypeChange: (type: 'blocks' | 'related') => void;
  onSourceChange: (id: string) => void;
  onTargetChange: (id: string) => void;
  onCreate: () => void;
}

export function ProjectGraphDependencyCreator({
  open,
  type,
  direction,
  sourceId,
  targetId,
  tasks,
  onOpenChange,
  onTypeChange,
  onSourceChange,
  onTargetChange,
  onCreate,
}: ProjectGraphDependencyCreatorProps) {
  return (
    <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]/95 p-1.5 shadow-[var(--shadow-md)]">
      <button type="button" aria-expanded={open} aria-controls="graph-dependency-creator" onClick={() => onOpenChange(!open)} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]">
        <Link2 size={12} />
        {open ? 'Hide dependency controls' : 'Add dependency'}
        <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {!open ? <span className="pr-1 text-xs text-[var(--text-tertiary)]">Select a dependency line to manage it.</span> : null}
      {open ? (
        <div id="graph-dependency-creator" className="flex max-w-full flex-wrap items-center gap-2">
          <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />
          <label htmlFor="graph-dependency-type" className="pl-1 text-xs text-[var(--text-secondary)]">Connect as</label>
          <Select value={type} onValueChange={(value) => onTypeChange(value as 'blocks' | 'related')}>
            <SelectTrigger id="graph-dependency-type" variant="inline" className="h-7 min-w-20 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]"><SelectValue /></SelectTrigger>
            <SelectContent className={GRAPH_MENU_CLASS}>
              <SelectItem value="blocks">Blocks</SelectItem>
              <SelectItem value="related">Related</SelectItem>
            </SelectContent>
          </Select>
          <label htmlFor="graph-source-task" className="sr-only">Dependency source task</label>
          <Select value={sourceId} onValueChange={onSourceChange}>
            <SelectTrigger id="graph-source-task" variant="inline" className="h-7 w-40 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]"><SelectValue placeholder="From task…" /></SelectTrigger>
            <SelectContent className={GRAPH_MENU_CLASS}>
              {tasks.map((task) => <SelectItem key={task.id} value={task.id}>{task.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <label htmlFor="graph-target-task" className="sr-only">Dependency target task</label>
          <Select value={targetId} onValueChange={onTargetChange}>
            <SelectTrigger id="graph-target-task" variant="inline" className="h-7 w-40 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]"><SelectValue placeholder="To task…" /></SelectTrigger>
            <SelectContent className={GRAPH_MENU_CLASS}>
              {tasks.map((task) => <SelectItem key={task.id} value={task.id}>{task.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <button type="button" disabled={!sourceId || !targetId || sourceId === targetId} onClick={onCreate} className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--accent-600)] px-2 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:pointer-events-none disabled:opacity-40">
            <Link2 size={12} /> Connect
          </button>
          <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />
          <span className="px-1 text-xs text-[var(--text-secondary)]">
            {type === 'blocks'
              ? direction === 'horizontal' ? "Drag from the predecessor's right handle to the successor's left handle." : "Drag from the predecessor's bottom handle to the successor's top handle."
              : direction === 'horizontal' ? "Drag a right handle to another task's left handle." : "Drag a bottom handle to another task's top handle."}
            {' '}Select a dependency line to manage it.
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function ProjectGraphPhaseDetails({
  phase,
  statusLabel,
  onClose,
}: {
  phase: GraphNode;
  statusLabel: string;
  onClose: () => void;
}) {
  return (
    <aside className="pointer-events-auto relative ml-auto w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-lg)]">
      <button type="button" onClick={onClose} className="absolute right-2 top-2 rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]" aria-label="Close phase details"><X size={14} /></button>
      <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-tertiary)]">Phase</p>
      <h3 className="mt-1 pr-7 text-base font-semibold text-[var(--text-primary)]">{phase.label}</h3>
      {phase.description ? <p className="mt-2 text-sm text-[var(--text-secondary)]">{phase.description}</p> : null}
      <p className="mt-3 text-xs text-[var(--text-tertiary)]">{phase.taskCount ?? 0} task{phase.taskCount === 1 ? '' : 's'} · {statusLabel}</p>
    </aside>
  );
}

interface SelectedDependency {
  edge: {
    id: string;
    data?: {
      syncStatus?: GraphEdge['syncStatus'];
      syncError?: string | null;
    };
  };
  source: GraphNode;
  target: GraphNode;
  type: 'blocks' | 'related';
}

export function ProjectGraphDependencyDetails({
  dependency,
  removing,
  onClose,
  onRemove,
}: {
  dependency: SelectedDependency;
  removing: boolean;
  onClose: () => void;
  onRemove: () => void;
}) {
  const syncLabels = { local: 'Local only', pending: 'Sync pending', synced: 'Synced with source', failed: 'Source sync failed' } as const;
  const status = dependency.edge.data?.syncStatus ?? 'local';
  return (
    <aside className="pointer-events-auto relative ml-auto w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-lg)]">
      <button type="button" onClick={onClose} className="absolute right-2 top-2 rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]" aria-label="Close dependency details"><X size={14} /></button>
      <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-tertiary)]">Dependency</p>
      <h3 className="mt-1 pr-7 text-base font-semibold text-[var(--text-primary)]">{dependency.type === 'blocks' ? 'Blocks' : 'Related tasks'}</h3>
      <dl className="mt-3 space-y-3 text-sm">
        <div><dt className="text-xs text-[var(--text-tertiary)]">{dependency.type === 'blocks' ? `Blocking ${dependency.source.kind}` : dependency.source.kind === 'phase' ? 'Phase' : 'Task'}</dt><dd className="mt-0.5 text-[var(--text-primary)]">{dependency.source.label}</dd></div>
        <div><dt className="text-xs text-[var(--text-tertiary)]">{dependency.type === 'blocks' ? `Blocked ${dependency.target.kind}` : 'Related to'}</dt><dd className="mt-0.5 text-[var(--text-primary)]">{dependency.target.label}</dd></div>
      </dl>
      <div className="mt-3 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        {status === 'synced' ? <Cloud size={15} /> : null}
        {status === 'local' ? <CloudOff size={15} /> : null}
        {status === 'pending' ? <LoaderCircle size={15} className="animate-spin" /> : null}
        {status === 'failed' ? <AlertTriangle size={15} className="text-[var(--danger)]" /> : null}
        {syncLabels[status]}
      </div>
      {dependency.edge.data?.syncError ? <p className="mt-2 text-xs text-[var(--danger)]">{dependency.edge.data.syncError}</p> : null}
      <button type="button" disabled={removing} onClick={onRemove} className="mt-4 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-red-500/40 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:pointer-events-none disabled:opacity-50"><Trash2 size={13} />Remove dependency</button>
    </aside>
  );
}

export function ProjectGraphRemovalDialog({
  open,
  targetKind,
  removing,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  targetKind?: GraphNodeKind;
  removing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      title="Remove dependency?"
      message={targetKind === 'phase' ? 'This disconnects the phases but does not delete either phase.' : 'This disconnects the tasks but does not delete either task.'}
      confirmLabel={removing ? 'Removing…' : 'Remove dependency'}
      confirmVariant="danger"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
