/**
 * Backend-neutral persistence used by the synchronous AI workflow routes.
 *
 * The surface is intentionally use-case shaped. It exposes only bounded or
 * aggregate domain reads; no SQL, transaction, table, or database handle
 * crosses this boundary.
 */

import type { WorkerPersistenceRepositories } from './worker-repositories';

export interface AIContextTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
}

export interface AIDigestTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
}

export interface AIDigestSnapshot {
  counts: {
    open: number;
    overdue: number;
    dueToday: number;
    inProgress: number;
    critical: number;
    unreadNotifications: number;
    urgentNotifications: number;
  };
  overdue: AIDigestTask[];
  dueToday: AIDigestTask[];
  inProgress: AIDigestTask[];
  notifications: Array<{
    id: string;
    title: string;
    level: string;
    connectorType: string;
  }>;
  sources: string[];
  rowCount: number;
}

export interface NotificationClassificationRow {
  id: string;
  title: string;
  level: string;
  category: string;
  isActionable: boolean;
  connectorType: string;
  receivedAt: string;
}

export interface AssignmentProject {
  id: string;
  name: string;
  description: string | null;
}

export interface AssignmentTask {
  id: string;
  title: string;
  connectorType: string;
  sourceListName: string | null;
}

export type TagInferenceTask = AssignmentTask;

export interface SmartPriorityTask extends AssignmentTask {
  priority: string;
  dueDate: string | null;
  updatedAt: string;
}

export interface MicroStatusTask {
  id: string;
  title: string;
  status: string;
  microStatus: string | null;
  priority: string;
  createdAt: string;
  updatedAt: string;
  dueDate: string | null;
  connectorType: string;
  assignee: string | null;
}

export interface TaskBreakdownContext {
  task: {
    id: string;
    title: string;
    description: string | null;
    priority: string;
    dueDate: string | null;
    effort: number | null;
    sourceListName: string | null;
    connectorType: string;
    updatedAt: string;
  };
  tagNames: string[];
  projectNames: string[];
  subtaskTitles: string[];
}

export interface WhatsNextTask extends AssignmentTask {
  priority: string;
  dueDate: string | null;
}

export interface AIWorkflowContextPersistence {
  listTaskContext(): Promise<AIContextTask[]>;
  getTriageContext(now: string): Promise<{
    unreadCount: number;
    criticalCount: number;
    categories: string[];
  }>;
  loadDigestSnapshot(input: {
    today: string;
    now: string;
    rowsPerCategory: number;
  }): Promise<AIDigestSnapshot>;
}

export interface AIWorkflowRecommendationPersistence {
  listAssignmentProjects(): Promise<AssignmentProject[]>;
  listAssignmentTasks(limit: number): Promise<AssignmentTask[]>;
  listTagInferenceTasks(limit: number): Promise<TagInferenceTask[]>;
  listTaggedTaskIds(): Promise<string[]>;
  listAvailableTagNames(): Promise<string[]>;
  listSmartPriorityTasks(limit: number): Promise<SmartPriorityTask[]>;
  listMicroStatusTasks(limit: number): Promise<MicroStatusTask[]>;
  listWhatsNextTasks(limit: number): Promise<WhatsNextTask[]>;
  listWhatsNextNotifications(now: string, limit: number): Promise<Array<{
    connectorType: string;
  }>>;
}

export interface AIWorkflowPersistence {
  context: AIWorkflowContextPersistence;
  getTaskBreakdownContext(taskId: string): Promise<TaskBreakdownContext | null>;
  notifications: {
    listForClassification(now: string, limit: number): Promise<NotificationClassificationRow[]>;
  };
  recommendations: AIWorkflowRecommendationPersistence;
  listTaskConnectorTypes(taskIds: readonly string[]): Promise<string[]>;
}

declare module './worker-repositories' {
  interface WorkerPersistenceRepositories {
    aiWorkflows?: AIWorkflowPersistence;
  }
}

export function requireAIWorkflowPersistence(
  repositories: WorkerPersistenceRepositories,
): AIWorkflowPersistence {
  if (!repositories.aiWorkflows) {
    throw new Error('AI workflow persistence is not available in the selected backend');
  }
  return repositories.aiWorkflows;
}
