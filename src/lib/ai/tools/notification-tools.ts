import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import db from '@/db';
import { notifications, notificationActions } from '@/db/schema';
import { eq, desc, and, inArray, asc } from 'drizzle-orm';
import { notificationNeedsAttention } from '@/lib/notifications/lifecycle-sql';

export const notificationTools = {
  getNotifications: tool({
    description: 'Get current notifications, optionally filtered by level or category',
    inputSchema: zodSchema(z.object({
      unreadOnly: z.boolean().optional().default(true),
      level: z.enum(['urgent', 'action_needed', 'heads_up', 'fyi', 'digest']).optional(),
      category: z.string().optional().describe('Filter by category like system, tasks, development, finance, home, social, ai_insights, packages'),
    })),
    execute: async ({ unreadOnly, level, category }) => {
      const conditions = [];
      if (unreadOnly) conditions.push(notificationNeedsAttention());
      if (level) conditions.push(eq(notifications.level, level));
      if (category) conditions.push(eq(notifications.category, category));

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const items = await db.select().from(notifications).where(where).orderBy(desc(notifications.sortAt)).limit(15);

      // Hydrate actions
      const ids = items.map(n => n.id);
      const actions = ids.length > 0
        ? await db.select().from(notificationActions).where(inArray(notificationActions.notificationId, ids)).orderBy(asc(notificationActions.sortOrder))
        : [];

      const actionsByNotification = new Map<string, typeof actions>();
      for (const action of actions) {
        const existing = actionsByNotification.get(action.notificationId) || [];
        existing.push(action);
        actionsByNotification.set(action.notificationId, existing);
      }

      return items.map(n => ({
        id: n.id,
        title: n.title,
        body: n.body,
        level: n.level,
        category: n.category,
        state: n.state,
        readState: n.readState,
        disposition: n.disposition,
        sourceState: n.sourceState,
        syncState: n.syncState,
        isActionable: n.isActionable,
        receivedAt: n.receivedAt,
        source: n.connectorType,
        actions: (actionsByNotification.get(n.id) || []).map(a => ({
          id: a.id,
          type: a.actionType,
          label: a.label,
        })),
      }));
    },
  }),
};

/** @deprecated Use notificationTools */
export const alertTools = notificationTools;
