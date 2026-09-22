import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { getLocalToday } from '@/lib/utils/date';

const MAX_MUTATION_ATTEMPTS = 3;

interface SimpleTaskMutationResult {
  taskId: string;
  title: string;
  status: string;
  microStatus: string | null;
  priority: string;
  dueDate: string | null;
  source: string;
  sourceList: string | null;
}

/**
 * Applies a single-field patch to a task via the clean task-core write seam,
 * retrying a bounded number of times on optimistic-concurrency conflicts.
 */
async function applySimpleTaskPatch(
  taskId: string,
  patch: Record<string, unknown>,
): Promise<{ success: true; result: SimpleTaskMutationResult } | { success: false; error: string }> {
  const persistence = await getTaskCorePersistence();
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const writeContext = await persistence.mutations.getTaskWriteContext(taskId);
    if (!writeContext) return { success: false, error: 'Task not found.' };
    const currentTask = writeContext.task;
    const now = new Date().toISOString();
    const outcome = await persistence.mutations.mutateTask({
      taskId,
      expectedUpdatedAt: currentTask.updatedAt,
      expectedStatusForTerminalTransition:
        patch.status === 'done' || patch.status === 'cancelled'
          ? currentTask.status
          : null,
      now,
      patch,
    });
    if (outcome.kind === 'not-found') return { success: false, error: 'Task not found.' };
    if (outcome.kind === 'revision-conflict') continue;
    const task = outcome.task;
    return {
      success: true,
      result: {
        taskId: task.id,
        title: task.title,
        status: task.status,
        microStatus: task.microStatus,
        priority: task.priority,
        dueDate: task.dueDate,
        source: task.connectorType,
        sourceList: task.sourceListName,
      },
    };
  }
  return { success: false, error: 'Task changed while it was being updated. Please try again.' };
}

export const taskTools = {
  getTaskSummary: tool({
    description: 'Get a summary of all tasks grouped by status, priority, and source',
    inputSchema: zodSchema(z.object({
      includeOverdueList: z.boolean().optional().describe('Whether to include list of overdue items'),
    })),
    execute: async ({ includeOverdueList }) => {
      const persistence = await getAIWorkflowPersistence();
      const summary = await persistence.taskTools.getSummary({
        today: getLocalToday(),
        overdueLimit: 10,
      });
      return {
        total: summary.total,
        open: summary.open,
        overdue: summary.overdue,
        critical: summary.critical,
        done: summary.done,
        bySource: summary.bySource,
        overdueItems: includeOverdueList !== false ? summary.overdueItems : undefined,
      };
    },
  }),

  searchTasks: tool({
    description: 'Search tasks by title, status, priority, or source. Returns matching tasks.',
    inputSchema: zodSchema(z.object({
      query: z.string().optional().describe('Text to search in task titles/descriptions'),
      status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional(),
      source: z.string().optional().describe('Connector type like microsoft-todo or github-issues'),
      limit: z.number().optional().default(15),
    })),
    execute: async ({ query, status, priority, source, limit }) => {
      const persistence = await getAIWorkflowPersistence();
      return persistence.taskTools.search({
        query,
        status,
        priority,
        source,
        limit: limit || 15,
      });
    },
  }),

  completeTask: tool({
    description: 'Mark a task as done/completed',
    inputSchema: zodSchema(z.object({
      taskId: z.string().describe('The ID of the task to complete'),
    })),
    execute: async ({ taskId }) => {
      const now = new Date().toISOString();
      const outcome = await applySimpleTaskPatch(taskId, {
        status: 'done',
        completedAt: now,
        syncStatus: 'pending_push',
      });
      if (!outcome.success) return { success: false as const, taskId, error: outcome.error };
      return { success: true as const, ...outcome.result, completedAt: now };
    },
  }),

  updateTaskPriority: tool({
    description: 'Update the priority of a task',
    inputSchema: zodSchema(z.object({
      taskId: z.string().describe('The ID of the task'),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).describe('New priority level'),
    })),
    execute: async ({ taskId, priority }) => {
      const outcome = await applySimpleTaskPatch(taskId, {
        priority,
        syncStatus: 'pending_push',
      });
      if (!outcome.success) return { success: false as const, taskId, error: outcome.error };
      return { success: true as const, ...outcome.result, newPriority: priority };
    },
  }),

  getTaskTags: tool({
    description: 'Get tags associated with a task, or list all available tags',
    inputSchema: zodSchema(z.object({
      taskId: z.string().optional().describe('Get tags for a specific task'),
    })),
    execute: async ({ taskId }) => {
      const persistence = await getAIWorkflowPersistence();
      const tags = taskId
        ? await persistence.taskTools.listTaskTags(taskId)
        : await persistence.taskTools.listAllTags();
      return tags.map((t) => ({ id: t.id, name: t.name, type: t.type, color: t.color }));
    },
  }),

  updateTaskEffort: tool({
    description: 'Update the effort level of a task (1=XS, 2=S, 3=M, 4=L, 5=XL). Set to null to clear.',
    inputSchema: zodSchema(z.object({
      taskId: z.string().describe('The ID of the task'),
      effort: z.number().min(1).max(5).nullable().describe('Effort level 1–5 (1=XS/Trivial, 5=XL/Epic), or null to clear'),
    })),
    execute: async ({ taskId, effort }) => {
      const outcome = await applySimpleTaskPatch(taskId, { effort });
      if (!outcome.success) return { success: false, taskId, error: outcome.error };
      return { success: true, taskId, newEffort: effort };
    },
  }),
};
