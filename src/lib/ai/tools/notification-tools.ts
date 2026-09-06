import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';
import { DEFAULT_NOTIFICATION_QUERY } from '@/lib/notifications/query';

export const notificationTools = {
  getNotifications: tool({
    description: 'Get current notifications, optionally filtered by level or category',
    inputSchema: zodSchema(z.object({
      unreadOnly: z.boolean().optional().default(true),
      level: z.enum(['urgent', 'action_needed', 'heads_up', 'fyi', 'digest']).optional(),
      category: z.string().optional().describe('Filter by category like system, tasks, development, finance, home, social, ai_insights, packages'),
    })),
    execute: async ({ unreadOnly, level, category }) => {
      const web = await getNotificationWebPersistence();
      const result = await web.queryNotifications({
        query: {
          ...DEFAULT_NOTIFICATION_QUERY,
          state: unreadOnly ? 'unread' : null,
          level: level ?? null,
          category: category ?? null,
          sort: 'newest',
        },
        limit: 15,
        cursor: null,
      });

      const actionsByNotification = new Map<string, typeof result.actions>();
      for (const action of result.actions) {
        const existing = actionsByNotification.get(action.notificationId) || [];
        existing.push(action);
        actionsByNotification.set(action.notificationId, existing);
      }

      return result.items.map((n) => ({
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
        isActionable: Boolean(n.isActionable),
        receivedAt: n.receivedAt,
        source: n.connectorType,
        actions: (actionsByNotification.get(n.id) || []).map((a) => ({
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
