import { generateText } from 'ai';
import { getLocalToday } from '@/lib/utils/date';
import {
  getAsyncAIModel,
  getAsyncAIRouteOutcome,
} from '../provider-runtime';
import type { AIRouteOutcome } from '../types';
import { getEnergyTagsForTasks } from './energy-tag-queries';
import { getAIWorkflowPersistence } from '../workflow-persistence';
import { getResolvedPriorityEntities } from '@/lib/priority-entities';
import {
  computeBatchSmartScores,
  createScoreInput,
  type ScoreInputTask,
  type ScoredTask,
  type SourceRanking,
} from '@/lib/smart-score';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { TaskPriority } from '@/types';

function taskPriority(value: string): TaskPriority {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'none';
}

function deadlineDescription(dueDate: string | null, today: string): string {
  if (!dueDate) return 'none';
  if (dueDate < today) return `overdue (${dueDate})`;
  if (dueDate === today) return 'due today';
  return `due ${dueDate}`;
}

function groupByTaskId<T extends { taskId: string }>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const group = grouped.get(item.taskId) ?? [];
    group.push(item);
    grouped.set(item.taskId, group);
  }
  return grouped;
}

export function describeWhatsNextTask(
  task: ScoreInputTask,
  score: ScoredTask,
  today: string,
  energy: string | undefined,
): string {
  const breakdown = score.score;
  return [
    `- "${task.title}"`,
    `importance: ${task.priority}`,
    `deadline: ${deadlineDescription(task.dueDate ?? null, today)} (${breakdown.urgency}/20)`,
    `Horizon: ${task.planningHorizon ?? 'not set'} (${breakdown.planningHorizon}/10)`,
    `effort: ${task.effort ?? 'not set'}`,
    `Smart Score: ${breakdown.total}`,
    energy ? `energy: ${energy}` : null,
    `source: ${task.connectorType}`,
  ].filter(Boolean).join(' | ');
}

export async function whatsNext(context?: {
  timeAvailable?: number;
  energy?: 'high' | 'medium' | 'low';
  focus?: string;
}): Promise<{ recommendation: string; routing: AIRouteOutcome }> {
  const today = getLocalToday();
  const persistence = await getAIWorkflowPersistence();
  const taskCore = await getTaskCorePersistence();
  const [snapshot, entities] = await Promise.all([
    taskCore.organization.readSmartScoreInputs({ statuses: ['todo'] }),
    getResolvedPriorityEntities(),
  ]);
  const unreadNotifications = await persistence.recommendations
    .listWhatsNextNotifications(new Date().toISOString(), 5);
  const tagsByTaskId = groupByTaskId(snapshot.taskTags);
  const projectsByTaskId = groupByTaskId(snapshot.taskProjects);
  const durationByTaskId = new Map(
    snapshot.estimatedDurations.map((entry) => [entry.taskId, entry.estimatedDuration]),
  );
  const candidates = snapshot.tasks.map((task): ScoreInputTask => ({
    ...task,
    priority: taskPriority(task.priority),
    estimatedDuration: durationByTaskId.get(task.id) ?? null,
  }));
  const taskById = new Map(candidates.map((task) => [task.id, task]));
  const scoredTasks = computeBatchSmartScores(
    candidates.map((task) => createScoreInput(
      task,
      (tagsByTaskId.get(task.id) ?? []).map((tag) => ({ id: tag.tagId, name: tag.tagName })),
      (projectsByTaskId.get(task.id) ?? []).map((project) => ({
        id: project.projectId,
        name: project.projectName,
      })),
    )),
    entities,
    snapshot.sourceRankings as SourceRanking[],
  );
  const topScoredTasks = scoredTasks.slice(0, 20);
  const openTasks = topScoredTasks.flatMap((score) => {
    const task = taskById.get(score.taskId);
    return task ? [task] : [];
  });
  const scoreByTaskId = new Map(topScoredTasks.map((score) => [score.taskId, score]));
  const overdue = openTasks.filter(task => task.dueDate && task.dueDate < today);
  const critical = openTasks.filter(task => (
    task.priority === 'critical' || task.priority === 'high'
  ));
  const energyMap = await getEnergyTagsForTasks(openTasks.map(task => task.id));
  const route = await getAsyncAIModel('whats-next', {
    sources: [
      ...openTasks.map(task => task.connectorType),
      ...unreadNotifications.map(notification => notification.connectorType),
    ],
  });
  const taskContext = `
Available time: ${context?.timeAvailable || 'flexible'} minutes
Energy level: ${context?.energy || 'medium'}
Focus area: ${context?.focus || 'any'}
Today: ${today}

Overdue (${overdue.length}): ${overdue.slice(0, 3).map(task => `"${task.title}" (due ${task.dueDate})`).join(', ')}
Critical (${critical.length}): ${critical.slice(0, 3).map(task => `"${task.title}"`).join(', ')}
Open tasks: ${candidates.length} total
Unread notifications: ${unreadNotifications.length}

Top tasks by Smart Score:
${openTasks.slice(0, 10).map((task) => describeWhatsNextTask(
    task,
    scoreByTaskId.get(task.id)!,
    today,
    energyMap.get(task.id),
  )).join('\n')}
`;
  const result = await generateText({
    model: route.model,
    system: 'You are a "what\'s next" advisor. Given the user\'s context (time, energy, focus), recommend 1-3 specific next actions. Treat importance, deadline pressure, planning Horizon, effort, and Smart Score as distinct signals: Horizon expresses intent and must never be presented as a deadline. Match task energy demands to the user\'s current energy level. For each recommendation, briefly name the strongest signals that earned its place. Be direct and actionable. Format as a short numbered list.',
    messages: [{ role: 'user', content: taskContext }],
  });

  return {
    recommendation: result.text,
    routing: getAsyncAIRouteOutcome(route, result.response),
  };
}
