import type { InboxListEntry, TaskFilterSpec } from '@/lib/tasks/core/contracts';

export interface GraphReportingFilterInputs {
  readonly myDayTaskIds: readonly string[];
  readonly assignedGitHubUsernames: readonly string[];
  readonly inboxListEntries: readonly InboxListEntry[];
}

export interface GraphTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  microStatus: string | null;
  priority: string;
  connectorType: string;
  connectorInstanceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  effort: number | null;
}

export interface GraphProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  color: string;
}

export interface GraphPhaseRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  color: string | null;
  startAfterPhaseId: string | null;
}

export interface GraphTagRow {
  id: string;
  name: string;
  color: string | null;
}

export interface GraphDependencyRow {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  type: 'blocks' | 'related';
  connectorInstanceId: string | null;
  syncStatus: 'local' | 'pending' | 'synced' | 'failed';
  syncAction: 'create' | 'delete' | null;
  syncError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface GraphDependencyTaskRow {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  isChecklistItem: boolean;
  metadata: Record<string, unknown>;
}

export interface UniverseGraphRows {
  tasks: Array<Pick<
    GraphTaskRow,
    | 'id'
    | 'title'
    | 'priority'
    | 'status'
    | 'connectorType'
    | 'connectorInstanceId'
    | 'sourceListId'
    | 'sourceListName'
    | 'effort'
  >>;
  tags: Array<GraphTagRow & { taskId: string }>;
  projects: Array<Pick<GraphProjectRow, 'id' | 'name' | 'color' | 'status'> & {
    taskId: string;
  }>;
  filteredTaskCount: number;
  hasMoreTasks: boolean;
}

export interface UniverseGraphRepository {
  read(input: {
    spec: TaskFilterSpec;
    filterInputs: GraphReportingFilterInputs;
    seedTaskIds?: readonly string[];
    maxNodes: number;
    includeTags: boolean;
    includeProjects: boolean;
  }): Promise<UniverseGraphRows>;
  listEligibleTaskIds(input: {
    spec: TaskFilterSpec;
    filterInputs: GraphReportingFilterInputs;
    taskIds: readonly string[];
  }): Promise<string[]>;
}

export type NeighborAggregateRef =
  | { kind: 'tag'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'property'; dimension: 'priority' | 'source' | 'status' | 'list' | 'effort'; value: string };

export type NeighborAggregateCenter =
  | { kind: 'tag'; row: GraphTagRow }
  | { kind: 'project'; row: GraphProjectRow }
  | { kind: 'property' };

export interface TaskNeighborContext {
  center: GraphTaskRow | null;
  dependencies: GraphDependencyRow[];
  dependencyTasks: GraphTaskRow[];
  projects: GraphProjectRow[];
  phases: GraphPhaseRow[];
  tags: GraphTagRow[];
}

export interface GraphNeighborRepository {
  readAggregate(input: {
    ref: NeighborAggregateRef;
    eligibleTaskIds?: readonly string[];
    limit: number;
  }): Promise<{ center: NeighborAggregateCenter | null; tasks: GraphTaskRow[] }>;
  readTask(input: {
    taskId: string;
    eligibleTaskIds?: readonly string[];
    dependencyLimit: number;
    includeExplicit: boolean;
    includeDerived: boolean;
  }): Promise<TaskNeighborContext>;
  listTasks(taskIds: readonly string[]): Promise<GraphTaskRow[]>;
  listDeletedConnectorIds(): Promise<string[]>;
  /**
   * Presentation rows for the tasks on the far side of a task's explicit
   * relationships, including their hub-project memberships. Unknown ids are
   * omitted; results are ordered by task id.
   */
  listRelationshipTasks(
    taskIds: readonly string[],
  ): Promise<RelationshipTaskRow[]>;
}

/** A related task as the task-relationships surface presents it. */
export interface RelationshipTaskRow {
  id: string;
  title: string;
  status: string;
  connectorType: string;
  sourceId: string;
  metadata: Record<string, unknown>;
  projectIds: string[];
  projectNames: string[];
}

export interface ProjectGraphRows {
  project: GraphProjectRow | null;
  phases: GraphPhaseRow[];
  tasks: Array<Pick<GraphTaskRow, 'id' | 'title' | 'description' | 'status' | 'microStatus'>>;
  phaseItems: Array<{ phaseId: string; taskId: string }>;
  dependencies: GraphDependencyRow[];
}

export type CreateDependencyResult =
  | {
      kind: 'created';
      dependency: GraphDependencyRow;
      blocker: GraphDependencyTaskRow;
      blocked: GraphDependencyTaskRow;
    }
  | { kind: 'missing-project-membership' }
  | { kind: 'missing-task' }
  | { kind: 'duplicate' }
  | { kind: 'cycle' };

export type DeleteDependencyContextResult =
  | {
      kind: 'found';
      dependency: GraphDependencyRow;
      blocker: GraphDependencyTaskRow;
      blocked: GraphDependencyTaskRow;
    }
  | { kind: 'missing' }
  | { kind: 'wrong-task' }
  | { kind: 'missing-project-membership' }
  | { kind: 'missing-task' };

export interface ProjectGraphRepository {
  read(projectId: string): Promise<ProjectGraphRows>;
  createDependency(input: {
    projectId?: string;
    sourceTaskId: string;
    targetTaskId: string;
    type: 'blocks' | 'related';
    id: string;
    createdAt: string;
  }): Promise<CreateDependencyResult>;
  getDependencyDeleteContext(input: {
    projectId?: string;
    taskId?: string;
    dependencyId: string;
  }): Promise<DeleteDependencyContextResult>;
}

export interface OverviewProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  iconColor: string | null;
  sourceBindings: unknown[];
  autoIncludeRules: unknown[];
  kanbanColumns: unknown[];
  defaultView: string;
  defaultFilters: Record<string, unknown> | null;
  status: string;
  statusOverride: string | null;
  hidden: boolean;
  category: string | null;
  targetDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  sortOrder: number;
  hierarchyRevision: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OverviewTaskRow {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  dueDate: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface ProjectsOverviewRows {
  projects: OverviewProjectRow[];
  memberships: Array<{ projectId: string; taskId: string }>;
  tasks: OverviewTaskRow[];
  tags: Array<{
    projectId: string;
    id: string;
    name: string;
    slug: string;
    type: string;
    source: string | null;
    color: string | null;
    confirmed: boolean;
    createdAt: string;
  }>;
}

export interface ProjectsOverviewRepository {
  read(): Promise<ProjectsOverviewRows>;
  listProjectTaskStatuses(projectId: string): Promise<Array<{
    status: string;
    updatedAt: string;
    parentId: string | null;
  }>>;
}

export interface BurnHistoryEvent {
  id: number;
  taskId: string;
  eventType: string;
  fieldName: string | null;
  previousValue: string | null;
  newValue: string | null;
  projectId: string | null;
  phaseId: string | null;
  occurredAt: string;
  recordedAt: string;
  provenance: string;
  provenanceRef: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface BurnReportRows {
  scope: {
    projectId: string;
    scope: 'project' | 'phase';
    scopeId: string;
    scopeName: string;
    scheduleStart: string | null;
    scheduleEnd: string | null;
  } | null;
  candidateEvents: BurnHistoryEvent[];
  tasks: Array<{
    id: string;
    title: string;
    createdAt: string;
    completedAt: string | null;
  }>;
}

export interface BurnReportRepository {
  read(input: {
    projectId: string;
    phaseId?: string;
    endExclusive: string;
  }): Promise<BurnReportRows>;
}

export interface ClusterSaveRepository {
  findProject(projectId: string): Promise<boolean>;
  deleteProjectIfCreationToken(input: {
    projectId: string;
    creationToken: string;
  }): Promise<{ deleted: boolean; affectedTaskIds: string[] }>;
  findTagBySlug(slug: string): Promise<{ id: string } | null>;
  createTag(input: {
    id: string;
    name: string;
    slug: string;
    color: string;
    createdAt: string;
  }): Promise<{ id: string; created: boolean }>;
  deleteTagIfUnused(tagId: string): Promise<boolean>;
  recordTagAudit(input: {
    tagId: string;
    taskIds: readonly string[];
    clusterId: string;
    projectionFingerprint: string;
    now: string;
  }): Promise<void>;
}

export interface GraphReportingPersistence {
  universe: UniverseGraphRepository;
  neighbors: GraphNeighborRepository;
  projects: ProjectGraphRepository;
  overview: ProjectsOverviewRepository;
  burn: BurnReportRepository;
  clusterSave: ClusterSaveRepository;
}
