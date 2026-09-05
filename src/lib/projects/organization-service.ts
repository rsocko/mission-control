import 'server-only';

import { randomUUID } from 'crypto';
import type {
  ProjectOrganizationProject,
  ProjectOrganizationProjectUpdate,
  ProjectPhaseMutableField,
  ProjectPhaseUpdate,
} from '@/db/persistence/project-organization';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  hubProjectRulesChanged,
  type HubProjectUpdate,
} from './hub-project-update';
import { resolveProjectIconColor } from './normalize-project';
import { normalizeAutoIncludeRules } from '@/lib/rules';
import { previewProjectRules, reevaluateProject } from '@/lib/rules';
import {
  publishSemanticEntityDelete,
  publishSemanticEntityUpsert,
} from '@/lib/semantic-index/publication-service';
import { dbLogger } from '@/lib/logger';

async function repository() {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.projectAutomation.projectAdministration;
}

export async function listHubProjects(input: {
  includeHidden: boolean;
  includePhases: boolean;
}) {
  return (await repository()).listProjects(input);
}

export async function getHubProject(projectId: string) {
  return (await repository()).getProject(projectId);
}

export async function createHubProject(input: {
  name: string;
  description?: unknown;
  color?: unknown;
  icon?: unknown;
  iconColor?: unknown;
  sourceBindings?: unknown;
  autoIncludeRules?: unknown;
  kanbanColumns?: unknown;
  defaultView?: unknown;
  category?: unknown;
  targetDate?: unknown;
  metadata?: unknown;
}) {
  const id = `proj-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const now = new Date().toISOString();
  const color = typeof input.color === 'string' && input.color ? input.color : '#3b82f6';
  const project: ProjectOrganizationProject = {
    id,
    name: input.name,
    description: typeof input.description === 'string' && input.description
      ? input.description
      : null,
    color,
    icon: typeof input.icon === 'string' && input.icon ? input.icon : null,
    iconColor: resolveProjectIconColor(
      typeof input.iconColor === 'string' ? input.iconColor : null,
      color,
    ) ?? null,
    sourceBindings: Array.isArray(input.sourceBindings) ? input.sourceBindings : [],
    autoIncludeRules: normalizeAutoIncludeRules(input.autoIncludeRules),
    kanbanColumns: Array.isArray(input.kanbanColumns) ? input.kanbanColumns : [],
    defaultView: typeof input.defaultView === 'string' && input.defaultView
      ? input.defaultView
      : 'list',
    defaultFilters: null,
    status: 'active',
    statusOverride: null,
    hidden: false,
    category: typeof input.category === 'string' && input.category
      ? input.category
      : null,
    targetDate: typeof input.targetDate === 'string' && input.targetDate
      ? input.targetDate
      : null,
    startedAt: null,
    completedAt: null,
    sortOrder: 0,
    hierarchyRevision: 0,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata as Record<string, unknown>
      : {},
    createdAt: now,
    updatedAt: now,
  };
  await (await repository()).createProject(project);

  let evaluation = null;
  let evaluationFailed = false;
  try {
    evaluation = await reevaluateProject(id);
  } catch (error) {
    evaluationFailed = true;
    dbLogger.error({ err: error, projectId: id }, 'Project created but auto-include evaluation failed');
  }
  await Promise.all([
    publishSemanticEntityUpsert('project', id),
    ...(evaluation?.matches ?? [])
      .filter((match) => match.alreadyAssigned)
      .map((match) => publishSemanticEntityUpsert('task', match.taskId)),
  ]);
  return { id, evaluation, evaluationFailed };
}

export async function updateHubProject(
  projectId: string,
  updates: HubProjectUpdate,
) {
  const persistenceUpdates: ProjectOrganizationProjectUpdate = {
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  const { affectedTaskIds } = await (await repository()).updateProject(
    projectId,
    persistenceUpdates,
  );

  let evaluation = null;
  let evaluationFailed = false;
  if (hubProjectRulesChanged(updates)) {
    try {
      evaluation = await reevaluateProject(projectId);
    } catch (error) {
      evaluationFailed = true;
      dbLogger.error(
        { err: error, projectId },
        'Project rules saved but auto-include evaluation failed',
      );
    }
  }
  const taskIdsToPublish = new Set(affectedTaskIds);
  for (const match of evaluation?.matches ?? []) {
    if (match.alreadyAssigned) taskIdsToPublish.add(match.taskId);
  }
  await Promise.all([
    publishSemanticEntityUpsert('project', projectId),
    ...[...taskIdsToPublish].map((taskId) => publishSemanticEntityUpsert('task', taskId)),
  ]);
  return { evaluation, evaluationFailed };
}

export async function deleteHubProject(
  projectId: string,
  cascade: 'memberships' | 'owned-hierarchy',
) {
  const { affectedTaskIds } = await (await repository()).deleteProject(projectId, cascade);
  await Promise.all([
    publishSemanticEntityDelete('project', projectId),
    ...affectedTaskIds.map((taskId) => publishSemanticEntityUpsert('task', taskId)),
  ]);
}

export async function previewHubProjectRuleMatches(projectId: string) {
  if (!await (await repository()).projectExists(projectId)) return null;
  return previewProjectRules(projectId);
}

export async function listProjectPhases(input: {
  projectId: string | null;
  crossProject: boolean;
}) {
  return (await repository()).listPhases(input);
}

export async function createProjectPhase(input: {
  projectId?: unknown;
  name: string;
  description?: unknown;
  color?: unknown;
  estimatedDays?: unknown;
  targetStart?: unknown;
  targetEnd?: unknown;
  sortOrder?: unknown;
  startAfterPhaseId?: unknown;
}) {
  const now = new Date().toISOString();
  return (await repository()).createPhase({
    id: randomUUID(),
    projectId: typeof input.projectId === 'string' && input.projectId ? input.projectId : null,
    name: input.name,
    description: typeof input.description === 'string' && input.description
      ? input.description
      : null,
    status: 'pending',
    color: typeof input.color === 'string' && input.color ? input.color : null,
    estimatedDays: typeof input.estimatedDays === 'number' && input.estimatedDays
      ? input.estimatedDays
      : null,
    targetStart: typeof input.targetStart === 'string' && input.targetStart
      ? input.targetStart
      : null,
    targetEnd: typeof input.targetEnd === 'string' && input.targetEnd
      ? input.targetEnd
      : null,
    startAfterPhaseId: typeof input.startAfterPhaseId === 'string' && input.startAfterPhaseId
      ? input.startAfterPhaseId
      : null,
    sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : 0,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function getProjectPhase(phaseId: string) {
  return (await repository()).getPhase(phaseId);
}

const PHASE_MUTABLE_FIELDS: readonly ProjectPhaseMutableField[] = [
  'name',
  'description',
  'status',
  'color',
  'estimatedDays',
  'targetStart',
  'targetEnd',
  'sortOrder',
  'completedAt',
  'projectId',
  'startAfterPhaseId',
];

export async function updateProjectPhase(
  phaseId: string,
  body: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const updates: ProjectPhaseUpdate = { updatedAt: now };
  for (const field of PHASE_MUTABLE_FIELDS) {
    if (field in body) updates[field] = body[field];
  }
  if (body.status === 'completed' && !body.completedAt) updates.completedAt = now;
  return (await repository()).updatePhase(phaseId, updates);
}

export async function deleteProjectPhase(phaseId: string) {
  await (await repository()).deletePhase(phaseId);
}
