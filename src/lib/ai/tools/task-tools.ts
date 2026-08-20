import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import db from '@/db';
import { tasks, taskTags, tags } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { countCriticalAndHighTasks } from '@/lib/ai/taskSummary';
import { getLocalToday } from '@/lib/utils/date';

export const taskTools = {
  getTaskSummary: tool({
    description: 'Get a summary of all tasks grouped by status, priority, and source',
    inputSchema: zodSchema(z.object({
      includeOverdueList: z.boolean().optional().describe('Whether to include list of overdue items'),
    })),
    execute: async ({ includeOverdueList }) => {
      const allTasks = await db.select().from(tasks);
      const today = getLocalToday();

      const open = allTasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');
      const overdue = open.filter(t => t.dueDate && t.dueDate < today);
      const critical = countCriticalAndHighTasks(open);
      const bySource = open.reduce((acc, t) => {
        acc[t.connectorType] = (acc[t.connectorType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      return {
        total: allTasks.length,
        open: open.length,
        overdue: overdue.length,
        critical,
        done: allTasks.filter(t => t.status === 'done').length,
        bySource,
        overdueItems: includeOverdueList !== false ? overdue.slice(0, 10).map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          microStatus: t.microStatus,
          dueDate: t.dueDate,
          priority: t.priority,
          source: t.connectorType,
        })) : undefined,
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
      let results = await db.select().from(tasks).orderBy(desc(tasks.updatedAt)).limit(50);

      if (status) results = results.filter(t => t.status === status);
      if (priority) results = results.filter(t => t.priority === priority);
      if (source) results = results.filter(t => t.connectorType === source);
      if (query) {
        const q = query.toLowerCase();
        results = results.filter(t =>
          t.title.toLowerCase().includes(q) ||
          (t.description && t.description.toLowerCase().includes(q))
        );
      }

      return results.slice(0, limit || 15).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        microStatus: t.microStatus,
        priority: t.priority,
        dueDate: t.dueDate,
        source: t.connectorType,
        sourceList: t.sourceListName,
        description: t.description?.slice(0, 100),
      }));
    },
  }),

  completeTask: tool({
    description: 'Mark a task as done/completed',
    inputSchema: zodSchema(z.object({
      taskId: z.string().describe('The ID of the task to complete'),
    })),
    execute: async ({ taskId }) => {
      const now = new Date().toISOString();
      const [updated] = await db.update(tasks).set({
        status: 'done',
        completedAt: now,
        updatedAt: now,
        syncStatus: 'pending_push',
      }).where(eq(tasks.id, taskId)).returning({
        taskId: tasks.id,
        title: tasks.title,
        status: tasks.status,
        microStatus: tasks.microStatus,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        source: tasks.connectorType,
        sourceList: tasks.sourceListName,
      });
      if (!updated) return { success: false as const, taskId, error: 'Task not found.' };
      return { success: true as const, ...updated, completedAt: now };
    },
  }),

  updateTaskPriority: tool({
    description: 'Update the priority of a task',
    inputSchema: zodSchema(z.object({
      taskId: z.string().describe('The ID of the task'),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).describe('New priority level'),
    })),
    execute: async ({ taskId, priority }) => {
      const [updated] = await db.update(tasks).set({
        priority,
        updatedAt: new Date().toISOString(),
        syncStatus: 'pending_push',
      }).where(eq(tasks.id, taskId)).returning({
        taskId: tasks.id,
        title: tasks.title,
        status: tasks.status,
        microStatus: tasks.microStatus,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        source: tasks.connectorType,
        sourceList: tasks.sourceListName,
      });
      if (!updated) return { success: false as const, taskId, error: 'Task not found.' };
      return { success: true as const, ...updated, newPriority: priority };
    },
  }),

  getTaskTags: tool({
    description: 'Get tags associated with a task, or list all available tags',
    inputSchema: zodSchema(z.object({
      taskId: z.string().optional().describe('Get tags for a specific task'),
    })),
    execute: async ({ taskId }) => {
      if (taskId) {
        const result = await db.select({ tag: tags })
          .from(taskTags)
          .innerJoin(tags, eq(taskTags.tagId, tags.id))
          .where(eq(taskTags.taskId, taskId));
        return result.map(r => ({ id: r.tag.id, name: r.tag.name, type: r.tag.type, color: r.tag.color }));
      }
      const allTags = await db.select().from(tags);
      return allTags.map(t => ({ id: t.id, name: t.name, type: t.type, color: t.color }));
    },
  }),

  updateTaskEffort: tool({
    description: 'Update the effort level of a task (1=XS, 2=S, 3=M, 4=L, 5=XL). Set to null to clear.',
    inputSchema: zodSchema(z.object({
      taskId: z.string().describe('The ID of the task'),
      effort: z.number().min(1).max(5).nullable().describe('Effort level 1–5 (1=XS/Trivial, 5=XL/Epic), or null to clear'),
    })),
    execute: async ({ taskId, effort }) => {
      await db.update(tasks).set({
        effort,
        updatedAt: new Date().toISOString(),
      }).where(eq(tasks.id, taskId));
      return { success: true, taskId, newEffort: effort };
    },
  }),
};
