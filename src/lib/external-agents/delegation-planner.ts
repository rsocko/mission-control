import 'server-only';

import { generateText, Output } from 'ai';
import { z } from 'zod';
import {
  getAsyncAIModel,
  getAsyncAIRouteOutcome,
} from '@/lib/ai/provider-runtime';
import type { AIRouteOutcome } from '@/lib/ai/types';
import type { AgentPayloadSnapshot } from './contracts';

const strategySchema = z.enum(['separate', 'combined']);

const outputSchema = z.object({
  groups: z.array(z.object({
    taskIds: z.array(z.string().min(1)).min(1),
    strategy: strategySchema,
    rationale: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  }).strict()).min(1).max(100),
}).strict();

export interface DelegationPlanGroup {
  id: string;
  taskIds: string[];
  strategy: z.infer<typeof strategySchema>;
  repository: string;
  rationale: string;
  confidence: number;
}

export interface DelegationPlan {
  groups: DelegationPlanGroup[];
  routing: AIRouteOutcome;
}

function groupId(index: number) {
  return `group-${index + 1}`;
}

export function normalizeDelegationPlanOutput(input: {
  output: unknown;
  taskIds: string[];
  repositories: Map<string, string>;
}): DelegationPlanGroup[] {
  const parsed = outputSchema.parse(input.output);
  const validTaskIds = new Set(input.taskIds);
  const used = new Set<string>();
  const groups: DelegationPlanGroup[] = [];

  for (const candidate of parsed.groups) {
    const taskIds = [...new Set(candidate.taskIds)].filter((taskId) => {
      if (!validTaskIds.has(taskId) || used.has(taskId)) return false;
      used.add(taskId);
      return true;
    });
    if (!taskIds.length) continue;
    const repositories = [...new Set(taskIds.map((taskId) => input.repositories.get(taskId)))];
    if (repositories.length !== 1 || !repositories[0]) {
      for (const taskId of taskIds) used.delete(taskId);
      continue;
    }
    groups.push({
      id: groupId(groups.length),
      taskIds,
      strategy: taskIds.length > 1 && candidate.strategy === 'combined'
        ? 'combined'
        : 'separate',
      repository: repositories[0],
      rationale: candidate.rationale.trim(),
      confidence: candidate.confidence,
    });
  }

  for (const taskId of input.taskIds) {
    if (used.has(taskId)) continue;
    const repository = input.repositories.get(taskId);
    if (!repository) continue;
    groups.push({
      id: groupId(groups.length),
      taskIds: [taskId],
      strategy: 'separate',
      repository,
      rationale: 'Kept separate because the planner did not place this task in a valid group.',
      confidence: 0,
    });
  }
  return groups;
}

export async function proposeDelegationPlan(input: {
  tasks: AgentPayloadSnapshot['tasks'];
  repositories: Map<string, string>;
}): Promise<DelegationPlan> {
  const route = await getAsyncAIModel('delegation-planning', {
    sources: [...new Set(input.tasks.map(({ connectorType }) => connectorType))],
  });
  const result = await generateText({
    model: route.model,
    output: Output.object({ schema: outputSchema }),
    system: `You plan GitHub Copilot cloud sessions for selected software tasks.

Group tasks only when one agent can implement them as one cohesive change and one reviewable pull request.
Keep tasks separate when they are independently mergeable, unrelated, broad, risky together, or likely to touch unrelated areas.
Tasks in different repositories must never share a group.
Every supplied task ID must appear exactly once.
Use "combined" only for groups with two or more tasks. Use "separate" for single tasks.
Give a concrete rationale and a calibrated confidence from 0 to 1.`,
    prompt: JSON.stringify({
      tasks: input.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description?.slice(0, 2_000) ?? null,
        tags: task.tags.slice(0, 20),
        priority: task.priority,
        effort: task.effort,
        repository: input.repositories.get(task.id),
        subtasks: task.subtasks.slice(0, 20).map((subtask) => ({
          title: subtask.title,
          description: subtask.description?.slice(0, 500) ?? null,
        })),
      })),
    }),
    maxOutputTokens: 2_500,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(30_000),
  });
  return {
    groups: normalizeDelegationPlanOutput({
      output: result.output,
      taskIds: input.tasks.map(({ id }) => id),
      repositories: input.repositories,
    }),
    routing: getAsyncAIRouteOutcome(route, result.response),
  };
}
