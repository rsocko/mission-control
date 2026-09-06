import type {
  ProjectPhase,
  ProjectPhaseItem,
} from '@/types';

export interface ProjectOrganizationProject {
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

export interface ProjectOrganizationProjectWithPhases
  extends ProjectOrganizationProject {
  phases: Array<{ id: string; name: string }>;
}

export type ProjectOrganizationProjectUpdate = Partial<Pick<
  ProjectOrganizationProject,
  | 'name'
  | 'description'
  | 'color'
  | 'icon'
  | 'iconColor'
  | 'sourceBindings'
  | 'defaultView'
  | 'defaultFilters'
  | 'statusOverride'
  | 'hidden'
  | 'category'
  | 'targetDate'
  | 'sortOrder'
  | 'metadata'
>> & {
  autoIncludeRules?: unknown[];
  kanbanColumns?: unknown[];
  updatedAt: string;
};

export type ProjectPhaseMutableField =
  | 'name'
  | 'description'
  | 'status'
  | 'color'
  | 'estimatedDays'
  | 'targetStart'
  | 'targetEnd'
  | 'sortOrder'
  | 'completedAt'
  | 'projectId'
  | 'startAfterPhaseId';

export type ProjectPhaseUpdate =
  Partial<Record<ProjectPhaseMutableField, unknown>>
  & { updatedAt: string };

export interface PhasePlanningContextTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  updatedAt: string;
  tags: string[];
  projectNames: string[];
}

export interface GoalDevelopmentContext {
  task: {
    id: string;
    title: string;
    description: string | null;
    connectorType: string;
  };
  tags: Array<{ name: string; slug: string }>;
  linkedProjects: Array<{
    name: string;
    description: string | null;
    category: string | null;
  }>;
  existingProjects: Array<{
    name: string;
    category: string | null;
  }>;
}

export interface ProjectAdministrationPersistence {
  listProjects(input: {
    includeHidden: boolean;
    includePhases: boolean;
  }): Promise<Array<ProjectOrganizationProject | ProjectOrganizationProjectWithPhases>>;
  getProject(projectId: string): Promise<ProjectOrganizationProject | null>;
  projectExists(projectId: string): Promise<boolean>;
  createProject(project: ProjectOrganizationProject): Promise<void>;
  updateProject(
    projectId: string,
    updates: ProjectOrganizationProjectUpdate,
  ): Promise<{ affectedTaskIds: string[] }>;
  deleteProject(
    projectId: string,
    cascade: 'memberships' | 'owned-hierarchy',
  ): Promise<{ affectedTaskIds: string[] }>;
  listPhases(input: {
    projectId: string | null;
    crossProject: boolean;
  }): Promise<ProjectPhase[]>;
  createPhase(phase: ProjectPhase): Promise<ProjectPhase>;
  getPhase(
    phaseId: string,
  ): Promise<{ phase: ProjectPhase; items: ProjectPhaseItem[] } | null>;
  updatePhase(
    phaseId: string,
    updates: ProjectPhaseUpdate,
  ): Promise<ProjectPhase | null>;
  deletePhase(phaseId: string): Promise<void>;
  listPhasePlanningTaskIds(projectId: string | null): Promise<string[]>;
  listPhasePlanningTasks(
    taskIds: readonly string[],
  ): Promise<PhasePlanningContextTask[]>;
  getGoalDevelopmentContext(
    taskId: string,
    existingProjectLimit: number,
  ): Promise<GoalDevelopmentContext | null>;
}

export interface ListOrganizationGroup {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
  sourceId: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface ListOrganizationSourceList {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type: string;
  taskCount: number;
  lastSyncedAt: string | null;
  wellKnownListName: string | null;
  groupId: string | null;
  sortOrder: number;
  hidden: boolean;
  lastKnownRemoteName: string | null;
  userDisplayName: string | null;
  icon: string | null;
  iconColor: string | null;
}

export interface ListOrganizationSnapshot {
  groups: Array<ListOrganizationGroup & {
    sourceLists: ListOrganizationSourceList[];
  }>;
  ungroupedLists: ListOrganizationSourceList[];
}

export type ListOrganizationGroupUpdate = Partial<Pick<
  ListOrganizationGroup,
  'name' | 'icon' | 'iconColor' | 'sortOrder'
>>;

export interface ListOrganizationPersistence {
  getSnapshot(): Promise<ListOrganizationSnapshot>;
  createGroup(group: ListOrganizationGroup): Promise<void>;
  updateGroup(groupId: string, updates: ListOrganizationGroupUpdate): Promise<void>;
  deleteGroup(groupId: string): Promise<void>;
  reorderGroups(orderedIds: readonly string[]): Promise<void>;
}
