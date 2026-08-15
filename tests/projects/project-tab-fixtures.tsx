/**
 * Shared fixtures for the Project detail page tab characterization suites.
 *
 * The harness serves realistic, endpoint-aware responses (including a working
 * project hierarchy transport) so tab tests can assert rendered outcomes and
 * real request payloads instead of component internals.
 */
import React from 'react';
import { act, configure, render, screen, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  PhaseItem,
  ProjectPhase,
  ProjectRecord,
  ProjectRuleMatch,
  ProjectTask,
} from '@/app/projects/[id]/types';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchySnapshot,
} from '@/lib/projects/hierarchy-types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

export const PROJECT_ID = 'project-1';
const BASE_TIME = '2026-08-01T00:00:00.000Z';

// ─── Data builders ────────────────────────────────────────────────────

export function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: PROJECT_ID,
    name: 'Test Project',
    description: null,
    color: '#3b82f6',
    icon: null,
    iconColor: null,
    sourceBindings: [],
    autoIncludeRules: [],
    kanbanColumns: [],
    defaultView: 'list',
    status: 'active',
    statusOverride: null,
    category: null,
    targetDate: null,
    startedAt: null,
    completedAt: null,
    sortOrder: 0,
    metadata: {},
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

export function makePhase(
  id: string,
  overrides: Partial<ProjectPhase> = {},
): ProjectPhase {
  return {
    id,
    projectId: PROJECT_ID,
    name: id,
    description: null,
    status: 'pending',
    color: null,
    estimatedDays: null,
    targetStart: null,
    targetEnd: null,
    startAfterPhaseId: null,
    sortOrder: 0,
    completedAt: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

export function makePhaseItem(
  phaseId: string,
  taskId: string,
  sortOrder = 0,
  overrides: Partial<PhaseItem> = {},
): PhaseItem {
  return {
    id: `item-${phaseId}-${taskId}`,
    phaseId,
    taskId,
    sortOrder,
    estimatedEffortHours: null,
    isProposed: false,
    proposalType: null,
    createdAt: BASE_TIME,
    ...overrides,
  };
}

export function makeTask(id: string, overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id,
    title: id,
    status: 'todo',
    priority: 'medium',
    dueDate: null,
    updatedAt: '2026-08-14T12:00:00.000Z',
    connectorType: 'local',
    connectorInstanceId: 'local',
    sourceListId: null,
    sourceListName: null,
    tags: [],
    hubProjectIds: [PROJECT_ID],
    projectPhaseMemberships: [],
    localDisposition: 'active',
    taskSourceModel: 'mc-owned',
    editPolicy: editableTaskPolicy,
    ...overrides,
  };
}

export function makeRuleMatch(
  taskId: string,
  overrides: Partial<ProjectRuleMatch> = {},
): ProjectRuleMatch {
  return {
    taskId,
    title: `Match ${taskId}`,
    status: 'todo',
    alreadyAssigned: false,
    excluded: false,
    excludedAt: null,
    reasons: ['tag: design'],
    ...overrides,
  };
}

export interface TaskDestinationFixture {
  id: string;
  type: string;
  name: string;
  account?: 'personal' | 'work';
  listSelectionMode?: 'required' | 'optional' | 'not-applicable';
}

export interface ProjectPageScenario {
  project?: Partial<ProjectRecord>;
  /** Serves a project payload without a project, exercising the not-found shell. */
  missingProject?: boolean;
  phases?: ProjectPhase[];
  phaseItems?: Record<string, PhaseItem[]>;
  tasks?: ProjectTask[];
  ruleMatches?: ProjectRuleMatch[];
  categories?: string[];
  taskDestinations?: TaskDestinationFixture[];
  allProjects?: Array<Record<string, unknown>>;
  revision?: number;
  collapsedPhaseIds?: string[];
}

// ─── Mutable fixture state shared with the mock modules ───────────────

export const navigationState = {
  projectId: PROJECT_ID,
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
};

export const overlayState = {
  /** Task id the mocked burn report / graph reports as selected. */
  reportTaskId: 'task-alpha',
  /** Task id the mocked AddTaskModal reports as created. */
  createdTaskId: 'task-new',
  /** Task ids the mocked TaskPickerDialog confirms. */
  pickedTaskIds: ['task-linked'] as string[],
  /** Phase id the mocked structure graph reports a removed dependency for. */
  graphDependencyPhaseId: '',
};

export const toasts: Array<{ level: string; message: unknown }> = [];

export const dndCapture: {
  onDragStart?: (event: unknown) => void;
  onDragEnd?: (event: unknown) => void | Promise<void>;
} = {};
export const graphRender = vi.fn();

// ─── Mock module factories ────────────────────────────────────────────
// Used as `vi.mock('x', async () => (await import('./project-tab-fixtures')).xModule())`

const MOTION_PROPS = new Set([
  'animate', 'custom', 'drag', 'exit', 'initial', 'layout', 'layoutId',
  'transition', 'variants', 'whileDrag', 'whileFocus', 'whileHover',
  'whileInView', 'whileTap',
]);

function stripMotionProps(props: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(props).filter(([key]) => !MOTION_PROPS.has(key)),
  );
}

export function motionReactModule() {
  const cache = new Map<string, React.ElementType>();
  const motion = new Proxy({} as Record<string, React.ElementType>, {
    get(_target, tag: string) {
      if (!cache.has(tag)) {
        const Component = React.forwardRef<HTMLElement, Record<string, unknown>>(
          (props, ref) => React.createElement(tag, { ref, ...stripMotionProps(props) }),
        );
        Component.displayName = `motion.${tag}`;
        cache.set(tag, Component as unknown as React.ElementType);
      }
      return cache.get(tag);
    },
  });

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion,
    useReducedMotion: () => false,
  };
}

function flattenText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (React.isValidElement(node)) {
    return flattenText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * Deterministic stand-in for the Radix select primitives: the trigger is a real
 * combobox, options only join the accessibility tree while the select is open,
 * and choosing an option calls the same `onValueChange` contract.
 */
export function uiSelectModule() {
  interface SelectContextValue {
    value: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    open: boolean;
    setOpen: (open: boolean) => void;
    listboxId: string;
    labels: Map<string, string>;
    register: (value: string, label: string) => void;
  }
  const SelectContext = React.createContext<SelectContextValue | null>(null);

  function Select({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) {
    const listboxId = React.useId();
    const [open, setOpen] = React.useState(false);
    const [labels, setLabels] = React.useState(() => new Map<string, string>());
    const register = React.useCallback((itemValue: string, label: string) => {
      setLabels((current) => (
        current.get(itemValue) === label
          ? current
          : new Map(current).set(itemValue, label)
      ));
    }, []);
    const contextValue = React.useMemo<SelectContextValue>(() => ({
      value,
      onValueChange,
      disabled,
      open,
      setOpen,
      listboxId,
      labels,
      register,
    }), [disabled, labels, listboxId, onValueChange, open, register, value]);

    return (
      <SelectContext.Provider value={contextValue}>{children}</SelectContext.Provider>
    );
  }

  function SelectTrigger({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    const select = React.useContext(SelectContext);
    return (
      <button
        type="button"
        role="combobox"
        aria-controls={select?.listboxId}
        aria-expanded={Boolean(select?.open)}
        disabled={select?.disabled}
        {...props}
        onClick={() => select?.setOpen(!select.open)}
      >
        {children}
      </button>
    );
  }

  function SelectValue() {
    const select = React.useContext(SelectContext);
    const value = select?.value ?? '';
    return <span>{select?.labels.get(value) ?? value}</span>;
  }

  function SelectContent({ children }: { children: React.ReactNode }) {
    const select = React.useContext(SelectContext);
    return (
      <div id={select?.listboxId} role="listbox" hidden={!select?.open}>
        {children}
      </div>
    );
  }

  function SelectItem({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) {
    const select = React.useContext(SelectContext);
    const label = flattenText(children);
    React.useEffect(() => {
      select?.register(value, label);
    }, [label, select, value]);

    return (
      <button
        type="button"
        role="option"
        aria-selected={select?.value === value}
        onClick={() => {
          select?.setOpen(false);
          select?.onValueChange?.(value);
        }}
      >
        {children}
      </button>
    );
  }

  return {
    Select,
    SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
    SelectLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    SelectSeparator: () => <hr />,
  };
}

export function nextNavigationModule() {
  return {
    useParams: () => ({ id: navigationState.projectId }),
    useRouter: () => ({
      push: navigationState.push,
      replace: navigationState.replace,
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(navigationState.search),
    usePathname: () => `/projects/${navigationState.projectId}`,
    redirect: vi.fn(),
    notFound: vi.fn(),
  };
}

export function sonnerModule() {
  const record = (level: string) => (message: unknown) => {
    toasts.push({ level, message });
  };
  const toast = Object.assign(record('message'), {
    success: record('success'),
    error: record('error'),
    warning: record('warning'),
    info: record('info'),
    dismiss: vi.fn(),
    custom: record('custom'),
  });
  return { toast, Toaster: () => null };
}

export function syncStreamModule() {
  return { useSyncStream: () => ({ progress: { refetchKey: 0 } }) };
}

export function quickAddContextModule() {
  return {
    useQuickAddContext: () => ({
      setQuickAddFilter: vi.fn(),
      clearQuickAddFilter: vi.fn(),
    }),
  };
}

export function taskDetailPanelModule() {
  return {
    TaskDetailPanel: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
      <aside aria-label="Task detail" data-testid={`task-detail-${taskId}`}>
        <p>Detail for {taskId}</p>
        <button type="button" onClick={onClose}>Close task detail</button>
      </aside>
    ),
  };
}

export function burnReportCardModule() {
  return {
    BurnReportCard: ({
      phaseId,
      scopeName,
      refreshKey,
      onTaskSelect,
    }: {
      phaseId?: string;
      scopeName?: string;
      refreshKey?: string | number;
      onTaskSelect?: (taskId: string) => void;
    }) => (
      <section
        aria-label={phaseId ? `${scopeName} progress report` : 'Progress reports'}
        data-refresh-key={String(refreshKey ?? '')}
      >
        <button type="button" onClick={() => onTaskSelect?.(overlayState.reportTaskId)}>
          {phaseId ? `Open ${scopeName} report task` : 'Open reported task'}
        </button>
      </section>
    ),
  };
}

export function projectStructureGraphModule() {
  return {
    default: ({
      onTaskSelect,
      onPhaseDependencyRemoved,
    }: {
      onTaskSelect?: (taskId: string | null) => void;
      onPhaseDependencyRemoved?: (phaseId: string) => void;
    }) => {
      graphRender();
      return (
        <div data-testid="project-structure-graph">
          <button type="button" onClick={() => onTaskSelect?.(overlayState.reportTaskId)}>
            Select graph task
          </button>
          <button
            type="button"
            onClick={() => onPhaseDependencyRemoved?.(overlayState.graphDependencyPhaseId)}
          >
            Remove graph dependency
          </button>
        </div>
      );
    },
  };
}

export function addTaskModalModule() {
  return {
    AddTaskModal: ({
      destinations,
      initialProjectId,
      onTaskCreated,
      onClose,
      onSubmit,
    }: {
      destinations?: Array<{ id: string; label: string }>;
      initialProjectId?: string;
      onTaskCreated: (taskId: string) => void;
      onClose: () => void;
      onSubmit?: () => void;
    }) => (
      <div role="dialog" aria-label="Create task">
        <p>Creating in {initialProjectId}</p>
        <p>Destinations: {(destinations ?? []).map((destination) => destination.label).join(', ')}</p>
        <button
          type="button"
          onClick={() => {
            onTaskCreated(overlayState.createdTaskId);
            onSubmit?.();
          }}
        >
          Confirm new task
        </button>
        <button type="button" onClick={onClose}>Cancel new task</button>
      </div>
    ),
  };
}

export function taskPickerDialogModule() {
  return {
    TaskPickerDialog: ({
      title,
      onConfirm,
      onClose,
    }: {
      title?: string;
      onConfirm: (taskIds: string[]) => void;
      onClose: () => void;
    }) => (
      <div role="dialog" aria-label={title ?? 'Add existing tasks'}>
        <button type="button" onClick={() => onConfirm([...overlayState.pickedTaskIds])}>
          Confirm linked tasks
        </button>
        <button type="button" onClick={onClose}>Cancel linked tasks</button>
      </div>
    ),
  };
}

export function phaseProposalReviewModule() {
  return {
    default: ({
      proposal,
      isOpen,
      onAccept,
      onReject,
    }: {
      proposal: { overallReasoning: string };
      isOpen: boolean;
      onAccept: () => void;
      onReject: () => void;
    }) => (isOpen ? (
      <div role="dialog" aria-label="Phase proposal">
        <p>{proposal.overallReasoning}</p>
        <button type="button" onClick={onAccept}>Accept proposal</button>
        <button type="button" onClick={onReject}>Dismiss proposal</button>
      </div>
    ) : null),
  };
}

/** Keeps real dnd-kit behavior while exposing the page drag handlers to tests. */
export async function dndKitCoreModule() {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');
  const DndContext = ({
    children,
    onDragStart,
    onDragEnd,
    ...rest
  }: React.ComponentProps<typeof actual.DndContext>) => {
    dndCapture.onDragStart = onDragStart as typeof dndCapture.onDragStart;
    dndCapture.onDragEnd = onDragEnd as typeof dndCapture.onDragEnd;
    return (
      <actual.DndContext onDragStart={onDragStart} onDragEnd={onDragEnd} {...rest}>
        {children}
      </actual.DndContext>
    );
  };
  return { ...actual, DndContext };
}

export async function fireDragEnd(input: {
  activeId: string;
  activeType: 'task' | 'phase';
  overId: string;
  overType?: string;
}) {
  const event = {
    active: { id: input.activeId, data: { current: { type: input.activeType } } },
    over: {
      id: input.overId,
      data: { current: input.overType ? { type: input.overType } : {} },
    },
  };
  await act(async () => {
    dndCapture.onDragStart?.({ active: event.active });
    await dndCapture.onDragEnd?.(event);
  });
}

// ─── Endpoint-aware harness ───────────────────────────────────────────

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

interface FailureRule {
  pattern: RegExp;
  method?: string;
  status: number;
  error: string;
  once: boolean;
  used?: boolean;
}

export interface ProjectPageHarness {
  requests: RecordedRequest[];
  requestsFor(pattern: RegExp | string, method?: string): RecordedRequest[];
  hierarchyCommands(): ProjectHierarchyCommand[];
  /** Authoritative hierarchy the fake transport currently serves. */
  hierarchy(): ProjectHierarchySnapshot;
  failOnce(pattern: RegExp | string, options?: { status?: number; error?: string; method?: string }): void;
  fail(pattern: RegExp | string, options?: { status?: number; error?: string; method?: string }): void;
  /** Holds every matching request until the returned release function runs. */
  hold(pattern: RegExp | string): () => void;
  /** Forces the next hierarchy command to answer with a revision conflict. */
  conflictNextCommand(): void;
}

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { height: 72 } as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}
  unobserve() {}
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toPattern(pattern: RegExp | string) {
  return pattern instanceof RegExp
    ? pattern
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export function installProjectPageHarness(
  scenario: ProjectPageScenario = {},
): ProjectPageHarness {
  const project = makeProject({ id: PROJECT_ID, ...scenario.project });
  const phases = [...(scenario.phases ?? [])];
  const phaseItemsByPhase: Record<string, PhaseItem[]> = Object.fromEntries(
    phases.map((phase) => [phase.id, [...(scenario.phaseItems?.[phase.id] ?? [])]]),
  );
  const tasks = [...(scenario.tasks ?? [])];
  const ruleMatches = [...(scenario.ruleMatches ?? [])];
  let revision = scenario.revision ?? 1;
  let conflictNext = false;
  const failures: FailureRule[] = [];
  const holds: Array<{ pattern: RegExp; promise: Promise<void>; release: () => void }> = [];
  const requests: RecordedRequest[] = [];
  const commands: ProjectHierarchyCommand[] = [];

  navigationState.projectId = PROJECT_ID;
  navigationState.search = '';
  navigationState.push.mockReset();
  navigationState.replace.mockReset();
  toasts.length = 0;
  delete dndCapture.onDragStart;
  delete dndCapture.onDragEnd;
  // The whole page (provider, tabs, overlays) settles asynchronously, so give
  // findBy/waitFor room on cold workers without per-assertion timeouts.
  configure({ asyncUtilTimeout: 5000 });

  localStorage.clear();
  if (scenario.collapsedPhaseIds) {
    localStorage.setItem(
      `project-phases-collapsed:${PROJECT_ID}`,
      JSON.stringify(scenario.collapsedPhaseIds),
    );
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    height: 72,
  } as DOMRect);

  function snapshot(): ProjectHierarchySnapshot {
    return {
      projectId: PROJECT_ID,
      revision,
      phases: phases.map((phase) => ({ ...phase })),
      phaseItemsByPhase: Object.fromEntries(
        phases.map((phase) => [
          phase.id,
          (phaseItemsByPhase[phase.id] ?? []).map((item, index) => ({
            ...item,
            sortOrder: index,
          })),
        ]),
      ),
    } as unknown as ProjectHierarchySnapshot;
  }

  function currentPlacements() {
    return tasks.map((task) => {
      for (const phase of phases) {
        const index = (phaseItemsByPhase[phase.id] ?? [])
          .findIndex((item) => item.taskId === task.id);
        if (index >= 0) {
          return { taskId: task.id, phaseId: phase.id, index };
        }
      }
      return { taskId: task.id, phaseId: null, index: 0 };
    });
  }

  function detachTasks(taskIds: string[]) {
    for (const phaseId of Object.keys(phaseItemsByPhase)) {
      phaseItemsByPhase[phaseId] = phaseItemsByPhase[phaseId]
        .filter((item) => !taskIds.includes(item.taskId));
    }
  }

  function attachTasks(taskIds: string[], phaseId: string, index: number) {
    const items = phaseItemsByPhase[phaseId] ?? [];
    const inserted = taskIds.map((taskId) => makePhaseItem(phaseId, taskId));
    items.splice(Math.min(index, items.length), 0, ...inserted);
    phaseItemsByPhase[phaseId] = items.map((item, position) => ({
      ...item,
      phaseId,
      sortOrder: position,
    }));
  }

  function applyCommand(command: ProjectHierarchyCommand): ProjectHierarchyCommand {
    const previousPlacements = currentPlacements();
    const previousOrder = phases.map((phase) => phase.id);

    switch (command.type) {
      case 'reorder_phases': {
        const ordered = command.orderedPhaseIds
          .map((phaseId) => phases.find((phase) => phase.id === phaseId))
          .filter((phase): phase is ProjectPhase => Boolean(phase));
        phases.splice(0, phases.length, ...ordered.map((phase, index) => ({
          ...phase,
          sortOrder: index,
        })));
        return { type: 'reorder_phases', orderedPhaseIds: previousOrder };
      }
      case 'move_tasks':
      case 'assign_tasks': {
        const toPhaseId = command.toPhaseId ?? null;
        detachTasks(command.taskIds);
        if (toPhaseId) attachTasks(command.taskIds, toPhaseId, command.toIndex ?? 0);
        break;
      }
      case 'remove_tasks': {
        detachTasks(command.taskIds);
        break;
      }
      case 'restore_task_positions': {
        detachTasks(command.placements.map((placement) => placement.taskId));
        for (const placement of command.placements) {
          if (placement.phaseId) {
            attachTasks([placement.taskId], placement.phaseId, placement.index);
          }
        }
        break;
      }
      case 'restore_project_tasks': {
        detachTasks(command.states.map((state) => state.taskId));
        for (const state of command.states) {
          if (state.placement?.phaseId) {
            attachTasks([state.taskId], state.placement.phaseId, state.placement.index);
          }
        }
        break;
      }
      case 'update_phase_item': {
        if (typeof command.toIndex === 'number') {
          detachTasks([command.taskId]);
          attachTasks([command.taskId], command.phaseId, command.toIndex);
        }
        break;
      }
    }

    return {
      type: 'restore_task_positions',
      placements: previousPlacements.map((placement) => ({
        taskId: placement.taskId,
        phaseId: placement.phaseId,
        index: placement.index,
      })),
    };
  }

  function matchedFailure(url: string, method: string) {
    return failures.find((failure) => (
      failure.pattern.test(url)
      && (!failure.method || failure.method === method)
      && (!failure.once || !failure.used)
    ));
  }

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    requests.push({ url, method, body });

    const hold = holds.find((candidate) => candidate.pattern.test(url));
    if (hold) await hold.promise;

    const failure = matchedFailure(url, method);
    if (failure) {
      failure.used = true;
      return jsonResponse({ error: failure.error }, failure.status);
    }

    if (url === `/api/hub-projects/${PROJECT_ID}`) {
      if (method === 'PATCH') {
        Object.assign(project, body as Partial<ProjectRecord>);
        return jsonResponse({ project: { ...project }, evaluation: { added: 0 } });
      }
      if (method === 'DELETE') return jsonResponse({ success: true });
      if (scenario.missingProject) return jsonResponse({});
      return jsonResponse({ project: { ...project } });
    }

    const otherProject = /^\/api\/hub-projects\/([^/?]+)$/.exec(url);
    if (otherProject) {
      return jsonResponse({
        project: makeProject({ id: otherProject[1], name: `Project ${otherProject[1]}` }),
      });
    }

    const otherHierarchy = /^\/api\/projects\/([^/?]+)\/hierarchy$/.exec(url);
    if (otherHierarchy && otherHierarchy[1] !== PROJECT_ID) {
      return jsonResponse({
        hierarchy: {
          projectId: otherHierarchy[1],
          revision: 1,
          phases: [],
          phaseItemsByPhase: {},
        },
      });
    }

    if (url === `/api/projects/${PROJECT_ID}/hierarchy`) {
      if (method === 'POST') {
        const request = body as {
          commandId: string;
          expectedRevision: number;
          command: ProjectHierarchyCommand;
        };
        if (conflictNext || request.expectedRevision !== revision) {
          conflictNext = false;
          revision += 1;
          return jsonResponse({
            error: 'Hierarchy revision conflict',
            code: 'HIERARCHY_REVISION_CONFLICT',
            current: snapshot(),
          }, 409);
        }
        commands.push(request.command);
        const inverseCommand = applyCommand(request.command);
        revision += 1;
        return jsonResponse({
          commandId: request.commandId,
          revision,
          hierarchy: snapshot(),
          inverseCommand,
        });
      }
      return jsonResponse({ hierarchy: snapshot() });
    }

    if (url.startsWith('/api/tasks?')) {
      const projectFilter = new URL(url, 'http://localhost').searchParams.get('projectId');
      if (projectFilter && projectFilter !== PROJECT_ID) {
        return jsonResponse({ tasks: [], hasMore: false });
      }
      return jsonResponse({ tasks: tasks.map((task) => ({ ...task })), hasMore: false });
    }

    if (/^\/api\/tasks\/[^/?]+$/.test(url)) {
      const taskId = url.split('/').pop()!;
      if (method === 'DELETE') {
        const index = tasks.findIndex((task) => task.id === taskId);
        if (index >= 0) tasks.splice(index, 1);
        detachTasks([taskId]);
        return jsonResponse({ success: true });
      }
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (task && body) Object.assign(task, body as Partial<ProjectTask>);
      return jsonResponse({ task: task ? { ...task } : null });
    }

    if (url === '/api/hub-projects?includePhases=true') {
      return jsonResponse({
        projects: scenario.allProjects ?? [{
          id: PROJECT_ID,
          name: project.name,
          color: project.color,
          phases: phases.map(({ id, name }) => ({ id, name })),
        }],
      });
    }

    if (url === `/api/hub-projects/${PROJECT_ID}/rule-matches`) {
      return jsonResponse({ matches: ruleMatches.map((match) => ({ ...match })) });
    }

    if (url === `/api/hub-projects/${PROJECT_ID}/tasks`) {
      return jsonResponse({ success: true });
    }

    if (url === '/api/projects-overview') {
      return jsonResponse({
        categories: (scenario.categories ?? []).map((category) => ({ category })),
      });
    }

    if (url === '/api/features') {
      return jsonResponse({ taskDestinations: scenario.taskDestinations ?? [] });
    }

    if (url === '/api/project-phases' && method === 'POST') {
      const payload = body as { name: string; color: string; sortOrder: number };
      const created = makePhase(`phase-created-${phases.length + 1}`, {
        name: payload.name,
        color: payload.color,
        sortOrder: payload.sortOrder,
      });
      phases.push(created);
      phaseItemsByPhase[created.id] = [];
      revision += 1;
      return jsonResponse({ phase: { ...created } });
    }

    if (url === '/api/project-phases/ai-suggest' || url === '/api/project-phases/ai-refine') {
      return jsonResponse({
        proposal: {
          phases: [],
          overallReasoning: url.endsWith('ai-refine')
            ? 'Refined plan reasoning'
            : 'Suggested plan reasoning',
          suggestedNewTasks: [],
          suggestedClosures: [],
        },
      });
    }

    if (/^\/api\/project-phases\/[^/?]+$/.test(url)) {
      const phaseId = url.split('/').pop()!;
      const index = phases.findIndex((phase) => phase.id === phaseId);
      if (method === 'DELETE') {
        if (index >= 0) phases.splice(index, 1);
        delete phaseItemsByPhase[phaseId];
        revision += 1;
        return jsonResponse({ success: true });
      }
      if (index >= 0) {
        phases[index] = {
          ...phases[index],
          ...(body as Partial<ProjectPhase>),
          updatedAt: new Date().toISOString(),
        };
        revision += 1;
        return jsonResponse({ phase: { ...phases[index] } });
      }
      return jsonResponse({ error: 'Phase not found' }, 404);
    }

    if (url.startsWith(`/api/projects/${PROJECT_ID}/reports/burn`)) {
      return jsonResponse({ report: null }, 200);
    }

    if (url === '/api/my-day') return jsonResponse({ items: [] });

    return jsonResponse({});
  }));

  return {
    requests,
    requestsFor(pattern, method) {
      const regexp = toPattern(pattern);
      return requests.filter((request) => (
        regexp.test(request.url) && (!method || request.method === method)
      ));
    },
    hierarchyCommands: () => commands,
    hierarchy: snapshot,
    failOnce(pattern, options = {}) {
      failures.push({
        pattern: toPattern(pattern),
        method: options.method,
        status: options.status ?? 500,
        error: options.error ?? 'Request failed',
        once: true,
      });
    },
    fail(pattern, options = {}) {
      failures.push({
        pattern: toPattern(pattern),
        method: options.method,
        status: options.status ?? 500,
        error: options.error ?? 'Request failed',
        once: false,
      });
    },
    conflictNextCommand() {
      conflictNext = true;
    },
    hold(pattern) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entry = { pattern: toPattern(pattern), promise, release };
      holds.push(entry);
      return () => {
        const index = holds.indexOf(entry);
        if (index >= 0) holds.splice(index, 1);
        entry.release();
      };
    },
  };
}

// ─── Rendering helpers ────────────────────────────────────────────────

export type ProjectTabName = 'Overview' | 'Plan' | 'Project Tasks' | 'Settings';

export function tabButtonName(tab: ProjectTabName) {
  return new RegExp(`^${tab}( \\(\\d+\\))?$`);
}

export async function projectPageElement(): Promise<React.ReactElement> {
  const [{ default: ProjectDetailPage }, { TooltipProvider }] = await Promise.all([
    import('@/app/projects/[id]/page'),
    import('@/components/ui/Tooltip'),
  ]);

  return (
    <TooltipProvider>
      <ProjectDetailPage />
    </TooltipProvider>
  );
}

export async function renderProjectPage(): Promise<RenderResult> {
  return render(await projectPageElement());
}

export async function openProjectTab(tab: ProjectTabName) {
  const button = await screen.findByRole('button', { name: tabButtonName(tab) });
  await act(async () => {
    button.click();
  });
  return button;
}

/** Renders the project page and waits for the loaded shell before switching tabs. */
export async function renderProjectTab(tab: ProjectTabName) {
  const view = await renderProjectPage();
  await screen.findByRole('button', { name: tabButtonName('Overview') }, { timeout: 5000 });
  if (tab !== 'Overview') await openProjectTab(tab);
  return view;
}
